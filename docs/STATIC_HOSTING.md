# Built browser application hosting

OpenDraft's browser build processes selected PDFs locally. A static host serves application assets; it is not the future collaboration backend.

```powershell
npm ci
npm run build
node scripts/serve-production.mjs
```

The reference host binds **127.0.0.1:4178** only (override PORT to change the port). Stop it with Ctrl+C. It serves apps/opendraft/dist, supports GET/HEAD only, rejects path traversal and symlinks leaving that directory, returns 404 for missing assets, and sends MIME types and security headers. It uses no cloud account or upload endpoint. This reference server is for local verification, not an internet-facing production service.

For a self-host deployment, serve the contents of apps/opendraft/dist at the origin root through a maintained static server. Use HTTPS for remote access, keep directory listing disabled, and configure equivalent headers:

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

The HTTP CSP further restricts the development-compatible HTML meta policy; it does not allow websocket connections. Ensure .mjs/.js are JavaScript and .wasm is application/wasm. Do not route missing JavaScript/worker assets to index.html. Do not inject external scripts or analytics. PDF worker assets must remain same-origin. Browser storage belongs to the deployment origin; changing host/port changes access to saved recovery data.

Verification: after `npm run build`, run `npx playwright test tests/e2e/production.spec.ts`. The spec starts/stops the separate built-asset reference host. The existing Playwright configuration may also start its ordinary Vite server; the production tests navigate explicitly to port 4178 and never use Vite assets. Tests cover nonblank render, text search, local worker, runtime request origins/methods, CSP/headers, HEAD, missing assets, method rejection and encoded traversal.

This test corpus does not certify hostile PDF safety, offline installation, internet hosting, authentication, browser compatibility, full font support or professional PDF interoperability. Production deployment and release gates remain open.
