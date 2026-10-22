import { CollabSession, type CollabHost, type ProjectMeta } from './collab-client';

export type CollabBinding = { documentSha256: string; pageCount: number; name: string };
type Options = { host: CollabHost; binding: () => Promise<CollabBinding>; joined: (session: CollabSession | undefined) => void; presets?: { library: () => string; merge: (text: string) => number }; error: (message: string) => void };

/** Collaboration panel. Hidden behind an explicit check that a same-origin server exists. */
export async function mountCollaboration(container: HTMLElement, options: Options) {
  container.innerHTML = '<h3>Collaboration</h3>';
  const note = document.createElement('p'); container.append(note);
  const health = await fetch('/api/health', { cache: 'no-store' }).then(response => response.ok, () => false);
  if (!health) { note.textContent = 'Collaboration requires the OpenDraft self-hosted server. Files stay local in this mode.'; return; }
  note.textContent = 'Shared markups, layers, scales and measurements sync through this server. Each project is bound to one exact PDF; open that file before joining. Page organization is disabled while joined.';
  const session = new CollabSession({ ...options.host, changed: () => { render(); options.host.changed(); } });
  const input = (label: string, type = 'text') => { const row = document.createElement('label'); row.textContent = label; const field = document.createElement('input'); field.type = type; field.setAttribute('aria-label', label); row.append(field); container.append(row); return field; };
  const button = (label: string, run: () => Promise<string | void>) => { const item = document.createElement('button'); item.textContent = label; item.onclick = async () => { item.disabled = true; let message: string | void = undefined; try { message = await run(); } catch (error) { message = error instanceof Error ? error.message : String(error); options.error(message); } finally { item.disabled = false; render(); if (message) status.textContent = message; } }; container.append(item); return item; };
  const user = input('Collaboration user name'), password = input('Collaboration password', 'password');
  button('Sign in to collaboration', async () => { await session.signIn(user.value.trim(), password.value); password.value = ''; await refreshProjects(); });
  const projectRow = document.createElement('label'); projectRow.textContent = 'Collaboration project';
  const projectSelect = document.createElement('select'); projectSelect.setAttribute('aria-label', 'Collaboration project'); projectRow.append(projectSelect); container.append(projectRow);
  let projects: ProjectMeta[] = [];
  const refreshProjects = async () => { projects = await session.listProjects(); projectSelect.replaceChildren(...projects.map(project => { const option = document.createElement('option'); option.value = project.id; option.textContent = `${project.name} (${project.role})`; return option; })); };
  button('Join collaboration project', async () => {
    const binding = await options.binding();
    await session.join(projectSelect.value, binding.documentSha256, binding.pageCount); options.joined(session);
  });
  const projectName = input('New collaboration project name');
  button('Create project for this PDF', async () => {
    const binding = await options.binding();
    const project = await session.createProject(projectName.value.trim() || binding.name, binding.documentSha256, binding.pageCount);
    await refreshProjects(); projectSelect.value = project.id;
    await session.join(project.id, binding.documentSha256, binding.pageCount); options.joined(session);
  });
  button('Load team tool set', async () => {
    if (!options.presets) return;
    const toolset = await session.loadToolSet();
    const count = options.presets.merge(toolset.library);
    return count ? `Loaded ${count} team preset(s)${toolset.updatedBy ? ` published by ${toolset.updatedBy}` : ''}.` : 'The team tool set is empty.';
  });
  button('Publish my presets as the team tool set', async () => {
    if (!options.presets) return;
    await session.publishToolSet(options.presets.library());
    return 'Team tool set published.';
  });
  button('Leave collaboration project', async () => { session.leave(); options.joined(undefined); });
  const member = input('Member user name');
  const roleRow = document.createElement('label'); roleRow.textContent = 'Member role';
  const role = document.createElement('select'); role.setAttribute('aria-label', 'Member role');
  for (const value of ['viewer', 'editor', 'owner', 'remove']) { const option = document.createElement('option'); option.value = value; option.textContent = value; role.append(option); }
  roleRow.append(role); container.append(roleRow);
  button('Set member role', async () => { await session.setMember(member.value.trim(), role.value === 'remove' ? null : role.value); return `Membership updated for ${member.value.trim()}.`; });
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-label', 'Collaboration status'); container.append(status);
  const presence = document.createElement('ul'); presence.setAttribute('aria-label', 'Collaborators present'); container.append(presence);
  const conflicts = document.createElement('div'); conflicts.setAttribute('aria-label', 'Collaboration conflicts'); container.append(conflicts);
  function render() {
    status.textContent = session.project ? `${session.project.name} · ${session.project.role} · ${session.message}` : session.message;
    presence.replaceChildren(...session.presence.map(item => { const entry = document.createElement('li'); entry.textContent = `${item.user} on page ${item.page}`; return entry; }));
    conflicts.replaceChildren(...session.conflicts.map(conflict => {
      const row = document.createElement('div'); row.className = 'conflict';
      const describe = (value: unknown) => value === null || value === undefined ? 'deleted' : String((value as { contents?: unknown; label?: unknown; name?: unknown }).contents ?? (value as { label?: unknown }).label ?? (value as { name?: unknown }).name ?? 'changed');
      row.textContent = `${conflict.c} ${conflict.id}: yours "${describe(conflict.mine)}", server "${describe(conflict.server?.item)}" `;
      for (const [label, choice] of [['Keep mine', 'mine'], ['Use server', 'server']] as const) {
        const action = document.createElement('button'); action.textContent = label; action.setAttribute('aria-label', `${label} for ${conflict.c} ${conflict.id}`);
        action.onclick = () => void session.resolve(conflict.c, conflict.id, choice).catch(error => options.error(String(error)));
        row.append(action);
      }
      return row;
    }));
  }
  render();
  return session;
}
