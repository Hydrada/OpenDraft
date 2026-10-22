import { applyAccepted, diffState, rebaseLocal, storeState, withItem, type Collection, type Entry, type LocalConflict, type SharedState, type Store } from './collab-sync.ts';

export type ProjectMeta = { id: string; name: string; documentSha256: string; pageCount: number; role: 'viewer' | 'editor' | 'owner'; version: number };
export type CollabStatus = 'signed-out' | 'signed-in' | 'synced' | 'pending' | 'offline' | 'conflict';
type Batch = { version: number; batchId: string; user: string; changes: { c: Collection; id: string; entry: Entry | null }[] };
type Saved = { projectId: string; user: string; version: number; shadow: Store; local: SharedState };
export type CollabHost = {
  /** Current local shared state, or undefined when the bound document is not active. */
  local: () => SharedState | undefined;
  /** Install a state produced by remote changes; resolves false if the document was busy. */
  install: (state: SharedState) => Promise<boolean>;
  changed: () => void;
};

const storageKey = (projectId: string, user: string) => `opendraft.collab.v1:${user}:${projectId}`;

/**
 * Same-origin collaboration session. Local edits are diffed against the server-confirmed shadow
 * and sent as one idempotent batch at a time. Unsent work persists in local storage, so it
 * survives offline periods and reloads (re-sign-in required; tokens are never stored).
 */
export class CollabSession {
  token: string | undefined; user: string | undefined; project: ProjectMeta | undefined;
  status: CollabStatus = 'signed-out'; message = ''; conflicts: LocalConflict[] = []; presence: { user: string; page: number; client: string }[] = [];
  private shadow: Store | undefined; private version = 0; private inflight: { batchId: string; ops: unknown[] } | undefined;
  private stream: AbortController | undefined; private retry: ReturnType<typeof setTimeout> | undefined; private delay = 1000; private closed = false;
  readonly client = crypto.randomUUID();

  private host: CollabHost; private base: string; private fetchImpl: typeof fetch; private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  constructor(host: CollabHost, base = '', fetchImpl: typeof fetch = (...args) => fetch(...args), storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage) {
    this.host = host; this.base = base; this.fetchImpl = fetchImpl; this.storage = storage;
  }

