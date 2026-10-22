# Self-hosting OpenDraft

The self-host archive (`opendraft-selfhost-<version>.zip`) contains the built web app, the collaboration server and the locked runtime dependency list. Requirements: Node.js 24 or newer, about 200 MB of disk plus your data.

## Install and start

```powershell
Expand-Archive opendraft-selfhost-0.1.0.zip -DestinationPath C:\opendraft
cd C:\opendraft\opendraft-selfhost-0.1.0
npm ci --omit=dev --ignore-scripts
$env:OPENDRAFT_DATA = 'C:\opendraft-data'          # project, audit and backup storage
$env:OPENDRAFT_PASSWORD = '<at least 12 characters>'
node server/collab-server.mjs user-add admin --admin
Remove-Item Env:OPENDRAFT_PASSWORD
$env:PORT = '4180'; $env:HOST = '127.0.0.1'
node server/collab-server.mjs serve
```

Open `http://127.0.0.1:4180`. The same command works on Linux/macOS with `export`.

## Network exposure

The server speaks plain HTTP and binds 127.0.0.1 by default. To serve other machines, keep it on loopback and put a TLS reverse proxy (for example Caddy, nginx or IIS ARR) in front; forward `/` unchanged and disable response buffering for `/api/projects/*/events` (server-sent events). Do not set `HOST=0.0.0.0` without TLS.

## Operations

- Add users: sign in as an administrator and `POST /api/users`, or use the `user-add` CLI.
- Backups: `node server/collab-server.mjs backup <projectId>`; files are written under `OPENDRAFT_DATA/backups/<projectId>/`. Back up the whole `OPENDRAFT_DATA` directory with the server stopped for disaster recovery.
- Restore: `node server/collab-server.mjs restore <projectId> <backupName>`.
- Audit check: `node server/collab-server.mjs verify-audit <projectId>` (exit code 2 if the hash chain is broken).
- Upgrade: stop the server, extract the new archive to a new folder, `npm ci --omit=dev --ignore-scripts`, start it with the same `OPENDRAFT_DATA`.

## Verify a download

Compare `SHA256SUMS` with `Get-FileHash -Algorithm SHA256 <file>`. Archives are reproducible: rebuilding the same source with `npm ci`, `npm run build` and `node scripts/release.mjs` yields identical bytes (see TEST_RESULTS).

## Static-only hosting

`opendraft-web-<version>.zip` is the app without collaboration; see STATIC_HOSTING.md.

## Trusted timestamps for signatures (optional)
Set `OPENDRAFT_TSA_URL` to an RFC 3161 timestamp authority (for example your CA's TSA). Signed-in users can then tick "Add a trusted timestamp" when signing; the browser sends only the hash of the signature, and the server relays it to that single URL (15 s timeout, 64 KB reply limit). Without the variable the option reports that no authority is configured.

## Desktop app against this server
Start the desktop app with `--server=https://your-server` (http only for `127.0.0.1`/`localhost`) to collaborate from the desktop; it then loads the app from this server and contacts no other origin.

## Online revocation checks (OCSP, optional)
Set `OPENDRAFT_OCSP_HOSTS` to a comma-separated list of OCSP responder hosts (`host` or `host:port`, as named in your signers' certificates, e.g. `ocsp.yourca.example`). Signed-in users can then tick "Check revocation online"; the server forwards the request only to those hosts (no redirects, 15 s timeout, 64 KB reply limit), so it cannot be used to reach other internal addresses. Responses can be embedded in signed PDFs as long-term validation data.
