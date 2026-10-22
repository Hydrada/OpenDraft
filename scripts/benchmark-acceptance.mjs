// Phase 1 performance acceptance run (see docs/PHASE_1_ACCEPTANCE.md). Run after `npm run build`.
// Targets: 36x48in vector first page <= 3 s, warmed navigation <= 500 ms (p50/p95 over 20 runs),
// 200-sheet set traversed without crash, browser working set <= 1 GiB.
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const RUNS = 20, SHEETS = 200, LINES = 2000, LABELS = 60;
async function sheetSet(count) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= count; n++) {
    const page = pdf.addPage([36 * 72, 48 * 72]);
    for (let i = 0; i < LINES; i++) {
      const x = 72 + (i * 37) % 2400, y = 72 + (i * 53) % 3200;
      page.drawLine({ start: { x, y }, end: { x: x + 40 + (i % 7) * 20, y: y + (i % 5) * 15 }, thickness: 0.5 + (i % 3) * 0.5, color: rgb(0.1, 0.2, 0.3) });
    }
    for (let i = 0; i < LABELS; i++) page.drawText(`Grid ${String.fromCharCode(65 + (i % 26))}-${i} dim ${(i * 1.25).toFixed(2)} ft`, { x: 100 + (i % 6) * 400, y: 300 + Math.floor(i / 6) * 280, size: 10, font });
    page.drawRectangle({ x: 2000, y: 72, width: 520, height: 260, borderWidth: 3, borderColor: rgb(0, 0, 0) });
    page.drawText(`SHEET A-${String(n).padStart(3, '0')} SYNTHETIC PLAN ${n}`, { x: 2020, y: 120, size: 24, font });
  }
  return pdf.save();
}
// Sum OS working set of this run's headless browser processes (Windows).
let breakdown = '';
function browserWorkingSet() {
  if (process.platform !== 'win32') return null;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*ms-playwright*' } | ForEach-Object { $type = if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'browser' }; '{0} {1}' -f $type, $_.WorkingSetSize }"], { encoding: 'utf8', windowsHide: true });
  const rows = out.trim().split(/\r?\n/).filter(Boolean).map(line => { const [type, bytes] = line.trim().split(' '); return { type, bytes: Number(bytes) }; });
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (total > (browserWorkingSet.peak ?? 0)) { browserWorkingSet.peak = total; breakdown = rows.map(row => `${row.type} ${(row.bytes / 1024 ** 2).toFixed(0)} MiB`).join(', '); }
  return total;
}
const percentile = (values, fraction) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

const pair = await sheetSet(2), set = await sheetSet(SHEETS);
const server = spawn(process.execPath, ['scripts/serve-production.mjs'], { env: { ...process.env, PORT: '4179' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error(output)), 10_000); server.stdout.on('data', chunk => { output += chunk; if (output.includes('4179')) { clearTimeout(timer); resolve(); } }); });
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--enable-precise-memory-info'] });
const open = async (page, name, bytes, total) => {
  const start = performance.now();
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.locator('#status').filter({ hasText: new RegExp(`^Page 1 of ${total}`) }).waitFor({ timeout: 60_000 });
  return performance.now() - start;
};
const go = async (page, target, total, direction) => {
  const start = performance.now();
  await page.getByRole('button', { name: direction, exact: true }).click();
  await page.locator('#status').filter({ hasText: new RegExp(`^Page ${target} of ${total}`) }).waitFor({ timeout: 60_000 });
  return performance.now() - start;
};
const samples = [];
let traversal;
try {
  for (let run = 1; run <= RUNS; run++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage(); await page.goto('http://127.0.0.1:4179');
    const first = await open(page, 'pair.pdf', pair, 2);
    await go(page, 2, 2, 'Next page'); await go(page, 1, 2, 'Previous page');
    const warmed = await go(page, 2, 2, 'Next page');
    samples.push({ run, first, warmed });
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('renderer crashed'));
  await page.goto('http://127.0.0.1:4179');
  const first = await open(page, 'set-200.pdf', set, SHEETS);
  let peak = browserWorkingSet() ?? 0; const steps = [];
  for (let n = 2; n <= SHEETS; n++) { steps.push(await go(page, n, SHEETS, 'Next page')); if (n % 2 === 0) peak = Math.max(peak, browserWorkingSet() ?? 0); }
  const alert = await page.locator('#error').textContent();
  traversal = { first, steps, peak, errors, alert: alert?.trim() ?? '' };
  await context.close();
} finally { await browser.close(); server.kill(); }

