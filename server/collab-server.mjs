// OpenDraft self-hosted collaboration server. Node 24+, no third-party dependencies.
// Serves the built app same-origin (strict CSP) plus a JSON API. Put a TLS reverse proxy in front
// for any non-loopback deployment; this process speaks plain HTTP.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile, appendFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOperations, emptyStore, storeState, validateOperations } from '../apps/opendraft/src/collab-sync.ts';
import { validateLayerAssignments, validateMarkupLayers } from '../apps/opendraft/src/markup-layers.ts';
import { validateTakeoff } from '../apps/opendraft/src/takeoff.ts';
import { SHEET_INDEX_LIMITS, validateSheetProposals } from '../apps/opendraft/src/ai-sheet-index.ts';
import { MAX_PRESET_LIBRARY_BYTES, parsePresetLibrary, serializePresetLibrary } from '../apps/opendraft/src/markup-presets.ts';

const scrypt = promisify(scryptCallback);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ROLES = ['viewer', 'editor', 'owner'];
const TOKEN_TTL = 12 * 3600_000, PRESENCE_TTL = 30_000, LOG_LIMIT = 5000, BODY_LIMIT = 20 * 1024 * 1024;
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MIME = new Map([['.html','text/html; charset=utf-8'],['.js','text/javascript; charset=utf-8'],['.mjs','text/javascript; charset=utf-8'],['.css','text/css; charset=utf-8'],['.wasm','application/wasm'],['.json','application/json'],['.svg','image/svg+xml'],['.png','image/png'],['.ico','image/x-icon'],['.woff2','font/woff2'],['.bcmap','application/octet-stream']]);

class HttpError extends Error { constructor(status, message, body) { super(message); this.status = status; this.body = body; } }
const sha256 = value => createHash('sha256').update(value).digest('hex');
const validName = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);

