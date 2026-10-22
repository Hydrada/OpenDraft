import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// @ts-ignore Shared synthetic Node PDF fixture.
import { drawingFixture } from '../fixture.mjs';

test('hidden sandboxed Windows desktop proof renders a local PDF without privileges or remote navigation', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop proof only; Linux CI has no desktop display.');
  test.setTimeout(45_000);
  const profile=await mkdtemp(path.join(os.tmpdir(),'opendraft-electron-test-'));
  let application: ElectronApplication | undefined;
  try {
    const executablePath=process.env.OPENDRAFT_EXECUTABLE;
    if (executablePath) {
      for (const name of ['THIRD_PARTY_NOTICES.md','pdfjs-dist-LICENSE.txt','pdf-lib-LICENSE.md','pdf-lib-standard-fonts-LICENSE.md','pdf-lib-upng-LICENSE.txt','pako-LICENSE.txt','tslib-LICENSE.txt']) {
        expect((await readFile(path.join(path.dirname(executablePath),'licenses',name),'utf8')).length).toBeGreaterThan(100);
      }
    }
    // T3's Electron-backed host exports this for its Node tools. The child
    // under test must start the real Electron runtime, with the host unchanged.
    const childEnv={...process.env,OPENDRAFT_SMOKE_PROFILE:profile};
    delete (childEnv as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    application=await electron.launch({
      ...(executablePath?{executablePath}:{}),
      args:executablePath?['--smoke-test']:[path.resolve('desktop/main.cjs'),'--smoke-test'],
      env:childEnv,
      timeout:20_000
    });
    const page=await application.firstWindow();
    await page.getByLabel('Open PDF files',{exact:true}).waitFor({state:'attached'});
    const security=await application.evaluate(({BrowserWindow})=>{
      const window=BrowserWindow.getAllWindows()[0];
      const preferences=window.webContents.getLastWebPreferences();
      return {visible:window.isVisible(),focused:window.isFocused(),focusable:window.isFocusable(),nodeIntegration:preferences.nodeIntegration,contextIsolation:preferences.contextIsolation,sandbox:preferences.sandbox,webSecurity:preferences.webSecurity,preload:preferences.preload??null};
    });
    expect(security).toEqual({visible:false,focused:false,focusable:false,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,preload:null});
    expect(await page.evaluate(()=>({require:typeof (globalThis as any).require,process:typeof (globalThis as any).process}))).toEqual({require:'undefined',process:'undefined'});
    const origin=new URL(page.url()).origin;
    const requests: Array<{url:string;method:string}>=[];
    page.context().on('request',request=>requests.push({url:request.url(),method:request.method()}));
    await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'desktop.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
    await expect(page.locator('#status')).toHaveText(/^Page 1 of 2/);
    await expect(page.getByTestId('pdf-canvas')).toBeVisible();
    await page.getByRole('button',{name:'Rotate page clockwise',exact:true}).click();
    await expect.poll(()=>page.getByTestId('pdf-canvas').evaluate((canvas:HTMLCanvasElement)=>canvas.width>canvas.height)).toBe(true);
    // Smoke mode never clicks the native picker/save/print UI.
    await page.evaluate(()=>window.open('https://example.com'));
    expect(application.windows()).toHaveLength(1);
    expect(await page.evaluate(()=>fetch('https://example.com').then(()=>false,()=>true))).toBe(true);
    expect(new URL(page.url()).origin).toBe(origin);
    expect(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    for (const request of requests.filter(request=>!request.url.startsWith('https://example.com'))) {
      expect(new URL(request.url).origin).toBe(origin);
      expect(['GET','HEAD']).toContain(request.method);
    }
  } finally {
    try {await application?.close();}
    finally {await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
  }
});

test('desktop opens PDFs passed on the command line once and applies interface zoom', async () => {
  test.skip(process.platform !== 'win32' || !!process.env.OPENDRAFT_EXECUTABLE, 'Windows source-tree desktop proof only.');
  test.setTimeout(45_000);
  const profile=await mkdtemp(path.join(os.tmpdir(),'opendraft-electron-test-'));
  const file=path.join(profile,'launched plan.pdf');
  await writeFile(file,Buffer.from(await drawingFixture()));
  const childEnv={...process.env,OPENDRAFT_SMOKE_PROFILE:profile};
  delete (childEnv as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const application=await electron.launch({args:[path.resolve('desktop/main.cjs'),'--smoke-test','--ui-zoom=0.5',file,path.join(profile,'missing.pdf'),path.join(profile,'notes.txt')],env:childEnv,timeout:20_000});
  try {
    const page=await application.firstWindow();
    await expect(page.locator('#document-name')).toHaveText('launched plan.pdf',{timeout:20_000});
    await expect(page.locator('#status')).toContainText('Page 1 of 2');
    await expect(page.getByRole('button',{name:/^View /})).toHaveCount(1);
    expect(new URL(page.url()).hash).toBe('');
    expect(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(0.5);
    // Each launch token is single-use and the list exposes names only, never paths.
    const replay=await page.evaluate(async()=>({list:await (await fetch('/__launch/list')).text()}));
    expect(replay.list).not.toContain('opendraft-electron-test-');
    const token=JSON.parse(replay.list)[0]?.token;
    if (token) expect(await page.evaluate(async t=>(await fetch(`/__launch/${t}`)).status,token)).toBe(404);
  } finally { await application.close(); await rm(profile,{recursive:true,force:true}); }
});

test('desktop connects to a self-hosted collaboration server with --server and contacts only that origin', async () => {
  test.skip(process.platform !== 'win32' || !!process.env.OPENDRAFT_EXECUTABLE, 'Windows source-tree desktop proof only.');
  test.setTimeout(60_000);
  const { spawn, execFileSync, spawnSync } = await import('node:child_process');
  const data = await mkdtemp(path.join(os.tmpdir(), 'opendraft-desktop-collab-')), profile = await mkdtemp(path.join(os.tmpdir(), 'opendraft-electron-test-'));
  const env = { ...process.env, OPENDRAFT_DATA: data, OPENDRAFT_PASSWORD: 'correct horse battery', PORT: '4183' };
  execFileSync(process.execPath, ['server/collab-server.mjs', 'user-add', 'dana'], { env, windowsHide: true });
  const server = spawn(process.execPath, ['server/collab-server.mjs', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error('server not ready')), 15_000); server.stdout!.on('data', chunk => { if (String(chunk).includes('4183')) { clearTimeout(t); resolve(); } }); });
  const childEnv = { ...process.env, OPENDRAFT_SMOKE_PROFILE: profile }; delete (childEnv as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const electronPath = (await import('electron')).default as unknown as string;
  // A plain-http server that is not this computer is refused before any window opens.
  const refused = spawnSync(electronPath, [path.resolve('desktop/main.cjs'), '--smoke-test', '--server=http://example.com'], { env: childEnv, timeout: 20_000, windowsHide: true });
  expect(refused.status).toBe(2);
  const application = await electron.launch({ args: [path.resolve('desktop/main.cjs'), '--smoke-test', '--server=http://127.0.0.1:4183'], env: childEnv, timeout: 20_000 });
  try {
    const page = await application.firstWindow();
    await page.waitForURL(/127\.0\.0\.1:4183/);
    const requests: string[] = []; page.on('request', request => { const url = request.url(); if (/^https?:/.test(url)) requests.push(new URL(url).origin); });
    await page.getByLabel('Collaboration user name', { exact: true }).fill('dana');
    await page.getByLabel('Collaboration password', { exact: true }).fill('correct horse battery');
    await page.getByRole('button', { name: 'Sign in to collaboration', exact: true }).click();
    await expect(page.locator('#collab-tools')).toContainText('dana');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(origin => origin === 'http://127.0.0.1:4183')).toBe(true);
  } finally {
    await application.close(); server.kill();
    await rm(profile, { recursive: true, force: true }); await rm(data, { recursive: true, force: true });
  }
});

test('the desktop app signs a PDF with a PKCS#12 certificate and verifies it (source or installed build)', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop proof only.');
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'opendraft-electron-test-'));
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create(); pdf.addPage([600, 400]);
  const file = path.join(profile, 'issue.pdf'); await writeFile(file, await pdf.save());
  const childEnv = { ...process.env, OPENDRAFT_SMOKE_PROFILE: profile }; delete (childEnv as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.OPENDRAFT_EXECUTABLE;
  // --background keeps downloads enabled (smoke mode blocks them) while never taking focus.
  const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [path.resolve('desktop/main.cjs')]), '--background', file], env: childEnv, timeout: 20_000 });
  try {
    const page = await application.firstWindow();
    await expect(page.locator('#document-name')).toHaveText('issue.pdf', { timeout: 20_000 });
    // Save dialogs cannot be answered headlessly: capture the signed bytes from the download instead.
    await application.evaluate(({ session }, target) => { session.fromPartition('opendraft-smoke').on('will-download', (_event, item) => item.setSavePath(target)); }, path.join(profile, 'signed.pdf'));
    await page.getByLabel('Signing certificate (.p12 or .pfx)', { exact: true }).setInputFiles(path.resolve('tests/fixtures/test-signer.p12'));
    await page.getByLabel('Certificate password', { exact: true }).fill('opendraft-test');
    await page.getByRole('button', { name: 'Sign and save copy', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Signature status' })).toContainText('signed by OpenDraft Test Signer', { timeout: 20_000 });
    await expect.poll(async () => (await readFile(path.join(profile, 'signed.pdf')).catch(() => Buffer.alloc(0))).length, { timeout: 10_000 }).toBeGreaterThan(1000);
    const { verifyPdfSignatures } = await import('../../apps/opendraft/src/pdf-signature.ts');
    const [report] = await verifyPdfSignatures(new Uint8Array(await readFile(path.join(profile, 'signed.pdf'))));
    expect([report.integrity, report.signer]).toEqual(['valid', 'OpenDraft Test Signer']);
  } finally { await application.close(); await rm(profile, { recursive: true, force: true }); }
});