const firsts = samples.map(s => s.first), warms = samples.map(s => s.warmed), steps = traversal.steps;
const result = {
  firstP50: percentile(firsts, 0.5), firstP95: percentile(firsts, 0.95), warmedP50: percentile(warms, 0.5), warmedP95: percentile(warms, 0.95),
  traversalFirst: traversal.first, stepP50: percentile(steps, 0.5), stepP95: percentile(steps, 0.95), stepMax: Math.max(...steps), peakGiB: traversal.peak / 1024 ** 3,
};
const pass = { first: result.firstP95 <= 3000, warmed: result.warmedP95 <= 500, traversal: steps.length === SHEETS - 1 && !traversal.errors.length && !traversal.alert, memory: traversal.peak > 0 && result.peakGiB <= 1 };
const f = value => value.toFixed(1), cpu = os.cpus();
const report = `# OpenDraft performance acceptance

Measured ${new Date().toISOString()} with \`node scripts/benchmark-acceptance.mjs\` after \`npm run build\`.

## Environment
- ${os.type()} ${os.release()} ${os.arch()}; ${cpu[0]?.model.trim()}; ${cpu.length} logical processors; ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB RAM. **Not the proposed 16 GB baseline machine**; RAM above 1 GiB is not used by the targets below, but CPU is faster than a typical 16 GB laptop.
- Node ${process.version}; headless Chromium ${browser.version()} with --disable-gpu; viewport 1440x900, device scale 1, app default 100% zoom (larger canvas than fit-page, so a conservative memory case).
- Fixture: synthetic 36x48 in sheets, each ${LINES} vector lines, ${LABELS} text labels and a title block. Pair file ${pair.length} bytes; ${SHEETS}-sheet set ${set.length} bytes. No scans, images or complex fonts.

## Results
| Target | Threshold | Measured | Result |
|---|---|---|---|
| First page render, ${RUNS} fresh runs | p95 <= 3000 ms | p50 ${f(result.firstP50)} / p95 ${f(result.firstP95)} ms | ${pass.first ? 'PASS' : 'FAIL'} |
| Warmed navigation, ${RUNS} runs | p95 <= 500 ms | p50 ${f(result.warmedP50)} / p95 ${f(result.warmedP95)} ms | ${pass.warmed ? 'PASS' : 'FAIL'} |
| ${SHEETS}-sheet set traversal | no crash or error | opened in ${f(result.traversalFirst)} ms; ${steps.length} page steps p50 ${f(result.stepP50)} / p95 ${f(result.stepP95)} / max ${f(result.stepMax)} ms; errors: ${traversal.errors.length + (traversal.alert ? 1 : 0)} | ${pass.traversal ? 'PASS' : 'FAIL'} |
| Working memory | <= 1 GiB | peak browser-process working set ${result.peakGiB.toFixed(3)} GiB (sampled every 2 pages) | ${pass.memory ? 'PASS' : 'FAIL'} |

Timers include Playwright input scheduling. Working set sums every Playwright Chromium process (browser, renderer, GPU/utility) sampled by PowerShell; it is a sampled peak, not a continuous maximum. Peak breakdown: ${breakdown}.
`;
await writeFile('docs/PERFORMANCE_ACCEPTANCE.md', report);
console.log(report);
if (!Object.values(pass).every(Boolean)) process.exitCode = 1;
