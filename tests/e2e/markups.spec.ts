import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFArray, PDFDict } from "pdf-lib";
// @ts-ignore shared synthetic fixture
import { drawingFixture } from "../fixture.mjs";

async function exportedAnnotations(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  const array = pdf.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  return array
    ? Array.from({ length: array.size() }, (_, index) =>
        array.lookup(index, PDFDict).get(PDFName.of("Subtype"))?.toString(),
      )
    : [];
}

test("markups export as editable PDF annotations with lock, undo and authored flattening", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Open PDF files", { exact: true })
    .setInputFiles({
      name: "markups.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(await drawingFixture()),
    });
  await expect(page.getByTestId("pdf-canvas")).toBeVisible();
  await page
    .getByLabel("Markup tool", { exact: true })
    .selectOption("rectangle");
  await page
    .getByLabel("Markup contents", { exact: true })
    .fill("Review foundation detail");
  await page
    .getByLabel("Markup author", { exact: true })
    .fill("Synthetic reviewer");
  await page.getByRole("button", { name: "Add markup", exact: true }).click();
  await expect(page.locator(".markup-list button")).toHaveCount(1);
  await page.locator(".markup-list button").click();
  await page.getByLabel("Markup locked", { exact: true }).check();
  await page
    .getByRole("button", { name: "Update selected markup", exact: true })
    .click();
  await expect(page.locator(".markup-list button")).toContainText("locked");
  await page
    .getByRole("button", { name: "Delete selected markup", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Unlock");
  await expect(page.locator(".markup-list button")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Unlock selected markup", exact: true })
    .click();
  await expect(page.locator(".markup-list button")).not.toContainText("locked");
  await page.getByLabel("Markup tool", { exact: true }).selectOption("text");
  await page
    .getByLabel("Markup contents", { exact: true })
    .fill("Confirm anchor spacing");
  await page.getByLabel("Markup y1", { exact: true }).fill("210");
  await page.getByLabel("Markup y2", { exact: true }).fill("270");
  await page.getByRole("button", { name: "Add markup", exact: true }).click();
  await expect(page.locator(".markup-list button")).toHaveCount(2);
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(page.locator(".markup-list button")).toHaveCount(1);
  await page.getByRole("button", { name: "Redo edit", exact: true }).click();
  await expect(page.locator(".markup-list button")).toHaveCount(2);
  const [save] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save PDF", exact: true }).click(),
  ]);
  expect(
    await exportedAnnotations(await readFile((await save.path())!)),
  ).toEqual(["/Square", "/FreeText"]);
  const [flat] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Flatten OpenDraft markups", exact: true })
      .click(),
  ]);
  expect(
    await exportedAnnotations(await readFile((await flat.path())!)),
  ).toEqual([]);
  await expect(page.locator(".markup-list button")).toHaveCount(2);
});

test("pointer drawing maps viewport coordinates and retained workspace restores editable markups", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Open PDF files", { exact: true })
    .setInputFiles({
      name: "pointer.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(await drawingFixture()),
    });
  await expect(page.getByTestId("pdf-canvas")).toBeVisible();
  await page
    .getByLabel("Markup tool", { exact: true })
    .selectOption("rectangle");
  await page
    .getByLabel("Markup contents", { exact: true })
    .fill("Pointer geometry");
  const box = (await page.getByTestId("pdf-canvas").boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 180);
  await page.mouse.up();
  await expect(page.locator(".markup-list button")).toHaveCount(1);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save PDF", exact: true }).click(),
  ]);
  const pdf = await PDFDocument.load(await readFile((await download.path())!));
  const annots = pdf.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
  const rect = annots
    .lookup(0, PDFDict)
    .lookup(PDFName.of("Rect"), PDFArray)
    .asArray()
    .map((value) => Number(value.toString()));
  // The normal appearance has a two-point stroke margin around the exact geometry.
  expect(rect).toEqual([38, 610, 202, 694]);
  await page.locator('.markup-list button').click();
  await expect(page.getByLabel('Markup x1',{exact:true})).toHaveValue('40');
  await expect(page.getByLabel('Markup y1',{exact:true})).toHaveValue('692');
  await expect(page.getByLabel('Markup x2',{exact:true})).toHaveValue('200');
  await expect(page.getByLabel('Markup y2',{exact:true})).toHaveValue('612');
  await page
    .getByLabel("Retain PDFs on this browser for recovery", { exact: true })
    .check();
  await expect(
    page.getByText("Recovery saved locally", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Restore retained session", exact: true })
    .click();
  await expect(page.locator(".markup-list button")).toHaveCount(1);
  await page.locator(".markup-list button").click();
  await expect(page.getByLabel("Markup contents", { exact: true })).toHaveValue(
    "Pointer geometry",
  );
  await page
    .getByLabel("Markup contents", { exact: true })
    .fill("Restored editable note");
  await page
    .getByRole("button", { name: "Update selected markup", exact: true })
    .click();
  await expect(page.locator(".markup-list button")).toContainText(
    "Restored editable note",
  );
  const [updated] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save PDF", exact: true }).click(),
  ]);
  expect(
    await exportedAnnotations(await readFile((await updated.path())!)),
  ).toEqual(["/Square"]);
});