export async function createCollabServer({ dataDir, staticDir, now = () => Date.now(), ai, tsa, ocspHosts = [] } = {}) {
  if (!dataDir) throw new Error('dataDir is required.');
  const dirs = { projects: path.join(dataDir, 'projects'), audit: path.join(dataDir, 'audit'), backups: path.join(dataDir, 'backups') };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  const usersFile = path.join(dataDir, 'users.json');
  const atomicWrite = async (file, value) => { const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value)); await rename(temp, file); };
  const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };

  let users = await readJson(usersFile, { users: {} });
  const sessions = new Map(), failures = new Map(), projects = new Map(), locks = new Map(), streams = new Map(), presence = new Map();
  const projectFile = id => { if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, 'Project not found.'); return path.join(dirs.projects, `${id}.json`); };
  const serial = (key, task) => { const run = (locks.get(key) ?? Promise.resolve()).then(task, task); locks.set(key, run.catch(() => {})); return run; };

  async function hashPassword(password, salt = randomBytes(16).toString('base64')) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new HttpError(400, 'Passwords must be 12 to 1024 characters.');
    return { salt, hash: (await scrypt(password, salt, 32, SCRYPT)).toString('base64') };
  }
  async function addUser(name, password, { admin = false } = {}) {
    if (!validName(name)) throw new HttpError(400, 'User names use 1-64 letters, digits, dot, dash or underscore.');
    return serial('users', async () => {
      if (users.users[name]) throw new HttpError(409, 'User already exists.');
      users = { users: { ...users.users, [name]: { ...(await hashPassword(password)), admin, createdAt: new Date(now()).toISOString() } } };
      await atomicWrite(usersFile, users);
    });
  }
  async function loadProject(id) {
    if (projects.has(id)) return projects.get(id);
    const project = await readJson(projectFile(id), null);
    if (!project) throw new HttpError(404, 'Project not found.');
    projects.set(id, project); return project;
  }
  function role(project, user) { return users.users[user]?.admin ? 'owner' : project.members[user]; }
  function require(project, user, minimum) {
    const actual = role(project, user);
    if (!actual) throw new HttpError(404, 'Project not found.');
    if (ROLES.indexOf(actual) < ROLES.indexOf(minimum)) throw new HttpError(403, `This action requires the ${minimum} role.`);
    return actual;
  }

  // Tamper-evident audit: each record carries the previous record hash.
  async function audit(projectId, user, action, detail = {}) {
    const file = path.join(dirs.audit, `${projectId}.jsonl`);
    const lines = (await readFile(file, 'utf8').catch(() => '')).trimEnd().split('\n').filter(Boolean);
    const previous = lines.length ? JSON.parse(lines.at(-1)).hash : '0'.repeat(64);
    const record = { at: new Date(now()).toISOString(), user, action, detail, previous };
    await appendFile(file, JSON.stringify({ ...record, hash: sha256(JSON.stringify(record)) }) + '\n');
  }
  async function verifyAudit(projectId) {
    const lines = (await readFile(path.join(dirs.audit, `${projectId}.jsonl`), 'utf8').catch(() => '')).trimEnd().split('\n').filter(Boolean);
    let previous = '0'.repeat(64);
    for (const [index, line] of lines.entries()) {
      const { hash, ...record } = JSON.parse(line);
      if (record.previous !== previous || sha256(JSON.stringify(record)) !== hash) return { valid: false, records: lines.length, brokenAt: index };
      previous = hash;
    }
    return { valid: true, records: lines.length };
  }

  function validateState(project, store) {
    const state = storeState(store);
    const layers = validateMarkupLayers(state.layers);
    validateLayerAssignments(state.markups, layers, project.pageCount);
    validateTakeoff(state.takeoff, project.pageCount);
  }
  const publish = (projectId, event, data) => { for (const stream of streams.get(projectId) ?? []) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const presenceList = projectId => { const map = presence.get(projectId) ?? new Map(); for (const [key, value] of map) if (now() - value.at > PRESENCE_TTL) map.delete(key); return [...map.values()].map(({ user, page, client }) => ({ user, page, client })); };

  async function createProject(user, body) {
    if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 200 || !/^[a-f0-9]{64}$/.test(body.documentSha256 ?? '') || !Number.isInteger(body.pageCount) || body.pageCount < 1 || body.pageCount > 100_000)
      throw new HttpError(400, 'Projects need a name, the document SHA-256 and page count.');
    const id = randomUUID();
    const project = { id, name: body.name.trim(), documentSha256: body.documentSha256, pageCount: body.pageCount, createdAt: new Date(now()).toISOString(), members: { [user]: 'owner' }, version: 0, seq: 0, store: emptyStore(), log: [], batchIds: {} };
    await atomicWrite(projectFile(id), project); projects.set(id, project);
    await audit(id, user, 'project.create', { name: project.name, documentSha256: project.documentSha256, pageCount: project.pageCount });
    return meta(project, user);
  }
  const meta = (project, user) => ({ id: project.id, name: project.name, documentSha256: project.documentSha256, pageCount: project.pageCount, role: role(project, user), version: project.version });

  async function submitBatch(projectId, user, body) {
    return serial(projectId, async () => {
      const project = await loadProject(projectId);
      require(project, user, 'editor');
      if (typeof body?.batchId !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(body.batchId)) throw new HttpError(400, 'A client batch id is required.');
      // Idempotent retries after reconnect: replaying a batch never applies it twice.
      if (project.batchIds[body.batchId] !== undefined) return { status: 'applied', version: project.batchIds[body.batchId], duplicate: true };
      let ops;
      try { ops = validateOperations(body.ops); } catch (error) { throw new HttpError(400, error.message); }
      let seq = project.seq;
      const result = applyOperations(project.store, ops, () => ++seq);
      if (result.conflicts.length) { await audit(projectId, user, 'batch.conflict', { batchId: body.batchId, conflicts: result.conflicts.map(({ c, id }) => ({ c, id })) }); return { status: 'conflict', conflicts: result.conflicts, version: project.version }; }
      try { validateState(project, result.store); } catch (error) { throw new HttpError(422, `Rejected invalid shared state: ${error.message}`); }
      const version = project.version + 1;
      const changes = ops.map(op => ({ c: op.c, id: op.id, entry: result.store[op.c][op.id] ?? null }));
      const next = { ...project, store: result.store, seq, version, log: [...project.log, { version, batchId: body.batchId, user, at: new Date(now()).toISOString(), changes }].slice(-LOG_LIMIT), batchIds: { ...project.batchIds, [body.batchId]: version } };
      const ids = Object.keys(next.batchIds); if (ids.length > LOG_LIMIT * 2) for (const id of ids.slice(0, ids.length - LOG_LIMIT * 2)) delete next.batchIds[id];
      await atomicWrite(projectFile(projectId), next); projects.set(projectId, next);
      await audit(projectId, user, 'batch.apply', { batchId: body.batchId, version, changes: changes.map(({ c, id, entry }) => ({ c, id, v: entry?.v ?? null })) });
      publish(projectId, 'change', { version, batchId: body.batchId, user, changes });
      return { status: 'applied', version, changes };
    });
  }

  async function backup(projectId, user = 'system') {
    return serial(projectId, async () => {
      const project = await loadProject(projectId);
      const dir = path.join(dirs.backups, projectId); await mkdir(dir, { recursive: true });
      const name = `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-v${project.version}.json`;
      const content = JSON.stringify(project);
      await atomicWrite(path.join(dir, name), project);
      await audit(projectId, user, 'backup.create', { name, sha256: sha256(content), version: project.version });
      return { name, version: project.version, sha256: sha256(content) };
    });
  }
  async function restore(projectId, name, user = 'system') {
    if (!/^[A-Za-z0-9-]+-v\d+\.json$/.test(name)) throw new HttpError(400, 'Invalid backup name.');
    return serial(projectId, async () => {
      const current = await loadProject(projectId);
      const saved = JSON.parse(await readFile(path.join(dirs.backups, projectId, name), 'utf8'));
      if (saved.id !== projectId) throw new HttpError(400, 'Backup belongs to another project.');
      validateState(saved, saved.store);
      // Restoring is a new forward version so connected clients resynchronize instead of diverging.
      const restored = { ...saved, version: current.version + 1, log: [], batchIds: {} };
      await atomicWrite(projectFile(projectId), restored); projects.set(projectId, restored);
      await audit(projectId, user, 'backup.restore', { name, fromVersion: saved.version, version: restored.version });
      publish(projectId, 'reset', { version: restored.version });
      return { version: restored.version };
    });
  }

  // Optional model engine (Ollama-compatible /api/generate). Off unless configured; output is
  // validated like any untrusted input and returned as proposals only.
  async function modelSheetIndex(body) {
    if (!ai?.url) throw new HttpError(404, 'No model engine is configured on this server.');
    const pages = body?.pages, pageCount = body?.pageCount;
    if (!Array.isArray(pages) || pages.length > SHEET_INDEX_LIMITS.pages || !Number.isInteger(pageCount) || pageCount < 1 || pages.some(page => !Number.isInteger(page?.pageIndex) || typeof page.text !== 'string'))
      throw new HttpError(400, 'Send pages as [{pageIndex, text}] with the document page count.');
    const prompt = 'You index construction drawing sets. For each page, find the sheet number and sheet title from its text. ' +
      'Reply with JSON only: {"sheets":[{"pageIndex":0,"number":"A101","title":"FIRST FLOOR PLAN","confidence":"high|medium|low","evidence":"exact text you used"}]}. ' +
      'Omit pages you cannot identify. Pages:\n' + JSON.stringify(pages.map(page => ({ pageIndex: page.pageIndex, text: page.text.slice(0, 4000) })));
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ai.timeoutMs ?? 120_000);
    try {
      const response = await (ai.fetch ?? fetch)(new URL('/api/generate', ai.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: ai.model, prompt, stream: false, format: 'json', options: { temperature: 0 } }), signal: controller.signal });
      if (!response.ok) throw new HttpError(502, `Model engine returned ${response.status}.`);
      const data = await response.json();
      let parsed; try { parsed = JSON.parse(data.response); } catch { throw new HttpError(502, 'Model engine returned invalid JSON.'); }
      try { return { model: ai.model, sheets: validateSheetProposals(parsed, pageCount, 'model') }; } catch (error) { throw new HttpError(502, `Model output rejected: ${error.message}`); }
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, 'Model engine is unavailable.'); }
    finally { clearTimeout(timer); }
  }

  async function authenticate(request) {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = token && sessions.get(sha256(token));
    if (!session || session.expires < now() || !users.users[session.user] || users.users[session.user].disabled) throw new HttpError(401, 'Sign in required.');
    return session.user;
  }
  async function login(body) {
    const name = body?.username, key = String(name);
    const fail = failures.get(key) ?? { count: 0, at: now() };
    if (fail.count >= 5 && now() - fail.at < 60_000) throw new HttpError(429, 'Too many failed sign-in attempts. Wait one minute.');
    const record = validName(name) ? users.users[name] : undefined;
    const attempt = await hashPassword(typeof body?.password === 'string' && body.password.length >= 12 ? body.password : 'x'.repeat(12), record?.salt);
    if (!record || record.disabled || !timingSafeEqual(Buffer.from(attempt.hash, 'base64'), Buffer.from(record.hash, 'base64'))) {
      failures.set(key, { count: (now() - fail.at < 60_000 ? fail.count : 0) + 1, at: now() });
      throw new HttpError(401, 'Invalid user name or password.');
    }
    failures.delete(key);
    const token = randomBytes(32).toString('base64url');
    sessions.set(sha256(token), { user: name, expires: now() + TOKEN_TTL });
    return { token, user: name, admin: !!record.admin, expiresAt: new Date(now() + TOKEN_TTL).toISOString() };
  }
  async function readBody(request) {
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON body required.');
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > BODY_LIMIT) throw new HttpError(413, 'Request body too large.'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  }

  async function api(request, response, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1), method = request.method;
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
    if (parts[0] === 'health' && method === 'GET') return send(200, { ok: true });
    if (parts[0] === 'session' && method === 'POST') return send(200, await login(await readBody(request)));
    const user = await authenticate(request);
    if (parts[0] === 'session' && method === 'DELETE') { sessions.delete(sha256(request.headers.authorization.slice(7))); return send(200, { ok: true }); }
    // Team tool set: one shared markup preset library. Everyone signed in reads it; administrators publish.
    if (parts[0] === 'toolset' && method === 'GET') {
      const stored = JSON.parse(await readFile(path.join(dataDir, 'toolset.json'), 'utf8').catch(() => 'null'));
      return send(200, stored ?? { library: serializePresetLibrary([]), updatedBy: null, updatedAt: null });
    }
    if (parts[0] === 'toolset' && method === 'PUT') {
      if (!users.users[user].admin) throw new HttpError(403, 'Only administrators can publish the team tool set.');
      const body = await readBody(request);
      if (typeof body?.library !== 'string' || body.library.length > MAX_PRESET_LIBRARY_BYTES) throw new HttpError(400, 'Send the preset library as text of at most 1 MiB.');
      let presets; try { presets = parsePresetLibrary(body.library); } catch (error) { throw new HttpError(400, `Invalid preset library: ${error.message}`); }
      const stored = { library: serializePresetLibrary(presets), updatedBy: user, updatedAt: new Date(now()).toISOString() };
      await atomicWrite(path.join(dataDir, 'toolset.json'), stored);
      await audit('toolset', user, 'toolset.publish', { presets: presets.length });
      return send(200, stored);
    }
    // OCSP revocation checks, relayed only to responder hosts the administrator allows (no open proxy).
    if (parts[0] === 'ocsp' && method === 'GET') return send(200, { available: ocspHosts.length > 0 });
    if (parts[0] === 'ocsp' && method === 'POST') {
      const body = await readBody(request);
      let target; try { target = new URL(String(body?.url ?? '')); } catch { throw new HttpError(400, 'Send the responder URL from the certificate.'); }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new HttpError(400, 'Only plain http(s) responder URLs are accepted.');
      if (!ocspHosts.includes(target.host.toLowerCase())) throw new HttpError(403, `OCSP responder ${target.host} is not on this server's allow list (OPENDRAFT_OCSP_HOSTS).`);
      const query = typeof body?.request === 'string' && body.request.length <= 8192 ? Buffer.from(body.request, 'base64') : null;
      if (!query?.length || query[0] !== 0x30) throw new HttpError(400, 'Send a DER OCSPRequest as base64.');
      let reply;
      try { reply = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/ocsp-request' }, body: query, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
      catch { throw new HttpError(502, 'The OCSP responder could not be reached.'); }
      const type = reply.headers.get('content-type') ?? '', bytes = Buffer.from(await reply.arrayBuffer());
      if (!reply.ok || !type.toLowerCase().startsWith('application/ocsp-response') || bytes.length > 65_536 || bytes[0] !== 0x30) throw new HttpError(502, 'The OCSP responder returned an invalid reply.');
      return send(200, { response: bytes.toString('base64') });
    }
    // RFC 3161 timestamps for signatures: relayed to the one TSA the administrator configured.
    if (parts[0] === 'timestamp' && method === 'GET') return send(200, { available: !!tsa?.url });
    if (parts[0] === 'timestamp' && method === 'POST') {
      if (!tsa?.url) throw new HttpError(503, 'No timestamp authority is configured on this server (OPENDRAFT_TSA_URL).');
      const body = await readBody(request);
      const query = typeof body?.request === 'string' && body.request.length <= 8192 ? Buffer.from(body.request, 'base64') : null;
      if (!query?.length || query[0] !== 0x30) throw new HttpError(400, 'Send a DER TimeStampReq as base64.');
      let reply;
      try { reply = await fetch(tsa.url, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: query, signal: AbortSignal.timeout(15_000) }); }
      catch { throw new HttpError(502, 'The timestamp authority could not be reached.'); }
      const type = reply.headers.get('content-type') ?? '', bytes = Buffer.from(await reply.arrayBuffer());
      if (!reply.ok || !type.startsWith('application/timestamp-reply') || bytes.length > 65_536 || bytes[0] !== 0x30) throw new HttpError(502, 'The timestamp authority returned an invalid reply.');
      return send(200, { response: bytes.toString('base64') });
    }
    if (parts[0] === 'ai' && parts[1] === 'status' && method === 'GET') return send(200, { available: !!ai?.url, model: ai?.url ? ai.model : null });
    if (parts[0] === 'ai' && parts[1] === 'sheet-index' && method === 'POST') return send(200, await modelSheetIndex(await readBody(request)));
    if (parts[0] === 'users' && method === 'POST') { if (!users.users[user].admin) throw new HttpError(403, 'Only administrators can add users.'); const body = await readBody(request); await addUser(body?.username, body?.password, { admin: body?.admin === true }); return send(201, { username: body.username }); }
    if (parts[0] !== 'projects') throw new HttpError(404, 'Not found.');
    if (parts.length === 1 && method === 'GET') {
      const list = [];
      for (const file of await readdir(dirs.projects)) if (file.endsWith('.json')) { const project = await loadProject(file.slice(0, -5)); if (role(project, user)) list.push(meta(project, user)); }
      return send(200, { projects: list });
    }
    if (parts.length === 1 && method === 'POST') return send(201, await createProject(user, await readBody(request)));
    const projectId = parts[1], project = await loadProject(projectId), action = parts[2];
    if (!action && method === 'GET') { require(project, user, 'viewer'); return send(200, { ...meta(project, user), store: project.store, members: project.members }); }
    if (action === 'changes' && method === 'GET') {
      require(project, user, 'viewer');
      const since = Number(url.searchParams.get('since'));
      if (!Number.isInteger(since) || since < 0 || since > project.version) throw new HttpError(400, 'Invalid version.');
      if (since < project.version && (!project.log.length || project.log[0].version > since + 1)) throw new HttpError(410, 'Changes are no longer retained. Reload the project snapshot.');
      return send(200, { version: project.version, batches: project.log.filter(batch => batch.version > since) });
    }
    if (action === 'batches' && method === 'POST') { const result = await submitBatch(projectId, user, await readBody(request)); return send(result.status === 'conflict' ? 409 : 200, result); }
    if (action === 'members' && method === 'PUT') {
      require(project, user, 'owner'); const body = await readBody(request);
      if (!validName(body?.username) || !users.users[body.username] || !(body.role === null || ROLES.includes(body.role))) throw new HttpError(400, 'Choose an existing user and a role (viewer, editor, owner) or null to remove.');
      return send(200, await serial(projectId, async () => {
        const current = await loadProject(projectId), members = { ...current.members };
        if (body.role === null) delete members[body.username]; else members[body.username] = body.role;
        if (!Object.values(members).includes('owner')) throw new HttpError(400, 'A project must keep at least one owner.');
        const next = { ...current, members }; await atomicWrite(projectFile(projectId), next); projects.set(projectId, next);
        await audit(projectId, user, 'member.set', { username: body.username, role: body.role });
        return { members };
      }));
    }
    if (action === 'presence' && method === 'POST') {
      require(project, user, 'viewer'); const body = await readBody(request);
      if (!Number.isInteger(body?.page) || body.page < 1 || body.page > project.pageCount || typeof body.client !== 'string' || body.client.length > 80) throw new HttpError(400, 'Invalid presence.');
      const map = presence.get(projectId) ?? new Map(); presence.set(projectId, map);
      map.set(`${user}\u0000${body.client}`, { user, page: body.page, client: body.client, at: now() });
      publish(projectId, 'presence', presenceList(projectId)); return send(200, { presence: presenceList(projectId) });
    }
    if (action === 'events' && method === 'GET') {
      require(project, user, 'viewer');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      response.write(`event: hello\ndata: ${JSON.stringify({ version: project.version, presence: presenceList(projectId) })}\n\n`);
      const set = streams.get(projectId) ?? new Set(); streams.set(projectId, set); set.add(response);
      const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15_000);
      request.on('close', () => { clearInterval(heartbeat); set.delete(response); });
      return;
    }
    if (action === 'audit' && method === 'GET') {
      require(project, user, 'owner');
      const lines = (await readFile(path.join(dirs.audit, `${projectId}.jsonl`), 'utf8').catch(() => '')).trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
      return send(200, { verification: await verifyAudit(projectId), records: lines.slice(-1000) });
    }
    if (action === 'backups' && method === 'POST') { require(project, user, 'owner'); return send(201, await backup(projectId, user)); }
    if (action === 'backups' && method === 'GET') { require(project, user, 'owner'); return send(200, { backups: (await readdir(path.join(dirs.backups, projectId)).catch(() => [])).filter(name => name.endsWith('.json')).sort() }); }
    if (action === 'restore' && method === 'POST') { require(project, user, 'owner'); return send(200, await restore(projectId, (await readBody(request))?.name, user)); }
    throw new HttpError(404, 'Not found.');
  }

  const root = staticDir ? await realpath(staticDir) : undefined;
  async function serveStatic(request, response, url) {
    if (!root) throw new HttpError(404, 'Not found.');
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) throw new HttpError(403, 'Forbidden path.');
    const actual = await realpath(path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))).catch(() => { throw new HttpError(404, 'Not found.'); });
    if (actual !== root && !actual.startsWith(root + path.sep)) throw new HttpError(403, 'Forbidden path.');
    const info = await stat(actual); if (!info.isFile()) throw new HttpError(404, 'Not found.');
    response.writeHead(200, { 'Content-Type': MIME.get(path.extname(actual).toLowerCase()) ?? 'application/octet-stream', 'Content-Length': info.size });
    if (request.method === 'HEAD') return response.end();
    createReadStream(actual).on('error', () => response.destroy()).pipe(response);
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', CSP); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) await api(request, response, url); else await serveStatic(request, response, url);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) console.error(error);
      if (!response.headersSent) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ error: status === 500 ? 'Internal server error.' : error.message })); }
      else response.destroy();
    }
  });
  const close = () => new Promise(resolve => { for (const set of streams.values()) for (const stream of set) stream.end(); server.close(() => resolve()); server.closeAllConnections(); });
  return { server, addUser, backup, restore, verifyAudit, close };
}

