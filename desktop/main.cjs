const { app, BrowserWindow, Menu } = require('electron');
const { writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const { startHost } = require('./host.cjs');

const smoke = process.argv.includes('--smoke-test');
// --background: visible but never activated (for accessibility inspection without stealing focus);
// uses a temporary profile and ephemeral port like smoke tests.
const background = !smoke && process.argv.includes('--background');
const isolated = smoke || background;
app.enableSandbox();
app.setName('OpenDraft');
if (isolated) {
  app.setPath('userData',process.env.OPENDRAFT_SMOKE_PROFILE || mkdtempSync(path.join(os.tmpdir(),'opendraft-smoke-')));
  app.commandLine.appendSwitch('disable-gpu');
}
// PDF paths passed on the command line (Explorer "Open with" or a file association).
const launchFiles = process.argv.slice(app.isPackaged ? 1 : 2).filter(arg => !arg.startsWith('--') && /\.pdf$/i.test(arg)).map(arg => path.resolve(arg));
// Interface zoom: --ui-zoom=<0.25-3> at launch; Ctrl+= / Ctrl+- / Ctrl+0 at runtime (no app menu exists to provide them).
const zoomArg = Number(process.argv.find(arg => arg.startsWith('--ui-zoom='))?.slice(10));
const initialZoom = Number.isFinite(zoomArg) ? Math.min(3, Math.max(0.25, zoomArg)) : 1;
// --server=<https://host[:port]>: use a self-hosted OpenDraft collaboration server instead of the
// built-in local host. Only that exact origin is ever contacted; http is accepted for loopback only.
const serverArg = process.argv.find(arg => arg.startsWith('--server='))?.slice(9);
let remoteOrigin;
if (serverArg) {
  try {
    const url = new URL(serverArg);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('use https (http only for this computer)');
    if (url.username || url.password) throw new Error('credentials in the URL are not allowed');
    remoteOrigin = url.origin;
  } catch (error) { console.error(`OpenDraft: invalid --server value: ${error.message}`); app.exit(2); }
}
let host;
let window;
app.whenReady().then(async()=>{
  // Stable normal port preserves the origin used by opt-in IndexedDB recovery.
  // Smoke tests use an ephemeral port and a temporary profile, never user data.
  host=remoteOrigin?{origin:remoteOrigin,close(){}}:await startHost(path.join(__dirname,'..','apps','opendraft','dist'),isolated?0:4180,launchFiles,{onPrint:printVector});
  Menu.setApplicationMenu(null);
  window=new BrowserWindow({
    width:1440,height:960,show:!isolated,focusable:!smoke,backgroundColor:'#182b3e',
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,spellcheck:false,disableDialogs:smoke,partition:isolated?'opendraft-smoke':'persist:opendraft'}
  });
  if(background) window.once('ready-to-show',()=>window.showInactive());
  const session=window.webContents.session;
  session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.setPermissionCheckHandler(()=>false);
  session.webRequest.onBeforeRequest((details,callback)=>{
    let allowed=false;
    try {allowed=new URL(details.url).origin===host.origin;} catch {}
    callback({cancel:!allowed});
  });
  if(smoke) session.on('will-download',event=>event.preventDefault());
  // Without this the Save As dialog is titled with the internal blob: URL.
  else session.on('will-download',(_event,item)=>item.setSaveDialogOptions({title:`Save ${item.getFilename()}`}));
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url!==host.origin+'/'&&url!==host.origin+'/#launch')event.preventDefault();});
  window.webContents.on('will-redirect',(event,url)=>{if(!url.startsWith(host.origin+'/'))event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.on('did-finish-load',()=>window.webContents.setZoomFactor(initialZoom));
  window.webContents.on('before-input-event',(event,input)=>{
    if(input.type!=='keyDown'||!(input.control||input.meta)||input.alt)return;
    const current=window.webContents.getZoomFactor();
    const next=input.key==='0'?1:['=','+'].includes(input.key)?current+0.1:input.key==='-'?current-0.1:undefined;
    if(next===undefined)return;
    event.preventDefault();window.webContents.setZoomFactor(Math.min(3,Math.max(0.25,Math.round(next*10)/10)));
  });
  // No preload, IPC bridge, external-link launcher, telemetry or updater is installed.
  await window.loadURL(host.origin+'/'+(launchFiles.length&&!remoteOrigin?'#launch':''));
}).catch(error=>{
  console.error(`OpenDraft startup failed: ${error.message}`);
  app.exit(1); // Avoid native error dialogs, including during unattended smoke tests.
});
// Vector printing: the original PDF opens in a separate hidden window with Chromium's built-in PDF
// viewer (the main window's settings are untouched) and is printed through the system dialog.
// OPENDRAFT_PRINT_TO_PDF (isolated test modes only) writes the vector output to a file instead.
async function printVector(bytes){
  const dir=mkdtempSync(path.join(os.tmpdir(),'opendraft-print-')),file=path.join(dir,'print.pdf');
  writeFileSync(file,bytes);
  const printer=new BrowserWindow({show:false,webPreferences:{plugins:true,sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:true,partition:'opendraft-print'}});
  printer.webContents.on('will-navigate',event=>event.preventDefault());
  printer.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const cleanup=()=>{if(!printer.isDestroyed())printer.destroy();rmSync(dir,{recursive:true,force:true});};
  try{
    await printer.loadFile(file);
    await new Promise(resolve=>setTimeout(resolve,1500)); // let the PDF viewer lay out every page
    const testOutput=isolated?process.env.OPENDRAFT_PRINT_TO_PDF:undefined;
    if(testOutput){writeFileSync(testOutput,await printer.webContents.printToPDF({preferCSSPageSize:true}));cleanup();return;}
    printer.webContents.print({silent:false,printBackground:true},()=>cleanup());
  }catch(error){cleanup();throw error;}
}
app.on('window-all-closed',()=>{if(BrowserWindow.getAllWindows().length===0)app.quit();});
app.on('before-quit',()=>{if(smoke)for(const current of BrowserWindow.getAllWindows())current.destroy();host?.close();});
app.on('quit',()=>host?.close());