test('callout leader and cloud survive editing, recovery and PDF export', async ({page}) => {
  await page.goto('/');
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'revision.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  await page.getByLabel('Markup tool',{exact:true}).selectOption('callout');
  await page.getByLabel('Markup contents',{exact:true}).fill('Check revision');
  await page.getByRole('button',{name:'Add markup',exact:true}).click();
  await expect(page.locator('.markup-list button')).toHaveCount(1);
  await page.locator('.markup-list button').click();
  await expect(page.getByLabel('Callout leader points',{exact:true})).toHaveValue('20,80;30,140;40,140');
  await page.getByLabel('Callout leader points',{exact:true}).fill('20,80;90,140');
  await page.getByRole('button',{name:'Update selected markup',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('boundary');
  await page.getByLabel('Callout leader points',{exact:true}).fill('20,80;40,140');
  await page.getByRole('button',{name:'Update selected markup',exact:true}).click();
  await page.getByLabel('Markup tool',{exact:true}).selectOption('cloud');
  await page.getByLabel('Markup contents',{exact:true}).fill('Revision cloud');
  await page.getByRole('button',{name:'Add markup',exact:true}).click();
  await expect(page.locator('.markup-list button')).toHaveCount(2);
  await page.getByLabel('Retain PDFs on this browser for recovery',{exact:true}).check();
  await expect(page.getByText('Recovery saved locally',{exact:true})).toBeVisible();
  await page.reload();
  await page.getByRole('button',{name:'Restore retained session',exact:true}).click();
  await expect(page.locator('.markup-list button')).toHaveCount(2);
  await page.locator('.markup-list button').first().click();
  await expect(page.getByLabel('Callout leader points',{exact:true})).toHaveValue('20,80;40,140');
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Save PDF',exact:true}).click()]);
  const bytes=await readFile((await download.path())!);
  expect(await exportedAnnotations(bytes)).toEqual(['/FreeText','/Square']);
  const pdf=await PDFDocument.load(bytes);
  const annots=pdf.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray);
  expect(annots.lookup(0,PDFDict).lookup(PDFName.of('CL'),PDFArray).asArray().map(value=>Number(value.toString()))).toEqual([20,80,40,140]);
  expect(annots.lookup(1,PDFDict).lookup(PDFName.of('BE'),PDFDict).get(PDFName.of('S'))?.toString()).toBe('/C');
  const [flat]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Flatten OpenDraft markups',exact:true}).click()]);
  expect(await exportedAnnotations(await readFile((await flat.path())!))).toEqual([]);
});

test('dragged callout anchors entered tip to textbox edge in PDF coordinates', async ({page}) => {
  await page.goto('/');
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'callout-pointer.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  await page.getByLabel('Markup tool',{exact:true}).selectOption('callout');
  await page.getByLabel('Markup contents',{exact:true}).fill('Pointer callout');
  await page.getByLabel('Callout leader points',{exact:true}).fill('20,650;40,140');
  const box=(await page.getByTestId('pdf-canvas').boundingBox())!;
  await page.mouse.move(box.x+100,box.y+100);
  await page.mouse.down();
  await page.mouse.move(box.x+260,box.y+180);
  await page.mouse.up();
  await expect(page.locator('.markup-list button')).toHaveCount(1);
  await expect(page.getByLabel('Callout leader points',{exact:true})).toHaveValue('20,650;100,650');
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Save PDF',exact:true}).click()]);
  const pdf=await PDFDocument.load(await readFile((await download.path())!));
  const annotation=pdf.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray).lookup(0,PDFDict);
  expect(annotation.lookup(PDFName.of('CL'),PDFArray).asArray().map(value=>Number(value.toString()))).toEqual([20,650,100,650]);
});
