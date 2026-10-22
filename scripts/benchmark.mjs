import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// A modest diagnostic run, not the release acceptance benchmark.
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let n=1;n<=2;n++) {
  const page = pdf.addPage([36*72,48*72]);
  page.drawText(`OpenDraft synthetic 36 x 48 inch sheet ${n}`, {x:72,y:3300,size:36,font});
  for (let i=0;i<100;i++) {
    const y=100+i*29;
    page.drawLine({start:{x:72,y},end:{x:2500-(i%10)*25,y:y+150},thickness:2,color:rgb(.1,.2,.3)});
  }
}
const bytes = await pdf.save();
const server = spawn(process.execPath,['scripts/serve-production.mjs'],{env:{...process.env,PORT:'4179'},stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser;
try {
  await new Promise((resolve,reject)=>{
    let output='';
    const timer=setTimeout(()=>reject(new Error(`Benchmark host timeout: ${output}`)),10_000);
    server.on('error',error=>{clearTimeout(timer);reject(error);});
    server.on('exit',code=>{clearTimeout(timer);reject(new Error(`Benchmark host exited ${code}: ${output}`));});
    server.stderr.on('data',chunk=>{output+=chunk;});
    server.stdout.on('data',chunk=>{output+=chunk;if(output.includes('http://127.0.0.1:4179')){clearTimeout(timer);resolve();}});
  });
  browser=await chromium.launch({headless:true,args:['--disable-gpu','--enable-precise-memory-info']});
  const samples=[];
  for(let n=1;n<=5;n++) {
    const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
    try {
      const page=await context.newPage();
      await page.goto('http://127.0.0.1:4179');
      await page.getByRole('button',{name:'Open PDF',exact:false}).first().waitFor();
      const firstStart=performance.now();
      await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'large-format.pdf',mimeType:'application/pdf',buffer:Buffer.from(bytes)});
      await page.locator('#status').filter({hasText:/^Page 1 of 2/}).waitFor();
      const firstMs=performance.now()-firstStart;
      // Warm both pages before measuring the navigation return to page 2.
      await page.getByRole('button',{name:'Next page',exact:true}).click();
      await page.locator('#status').filter({hasText:/^Page 2 of 2/}).waitFor();
      await page.getByRole('button',{name:'Previous page',exact:true}).click();
      await page.locator('#status').filter({hasText:/^Page 1 of 2/}).waitFor();
      const navigationStart=performance.now();
      await page.getByRole('button',{name:'Next page',exact:true}).click();
      await page.locator('#status').filter({hasText:/^Page 2 of 2/}).waitFor();
      const navigationMs=performance.now()-navigationStart;
      const memory=await page.evaluate(()=>performance.memory?.usedJSHeapSize??null);
      samples.push({sample:n,firstMs:Number(firstMs.toFixed(2)),warmedNavigationMs:Number(navigationMs.toFixed(2)),mainThreadJsHeapBytes:memory});
    } finally {await context.close();}
  }
  const percentile=(values,fraction)=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*fraction)-1];
  const first=samples.map(s=>s.firstMs),navigation=samples.map(s=>s.warmedNavigationMs);
  const cpu=os.cpus();
  const report=`# OpenDraft modest performance baseline

Measured ${new Date().toISOString()} using \`node scripts/benchmark.mjs\` after \`npm run build\`.

## Environment and method
- OS: ${os.type()} ${os.release()} ${os.arch()}; CPU: ${cpu[0]?.model}; ${cpu.length} logical processors; total RAM: ${(os.totalmem()/1024**3).toFixed(2)} GiB.
- Node: ${process.version}; browser: headless Chromium ${browser.version()}.
- Browser launched with --disable-gpu and --enable-precise-memory-info; CPU raster path requested. This is not proof that every OS graphics operation avoids GPU use.
- Viewport 1440x900, device scale 1, app default 100% zoom. Each sample uses a fresh browser context; application assets load before the open timer starts.
- Synthetic fixture: 2 portrait 36x48 inch pages (2592x3456 PDF points), 100 vector lines and one text title per page; ${bytes.length} bytes. No scanned images, engineering data, complex fonts, annotations or external content.
- First-render timer: just before file selection to #status reporting Page 1 of 2 (after canvas rendering). Includes file input/parse/worker/render and Playwright scheduling overhead; excludes initial app asset loading.
- Warmed-navigation timer: after visiting both pages, click next from page 1 to page 2 until the render-complete status. Includes input scheduling overhead. Thumbnails may still run concurrently.
- Memory: main-page usedJSHeapSize after warmed navigation, if exposed. This excludes PDF worker heap, canvas/native allocations and process working set; not a peak-memory measurement.

## Actual observations — five sequential samples

| Sample | First render ms | Warmed navigation ms | Main page JS heap bytes |
|---|---:|---:|---:|
${samples.map(s=>`| ${s.sample} | ${s.firstMs} | ${s.warmedNavigationMs} | ${s.mainThreadJsHeapBytes??'unavailable'} |`).join('\n')}

Nearest-rank p50 / p95: first render **${percentile(first,.5)} / ${percentile(first,.95)} ms**; warmed navigation **${percentile(navigation,.5)} / ${percentile(navigation,.95)} ms**. With five samples, p95 is the maximum observed sample and is not a stable tail-latency estimate.

## Limits and acceptance status
This is a small diagnostic baseline, not a release benchmark pass. The proposed acceptance corpus requires 20 runs, a 200-sheet construction set, a defined 16GB Windows baseline, fit-page memory/working-set measurements and independent drawing fidelity checks. None of those are established by these five samples. CPU contention/background activity is uncontrolled. Default 100% large-format canvases are ~8.96M pixels at device scale 1; this does not exercise the 32M pixel cap or high-DPI devices. The browser contexts and loopback host are closed on completion/failure; the PDF exists only in memory.
`;
  await writeFile(new URL('../docs/PERFORMANCE_BASELINE.md',import.meta.url),report);
  console.log(JSON.stringify({fixtureBytes:bytes.length,browser:browser.version(),samples,firstP50:percentile(first,.5),firstP95:percentile(first,.95),navigationP50:percentile(navigation,.5),navigationP95:percentile(navigation,.95)},null,2));
} finally {
  try { await browser?.close(); }
  finally { if(server.exitCode===null&&server.signalCode===null){const exited=once(server,'exit');server.kill();await exited;} }
}
