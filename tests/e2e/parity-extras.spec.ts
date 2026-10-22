import { test, expect, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

async function open(page: Page, name = 'sheet.pdf') {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 400]);
  await page.goto('/');
  await page.getByLabel('Open PDF files', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('#status')).toContainText('Page 1 of 1');
}
const box = async (page: Page, [x1, y1, x2, y2]: number[]) => { for (const [label, value] of [['Markup x1', x1], ['Markup y1', y1], ['Markup x2', x2], ['Markup y2', y2]] as const) await page.getByLabel(label, { exact: true }).fill(String(value)); };

test('dynamic stamp text resolves at placement and open markups export as a numbered punch list', async ({ page }) => {
  await open(page);
  await page.getByLabel('Markup author', { exact: true }).fill('QA Lead');
  await page.getByLabel('Markup tool', { exact: true }).selectOption('stamp');
  await page.getByLabel('Markup contents', { exact: true }).fill('CHECKED {author} {date}');
  await box(page, [300, 300, 560, 360]);
  await page.getByRole('button', { name: 'Add markup', exact: true }).click();
  const today = new Date(), date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await expect(page.locator('.markup-list button')).toContainText(`CHECKED QA Lead ${date}`);
  await page.getByLabel('Markup tool', { exact: true }).selectOption('cloud');
  await page.getByLabel('Markup contents', { exact: true }).fill('Missing damper');
  await box(page, [50, 50, 200, 150]);
  await page.getByRole('button', { name: 'Add markup', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export punch list CSV', exact: true }).click();
  const csv = (await readFile((await (await download).path())!, 'utf8')).trim().split('\r\n');
  expect(csv).toHaveLength(3);
  expect(csv[1]).toMatch(/^"P-001","open","1","","stamp","CHECKED QA Lead/);
  expect(csv[2]).toMatch(/^"P-002","open","1","","cloud","Missing damper"/);
});

test('form fields are designed on the page, then filled and saved', async ({ page }) => {
  await open(page, 'blank.pdf');
  const status = page.getByRole('status', { name: 'Form status' });
  for (const [type, name, rect, options] of [['text', 'Project', '40,340;300,364', ''], ['dropdown', 'Discipline', '40,300;240,324', 'Arch,Mech'], ['checkbox', 'Urgent', '40,260;56,276', '']]) {
    await page.getByLabel('New field type', { exact: true }).selectOption(type);
    await page.getByLabel('New field name', { exact: true }).fill(name);
    await page.getByLabel('New field box (x1,y1;x2,y2 in PDF units)', { exact: true }).fill(rect);
    await page.getByLabel('Dropdown options (comma separated)', { exact: true }).fill(options);
    await page.getByRole('button', { name: 'Add form field', exact: true }).click();
    await expect(status).toContainText(`Added field "${name}"`);
  }
  // One design tab next to the original, not one tab per field.
  await expect(page.getByRole('button', { name: /^View / })).toHaveCount(2);
  await expect(page.locator('#document-name')).toHaveText('blank (form design).pdf');
  await page.getByLabel('Form field Project', { exact: true }).fill('Pump Station');
  await page.getByLabel('Form field Discipline', { exact: true }).selectOption('Mech');
  await page.getByLabel('Form field Urgent', { exact: true }).check();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save filled form copy', exact: true }).click();
  const saved = await PDFDocument.load(await readFile((await (await download).path())!));
  expect(saved.getForm().getTextField('Project').getText()).toBe('Pump Station');
  expect(saved.getForm().getDropdown('Discipline').getSelected()).toEqual(['Mech']);
  expect(saved.getForm().getCheckBox('Urgent').isChecked()).toBe(true);
});
