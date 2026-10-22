// Regenerates docs/images/opendraft.png for the README: a synthetic floor plan with a few markups.
// Usage: npm run build && node scripts/readme-screenshot.mjs
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

async function floorPlan() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([1224, 792]); // 17x11 in
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.1), wall = (x1, y1, x2, y2) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 6, color: ink });
  wall(100, 120, 900, 120); wall(900, 120, 900, 680); wall(900, 680, 100, 680); wall(100, 680, 100, 120);
  wall(420, 120, 420, 400); wall(420, 480, 420, 680); wall(100, 400, 340, 400); wall(420, 400, 900, 400); wall(660, 400, 660, 680);
  for (const [label, x, y] of [['OFFICE 101', 200, 540], ['CONFERENCE 102', 480, 560], ['STORAGE 103', 720, 560], ['OPEN OFFICE 104', 560, 250], ['LOBBY 105', 200, 250]])
    page.drawText(label, { x, y, size: 14, font: bold, color: ink });
  page.drawLine({ start: { x: 100, y: 90 }, end: { x: 900, y: 90 }, thickness: 0.75, color: ink });
  page.drawText("80'-0\"", { x: 480, y: 72, size: 12, font, color: ink });
  page.drawRectangle({ x: 940, y: 40, width: 260, height: 712, borderWidth: 1.5, borderColor: ink });
  page.drawText('OPENDRAFT SAMPLE', { x: 960, y: 110, size: 16, font: bold, color: ink });
  page.drawText('FIRST FLOOR PLAN', { x: 960, y: 88, size: 12, font, color: ink });
  page.drawText('A-101', { x: 960, y: 54, size: 28, font: bold, color: ink });
  return Buffer.from(await pdf.save());
}

const server = spawn(process.execPath, ['scripts/serve-production.mjs'], { env: { ...process.env, PORT: '4191' }, stdio: 'ignore' });
try {
  await new Promise(resolve => setTimeout(resolve, 1500));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:4191/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name: 'A-101 First Floor Plan.pdf', mimeType: 'application/pdf', buffer: await floorPlan() });
  await page.getByTestId('pdf-canvas').waitFor();
  const add = async (tool, contents, [x1, y1, x2, y2]) => {
    await page.getByLabel('Markup tool', { exact: true }).selectOption(tool);
    await page.getByLabel('Markup contents', { exact: true }).fill(contents);
    await page.getByLabel('Markup author', { exact: true }).fill('Reviewer');
    for (const [name, value] of [['x1', x1], ['y1', y1], ['x2', x2], ['y2', y2]]) await page.getByLabel(`Markup ${name}`, { exact: true }).fill(String(value));
    await page.getByRole('button', { name: 'Add markup', exact: true }).click();
  };
  await add('cloud', 'Confirm door swing at conference room', [400, 380, 520, 500]);
  await add('rectangle', 'Storage shelving by owner', [680, 420, 880, 660]);
  await add('text', 'Verify 80 ft overall dimension', [430, 30, 700, 60]);
  await page.waitForTimeout(800);
  await mkdir('docs/images', { recursive: true });
  await page.screenshot({ path: 'docs/images/opendraft.png' });
  await browser.close();
  console.log('wrote docs/images/opendraft.png');
} finally { server.kill(); }
