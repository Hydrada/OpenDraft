// Adapted from this repository's scripts/serve-production.mjs for Electron's CJS main process.
const http = require('node:http');
const { createReadStream } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { realpath, stat } = require('node:fs/promises');
const path = require('node:path');
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MIME = new Map([['.html','text/html; charset=utf-8'],['.js','text/javascript; charset=utf-8'],['.mjs','text/javascript; charset=utf-8'],['.css','text/css; charset=utf-8'],['.wasm','application/wasm'],['.pdf','application/pdf'],['.json','application/json'],['.svg','image/svg+xml'],['.png','image/png'],['.jpg','image/jpeg'],['.woff','font/woff'],['.woff2','font/woff2'],['.bcmap','application/octet-stream']]);

// launchFiles: absolute PDF paths from the command line, each served once at /__launch/<token>.
// onPrint: receives PDF bytes POSTed by the app itself to /__print (desktop vector printing).
async function startHost(rootDirectory, port = 4180, launchFiles = [], { onPrint } = {}) {
  const root = await realpath(rootDirectory);
  await stat(path.join(root,'index.html'));
  const launch = new Map();
  for (const file of launchFiles) {
    try { const info = await stat(file); if (info.isFile() && info.size <= 250 * 1024 * 1024 && /\.pdf$/i.test(file)) launch.set(randomBytes(16).toString('hex'), file); } catch {}
  }
  const inside = target => target === root || target.startsWith(root + path.sep);
  const server = http.createServer(async (request,response) => {
    response.setHeader('Content-Security-Policy',CSP);
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Cache-Control','no-store');
    const fail = (status,message) => {response.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});response.end(request.method==='HEAD'?undefined:message);};
    if (request.headers.host !== `127.0.0.1:${server.address().port}`) {fail(403,'Invalid host');return;}
    if (request.method === 'POST' && (request.url ?? '').split('?')[0] === '/__print' && onPrint) {
      // Only the app's own page may print: other local web pages cannot forge this Origin.
      if (request.headers.origin !== `http://127.0.0.1:${server.address().port}`) {fail(403,'Forbidden origin');return;}
      if ((request.headers['content-type'] ?? '') !== 'application/pdf') {fail(415,'PDF required');return;}
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 250 * 1024 * 1024) {fail(413,'PDF too large');return;} chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {fail(400,'Not a PDF');return;}
      try { await onPrint(bytes); response.writeHead(202,{'Content-Type':'application/json'}); response.end('{"ok":true}'); }
      catch (error) { fail(500, `Printing failed: ${error?.message ?? error}`); }
      return;
    }
    if (request.method === 'GET' && (request.url ?? '') === '/__desktop') {response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({vectorPrint:!!onPrint}));return;}
    if (!['GET','HEAD'].includes(request.method)) {response.setHeader('Allow','GET, HEAD');fail(405,'Method not allowed');return;}
    try {
      const pathname = decodeURIComponent((request.url??'/').split('?')[0]);
      if (pathname === '/__launch/list') {const body=JSON.stringify([...launch].map(([token,file])=>({token,name:path.basename(file)})));response.writeHead(200,{'Content-Type':'application/json'});response.end(request.method==='HEAD'?undefined:body);return;}
      if (pathname.startsWith('/__launch/')) {
        const file = launch.get(pathname.slice('/__launch/'.length));
        if (!file) {fail(404,'Not found');return;}
        if (request.method==='GET') launch.delete(pathname.slice('/__launch/'.length));
        const info = await stat(file);
        response.writeHead(200,{'Content-Type':'application/pdf','Content-Length':info.size});
        if (request.method==='HEAD') {response.end();return;}
        createReadStream(file).on('error',()=>response.destroy()).pipe(response);
        return;
      }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part=>part==='..')) {fail(403,'Forbidden path');return;}
      const target = path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
      if (!inside(target)) {fail(403,'Forbidden path');return;}
      const actual = await realpath(target);
      if (!inside(actual)) {fail(403,'Forbidden path');return;}
      const info = await stat(actual);
      if (!info.isFile()) {fail(404,'Not found');return;}
      response.writeHead(200,{'Content-Type':MIME.get(path.extname(actual).toLowerCase())??'application/octet-stream','Content-Length':info.size});
      if (request.method==='HEAD') {response.end();return;}
      createReadStream(actual).on('error',()=>response.destroy()).pipe(response);
    } catch(error) {
      if (error instanceof URIError) fail(400,'Invalid URL encoding');
      else if (['ENOENT','ENOTDIR'].includes(error?.code)) fail(404,'Not found');
      else fail(500,'Unable to serve asset');
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {origin:`http://127.0.0.1:${server.address().port}`,close:()=>{server.close();server.closeAllConnections();}};
}
module.exports={startHost,CSP};
