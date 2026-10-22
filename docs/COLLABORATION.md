# Self-hosted collaboration (M5)

Implemented 2026-10-21. Server: `server/collab-server.mjs` (Node 24+, no third-party dependencies beyond the app's own runtime packages). Client: `apps/opendraft/src/collab-client.ts`, panel `collab-ui.ts`. Shared model and conflict rules: `collab-sync.ts`, used verbatim by server and client.

## Model

- A **project** is bound to one exact source PDF (SHA-256 of the single source file + page count). Joining with any other file is refused. Collaborators each open their own copy; the server never stores PDFs.
- Shared collections: markups, annotation layers, calibration scales and measurement records. Page organization is not shared and is blocked while joined, so page indexes cannot diverge. Slip-sheet/revision journal state remains local.
- Each item has a server version. A client sends one **batch** at a time containing every changed item with the version it was based on. The server applies the batch all-or-nothing only if every base version matches, then validates the whole resulting state with the app's own validators (`validateMarkupLayers`, `validateLayerAssignments`, `validateTakeoff`). Invalid shared state is rejected (422).
- Concurrent edits to different items merge. Concurrent edits to the same item produce a **conflict**: the server value is shown, the local value is kept aside, and the reviewer explicitly chooses *Keep mine* or *Use server*. Nothing is silently overwritten.
- Item order is creation sequence, so z-order converges for every client.
- Batch ids make retries idempotent: a batch whose response was lost is never applied twice.
- Remote changes enter the local undo history as ordinary edits; undoing one is a new shared edit.

## Offline and reconnect

Unsent work (confirmed shadow + local state) is stored per user/project in browser local storage whenever it differs from the server. When the network or server is unavailable the client retries with exponential backoff up to 30 s. On reconnect it pulls missed changes, rebases local intent and sends the remainder; conflicting items are held for review. Reloading the page and signing in again restores and rebases saved work. Session tokens are kept in memory only, never stored.

## Security

- Accounts: scrypt (N=32768, r=8, p=1) salted hashes; minimum 12-character passwords; constant-time comparison; 5 failed sign-ins per user per minute, then 429.
- Bearer tokens (256-bit random, stored server-side as SHA-256, 12 h expiry). No cookies, so no CSRF surface; the API is same-origin with the app and the strict CSP (`connect-src 'self'`) is unchanged.
- Roles per project: viewer (read, presence), editor (+ edit), owner (+ membership, audit, backups, restore). Server administrators act as owners. A project always keeps at least one owner. Viewers' edits are refused locally and by the server.
- 20 MB request limit, bounded batch size (20,000 operations), JSON content-type required, security headers and path checks for static files.
- Plain HTTP only: deploy behind a TLS reverse proxy for anything beyond loopback (see SELF_HOSTING).

## Audit, backups, recovery

- Every project creation, applied batch, conflict, membership change, backup and restore is appended to `audit/<project>.jsonl` with a SHA-256 hash chain; `GET /api/projects/:id/audit` (owner) and `node server/collab-server.mjs verify-audit <id>` report whether the chain is intact and where it breaks.
- Project files are written atomically (temp file + rename).
- Backups: `POST /api/projects/:id/backups` (owner) or `node server/collab-server.mjs backup <id>`; restore with `POST /api/projects/:id/restore {name}` or the `restore` CLI. Restore validates the backup and becomes a new forward version; connected clients resynchronize.
- The server retains the last 5,000 batches for incremental sync; older clients reload the snapshot (HTTP 410) and rebase.

## Presence

Joined clients report their page every 10 s; entries expire after 30 s and are broadcast over the event stream.

## Evidence

See TEST_RESULTS: server integration (merge, conflict, idempotent retry, RBAC, invalid state, SSE, presence, backup/restore, audit tamper detection, rate limiting, no plaintext passwords), client integration against the real server (live convergence, offline queue, reconnect conflict and explicit resolution, reload/rejoin rebase) and browser end-to-end with three users and network-offline emulation.

## Limitations

Single server process (no clustering/replication); in-memory sessions are lost on restart (users sign in again; unsent work survives on devices). No password reset/SSO; users are added by an administrator or CLI. Desktop (Electron) builds do not include the collaboration panel connection because the desktop host is a local loopback origin; use the self-hosted web app. Revision journal, page organization and comparison workflows are not shared.