  private async call(method: string, route: string, body?: unknown) {
    const response = await this.fetchImpl(`${this.base}/api${route}`, { method, headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  }
  private emit(status: CollabStatus, message: string) { this.status = status; this.message = message; this.host.changed(); }

  async signIn(username: string, password: string) {
    const { status, data } = await this.call('POST', '/session', { username, password });
    if (status !== 200) throw new Error(data.error ?? `Sign-in failed (${status}).`);
    this.token = data.token; this.user = data.user; this.emit('signed-in', `Signed in as ${data.user}.`);
  }
  /** Team tool set (shared markup presets) stored on the server. */
  async loadToolSet(): Promise<{ library: string; updatedBy: string | null; updatedAt: string | null }> {
    const { status, data } = await this.call('GET', '/toolset');
    if (status !== 200) throw new Error(data.error ?? 'Could not load the team tool set.');
    return data;
  }
  async publishToolSet(library: string): Promise<void> {
    const { status, data } = await this.call('PUT', '/toolset', { library });
    if (status !== 200) throw new Error(data.error ?? 'Could not publish the team tool set.');
  }
  async listProjects(): Promise<ProjectMeta[]> {
    const { status, data } = await this.call('GET', '/projects');
    if (status !== 200) throw new Error(data.error ?? 'Could not list projects.');
    return data.projects;
  }
  async createProject(name: string, documentSha256: string, pageCount: number): Promise<ProjectMeta> {
    const { status, data } = await this.call('POST', '/projects', { name, documentSha256, pageCount });
    if (status !== 201) throw new Error(data.error ?? 'Could not create project.');
    return data;
  }
  async setMember(username: string, role: string | null) {
    const { status, data } = await this.call('PUT', `/projects/${this.project!.id}/members`, { username, role });
    if (status !== 200) throw new Error(data.error ?? 'Could not change membership.');
  }

  /** Join a project bound to this exact document. Saved offline work is rebased, never discarded. */
  async join(projectId: string, documentSha256: string, pageCount: number) {
    const { status, data } = await this.call('GET', `/projects/${projectId}`);
    if (status !== 200) throw new Error(data.error ?? 'Could not open project.');
    if (data.documentSha256 !== documentSha256 || data.pageCount !== pageCount) throw new Error('This project is bound to a different PDF. Open the exact source document to join.');
    this.project = { id: data.id, name: data.name, documentSha256: data.documentSha256, pageCount: data.pageCount, role: data.role, version: data.version };
    const savedText = this.storage.getItem(storageKey(projectId, this.user!));
    const saved = savedText ? JSON.parse(savedText) as Saved : undefined;
    const local = saved?.local ?? storeState(data.store);
    const rebased = rebaseLocal(saved?.shadow ?? data.store, data.store, local);
    this.shadow = data.store; this.version = data.version; this.conflicts = rebased.conflicts;
    if (!(await this.host.install(rebased.state))) throw new Error('The document is busy. Try joining again.');
    this.closed = false; this.persist(); void this.listen(); await this.flush();
  }
  leave() {
    this.closed = true; this.stream?.abort(); clearTimeout(this.retry);
    this.project = undefined; this.shadow = undefined; this.conflicts = []; this.presence = [];
    this.emit(this.token ? 'signed-in' : 'signed-out', 'Left the project. Local copy remains open.');
  }
  get readOnly() { return this.project?.role === 'viewer'; }

  private persist() {
    const local = this.host.local();
    if (!this.project || !this.shadow || !local) return;
    const pending = diffState(this.shadow, local).length > 0;
    if (pending || this.conflicts.length) this.storage.setItem(storageKey(this.project.id, this.user!), JSON.stringify({ projectId: this.project.id, user: this.user!, version: this.version, shadow: this.shadow, local } satisfies Saved));
    else this.storage.removeItem(storageKey(this.project.id, this.user!));
  }

  /** Called after every local commit/undo/redo of the bound document. */
  async localChanged() { if (!this.project) return; this.persist(); await this.flush(); }

  async flush(): Promise<void> {
    if (!this.project || !this.shadow || this.inflight || this.closed) return;
    const local = this.host.local(); if (!local) return;
    const ops = diffState(this.shadow, local);
    if (!ops.length) { this.emit(this.conflicts.length ? 'conflict' : 'synced', this.conflicts.length ? `${this.conflicts.length} conflict(s) need review.` : `Synchronized at version ${this.version}.`); return; }
    if (this.readOnly) { this.emit('conflict', 'Viewer role: local changes are not shared.'); return; }
    // Conflicting items stay out of batches until the reviewer resolves them.
    const blocked = new Set(this.conflicts.map(item => `${item.c}:${item.id}`));
    const sendable = ops.filter(op => !blocked.has(`${op.c}:${op.id}`));
    if (!sendable.length) { this.emit('conflict', `${this.conflicts.length} conflict(s) need review.`); return; }
    this.inflight = { batchId: crypto.randomUUID(), ops: sendable };
    this.emit('pending', `Sending ${sendable.length} change(s)…`);
    while (this.inflight && !this.closed) {
      try {
        const { status, data } = await this.call('POST', `/projects/${this.project.id}/batches`, this.inflight);
        if (status === 200) { this.inflight = undefined; this.delay = 1000; if (data.duplicate) await this.pull(); else await this.accept({ version: data.version, batchId: '', user: this.user!, changes: data.changes }, false); }
        else if (status === 409) { this.inflight = undefined; await this.pull(); }
        else if (status === 401) { this.inflight = undefined; this.emit('offline', 'Session expired. Sign in again; unsent changes are kept on this device.'); return; }
        else { this.inflight = undefined; this.emit('conflict', data.error ?? `Server rejected changes (${status}).`); return; }
      } catch {
        this.emit('offline', 'Offline. Changes are kept on this device and will be sent on reconnect.');
        await new Promise(resolve => { this.retry = setTimeout(resolve, this.delay); }); this.delay = Math.min(this.delay * 2, 30_000);
      }
    }
    this.persist();
    await this.flush();
  }

  private async pull() {
    if (!this.project) return;
    const { status, data } = await this.call('GET', `/projects/${this.project.id}/changes?since=${this.version}`);
    if (status === 410) return this.resync();
    if (status !== 200) throw new Error(data.error ?? 'Could not fetch changes.');
    for (const batch of data.batches as Batch[]) await this.accept(batch, true);
  }
  private async resync() {
    const { status, data } = await this.call('GET', `/projects/${this.project!.id}`);
    if (status !== 200) throw new Error(data.error ?? 'Could not reload project.');
    await this.rebase(data.store, data.version);
  }
  private async accept(batch: Batch, remote: boolean) {
    if (!this.shadow || batch.version <= this.version) return;
    if (batch.version !== this.version + 1) return this.pull();
    const next = applyAccepted(this.shadow, batch.changes);
    if (!remote) { this.shadow = next; this.version = batch.version; return; }
    await this.rebase(next, batch.version);
  }
  private async rebase(next: Store, version: number) {
    const local = this.host.local() ?? storeState(this.shadow!);
    const result = rebaseLocal(this.shadow!, next, local);
    const known = new Set(this.conflicts.map(item => `${item.c}:${item.id}`));
    this.conflicts = [...this.conflicts.map(item => ({ ...item, server: next[item.c][item.id] ?? null })), ...result.conflicts.filter(item => !known.has(`${item.c}:${item.id}`))];
    this.shadow = next; this.version = version;
    await this.host.install(result.state);
    this.persist();
  }

  /** Explicit reviewer choice for one conflict. */
  async resolve(c: Collection, id: string, choice: 'mine' | 'server') {
    const conflict = this.conflicts.find(item => item.c === c && item.id === id);
    const local = this.host.local();
    if (!conflict || !local) return;
    this.conflicts = this.conflicts.filter(item => item !== conflict);
    const value = choice === 'mine' ? conflict.mine : conflict.server?.item ?? null;
    if (!(await this.host.install(withItem(local, c, id, value)))) { this.conflicts.push(conflict); throw new Error('The document is busy. Try again.'); }
    await this.localChanged();
  }

  private async listen() {
    while (!this.closed && this.project) {
      const controller = new AbortController(); this.stream = controller;
      try {
        const response = await this.fetchImpl(`${this.base}/api/projects/${this.project.id}/events`, { headers: { Authorization: `Bearer ${this.token}` }, signal: controller.signal });
        if (response.status === 401) { this.emit('offline', 'Session expired. Sign in again; unsent changes are kept on this device.'); return; }
        if (!response.ok || !response.body) throw new Error('stream');
        this.delay = 1000;
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        await this.pull(); await this.flush();
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
            if (!event || !data) continue;
            const payload = JSON.parse(data);
            if (event === 'change') { if (payload.version > this.version && !this.inflight) await this.accept(payload, true); }
            else if (event === 'reset') await this.resync();
            else if (event === 'presence') { this.presence = payload; this.host.changed(); }
            else if (event === 'hello') { this.presence = payload.presence; this.host.changed(); }
          }
        }
      } catch { /* reconnect below */ }
      if (this.closed) return;
      this.emit('offline', 'Connection lost. Reconnecting; local changes are kept on this device.');
      await new Promise(resolve => { this.retry = setTimeout(resolve, this.delay); }); this.delay = Math.min(this.delay * 2, 30_000);
    }
  }
  async reportPresence(page: number) {
    if (!this.project) return;
    await this.call('POST', `/projects/${this.project.id}/presence`, { page, client: this.client }).catch(() => undefined);
  }
}