test('desktop printing sends the original PDF through the PDF viewer as vectors (source or installed build)', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop proof only.');
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'opendraft-electron-test-'));
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([1728, 1152]).drawText('SHEET A101 VECTOR PRINT', { x: 60, y: 1050, size: 36, font });
  pdf.addPage([612, 792]).drawLine({ start: { x: 50, y: 50 }, end: { x: 550, y: 700 }, thickness: 0.25, color: rgb(0, 0, 0) });
  const file = path.join(profile, 'plans.pdf'), output = path.join(profile, 'printed.pdf');
  await writeFile(file, await pdf.save());
  const childEnv = { ...process.env, OPENDRAFT_SMOKE_PROFILE: profile, OPENDRAFT_PRINT_TO_PDF: output }; delete (childEnv as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.OPENDRAFT_EXECUTABLE;
  const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [path.resolve('desktop/main.cjs')]), '--smoke-test', file], env: childEnv, timeout: 20_000 });
  try {
    const page = await application.firstWindow();
    await expect(page.locator('#status')).toContainText('Page 1 of 2', { timeout: 20_000 });
    await page.getByRole('button', { name: 'Print PDF', exact: true }).click();
    await expect(page.locator('#status')).toContainText('Print dialog opened', { timeout: 20_000 });
    await expect.poll(async () => (await readFile(output).catch(() => Buffer.alloc(0))).length, { timeout: 20_000 }).toBeGreaterThan(500);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const printed = await getDocument({ data: new Uint8Array(await readFile(output)) }).promise;
    expect(printed.numPages).toBe(2);
    expect((await (await printed.getPage(1)).getTextContent()).items.map((item: any) => item.str).join(' ')).toContain('SHEET A101 VECTOR PRINT');
    expect((await printed.getPage(1)).view.map(Math.round)).toEqual([0, 0, 1728, 1152]);
    await printed.cleanup();
  } finally { await application.close(); await rm(profile, { recursive: true, force: true }); }
});