// CLI: serve | user-add <name> [--admin] (password from OPENDRAFT_PASSWORD) | backup <id> | restore <id> <name> | verify-audit <id>
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [command = 'serve', ...args] = process.argv.slice(2);
  const dataDir = path.resolve(process.env.OPENDRAFT_DATA ?? 'opendraft-data');
  const staticDir = fileURLToPath(new URL('../apps/opendraft/dist/', import.meta.url));
  const ai = process.env.OPENDRAFT_AI_URL ? { url: process.env.OPENDRAFT_AI_URL, model: process.env.OPENDRAFT_AI_MODEL ?? 'llama3.2' } : undefined;
  const tsa = process.env.OPENDRAFT_TSA_URL ? { url: process.env.OPENDRAFT_TSA_URL } : undefined;
  const ocspHosts = (process.env.OPENDRAFT_OCSP_HOSTS ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  const app = await createCollabServer({ dataDir, staticDir: command === 'serve' ? staticDir : undefined, ai, tsa, ocspHosts });
  if (command === 'serve') {
    const port = Number(process.env.PORT ?? 4180), host = process.env.HOST ?? '127.0.0.1';
    app.server.listen(port, host, () => console.log(`OpenDraft collaboration server: http://${host}:${port} (data: ${dataDir})`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void app.close());
  } else {
    try {
      if (command === 'user-add') { if (!process.env.OPENDRAFT_PASSWORD) throw new Error('Set OPENDRAFT_PASSWORD.'); await app.addUser(args[0], process.env.OPENDRAFT_PASSWORD, { admin: args.includes('--admin') }); console.log(`Added ${args[0]}`); }
      else if (command === 'backup') console.log(JSON.stringify(await app.backup(args[0])));
      else if (command === 'restore') console.log(JSON.stringify(await app.restore(args[0], args[1])));
      else if (command === 'verify-audit') { const result = await app.verifyAudit(args[0]); console.log(JSON.stringify(result)); if (!result.valid) process.exitCode = 2; }
      else throw new Error(`Unknown command ${command}.`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    await app.close();
  }
}
