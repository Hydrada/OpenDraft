import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal loopback reference host for built assets; not an internet-facing service.
const root = await realpath(fileURLToPath(new URL('../apps/opendraft/dist/', import.meta.url)));
await stat(path.join(root, 'index.html'));
const port = Number(process.env.PORT ?? 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const mime = new Map([['.html','text/html; charset=utf-8'],['.js','text/javascript; charset=utf-8'],['.mjs','text/javascript; charset=utf-8'],['.css','text/css; charset=utf-8'],['.wasm','application/wasm'],['.pdf','application/pdf'],['.json','application/json'],['.svg','image/svg+xml'],['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.ico','image/x-icon'],['.woff','font/woff'],['.woff2','font/woff2'],['.bcmap','application/octet-stream']]);
const insideRoot = target => target === root || target.startsWith(root + path.sep);

const server = http.createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', csp);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  const fail = (status, message) => {
    response.writeHead(status, {'Content-Type':'text/plain; charset=utf-8'});
    response.end(request.method === 'HEAD' ? undefined : message);
  };
  if (!['GET','HEAD'].includes(request.method)) { response.setHeader('Allow','GET, HEAD'); fail(405,'Method not allowed'); return; }
  try {
    const pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part === '..')) { fail(403,'Forbidden path'); return; }
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!insideRoot(target)) { fail(403,'Forbidden path'); return; }
    const actual = await realpath(target);
    if (!insideRoot(actual)) { fail(403,'Forbidden path'); return; }
    const info = await stat(actual);
    if (!info.isFile()) { fail(404,'Not found'); return; }
    response.writeHead(200, {'Content-Type':mime.get(path.extname(actual).toLowerCase()) ?? 'application/octet-stream','Content-Length':info.size});
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(actual).on('error', () => response.destroy()).pipe(response);
  } catch (error) {
    if (error instanceof URIError) fail(400,'Invalid URL encoding');
    else if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') fail(404,'Not found');
    else fail(500,'Unable to serve asset');
  }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`OpenDraft built assets: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
