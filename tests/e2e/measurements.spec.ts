import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "node:path";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
// @ts-ignore shared authorized synthetic fixture
import { drawingFixture } from "../fixture.mjs";

test('recalibration previews quantity changes, rejects stale approval and commits atomically with undo', async ({page}) => {
  await page.goto('/');
  await page.getByLabel('Open PDF files',{exact:true}).setInputFiles({name:'impact.pdf',mimeType:'application/pdf',buffer:Buffer.from(await drawingFixture())});
  const distance=page.getByLabel('Known calibration distance',{exact:true});
  const reviewed=page.getByLabel('Review calibration reference',{exact:true});
  const save=page.getByRole('button',{name:'Save reviewed calibration',exact:true});
  const approval=page.getByLabel('Approve reviewed quantity changes',{exact:true});
  const preview=page.getByLabel('Calibration impact review',{exact:true});
  const records=page.getByLabel('Measurement records',{exact:true});
  await distance.fill('10');await reviewed.check();await save.click();
  await page.getByLabel('Measurement label',{exact:true}).fill('Existing run');
  await page.getByLabel('Measurement points',{exact:true}).fill('0,0;144,0');
  await page.getByRole('button',{name:'Add measurement',exact:true}).click();
  await expect(records).toContainText('20.000000 ft');
  await distance.fill('20');await reviewed.check();await save.click();
  await expect(page.getByRole('alert')).toContainText('Review calibration impact');
  await expect(records).toContainText('20.000000 ft');
  await page.getByRole('button',{name:'Review calibration impact',exact:true}).click();
  await expect(preview).toContainText('Existing run: 20 ft → 40 ft');
  await expect(preview).toContainText('"distance": 20');
  await approval.check();
  await distance.fill('30');
  await expect(approval).not.toBeChecked();
  await expect(reviewed).not.toBeChecked();
  await reviewed.check();
  await save.click();
  await expect(page.getByRole('alert')).toContainText('exact quantity changes');
  await expect(records).toContainText('20.000000 ft');
  await page.getByRole('button',{name:'Review calibration impact',exact:true}).click();
  const impactText=await preview.locator('p').nth(1).innerText();
  expect(Number(impactText.match(/→ ([\d.eE+-]+) ft/)![1])).toBeCloseTo(60,10);
  await approval.check();await save.click();
  await expect(records).toContainText('60.000000 ft');
  await expect(approval).not.toBeChecked();
  await page.getByRole('button',{name:'Undo edit',exact:true}).click();
  await expect(records).toContainText('20.000000 ft');
  await page.getByRole('button',{name:'Redo edit',exact:true}).click();
  await expect(records).toContainText('60.000000 ft');
});

test("reviewed scale verifies known distance and takeoff survives rotation, reorder, undo and recovery", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Open PDF files", { exact: true }).setInputFiles({
    name: "takeoff.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await drawingFixture()),
  });
  await expect(
    page.getByLabel("Known calibration distance", { exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Known calibration distance", { exact: true })
    .fill("10");
  await page
    .getByLabel("Review calibration reference", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Save reviewed calibration", exact: true })
    .click();
  await expect(page.getByText(/Page scale: .*Reference: 10 ft/)).toBeVisible();
  await page.getByLabel('Verification reference points',{exact:true}).fill('72,0;0,0');
  await page.getByLabel('Known verification distance',{exact:true}).fill('10');
  await page.getByRole('button',{name:'Verify calibration',exact:true}).click();
  await expect(page.getByRole('status',{name:'Measurement status',exact:true})).toContainText('different known reference');
  await expect(page.getByRole('alert')).toContainText('different known reference');
  await page.getByLabel('Verification reference points',{exact:true}).fill('0,0;144,0');
  await page
    .getByLabel("Known verification distance", { exact: true })
    .fill("20");
  await page
    .getByRole("button", { name: "Verify calibration", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Measurement status", exact: true }),
  ).toContainText("verification passed");
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(
    page.getByRole("status", { name: "Measurement status", exact: true }),
  ).toContainText("measured 20.000000");
  await page.getByLabel("Measurement label", { exact: true }).fill("Main run");
  await page
    .getByLabel("Measurement points", { exact: true })
    .fill("0,0;144,0");
  await page
    .getByRole("button", { name: "Add measurement", exact: true })
    .click();
  const records = page.getByLabel("Measurement records", { exact: true });
  await expect(records).toContainText("Main run · length: 20.000000 ft");
  await page
    .getByLabel("Measurement type", { exact: true })
    .selectOption("area");
  await page.getByLabel("Measurement label", { exact: true }).fill("Slab");
  await page
    .getByLabel("Measurement points", { exact: true })
    .fill("0,0;72,0;72,72;0,72");
  await page
    .getByRole("button", { name: "Add measurement", exact: true })
    .click();
  await expect(records).toContainText("Slab · area: 100.000000 ft²");
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', {name:'Export takeoff CSV',exact:true}).click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toBe('takeoff-takeoff.csv');
  await csv.saveAs(path.resolve('test-results/takeoff-quantities.csv'));
  expect(await readFile((await csv.path())!, 'utf8')).toMatch(/"100(?:\.0+1)?","ft²"/);
  const xlsxDownload = page.waitForEvent('download');
  await page.getByRole('button', {name:'Export takeoff XLSX',exact:true}).click();
  const xlsx = await xlsxDownload;
  expect(xlsx.suggestedFilename()).toBe('takeoff-takeoff.xlsx');
  await xlsx.saveAs(path.resolve('test-results/takeoff-quantities.xlsx'));
  expect((await readFile((await xlsx.path())!)).subarray(0,2).toString()).toBe('PK');
  await page
    .getByRole("button", { name: "Rotate page clockwise", exact: true })
    .click();
  await expect(records).toContainText("Main run · length: 20.000000 ft");
  await page
    .getByRole("button", { name: "Move page later", exact: true })
    .click();
  await expect(page.locator("#page-label")).toHaveText("2 / 2");
  await expect(records).toContainText("Slab · area: 100.000000 ft²");
  await page.getByRole("button", { name: "Delete page", exact: true }).click();
  await expect(page.locator("#page-label")).toHaveText("1 / 1");
  await expect(records).toContainText("0 measurement(s)");
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(page.locator("#page-label")).toHaveText("1 / 2");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(records).toContainText("Main run · length: 20.000000 ft");
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
  await expect(records).toContainText("Slab · area: 100.000000 ft²");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Export takeoff JSON", exact: true })
      .click(),
  ]);
  expect(download.suggestedFilename()).toBe("takeoff-takeoff.json");
  const portable = JSON.parse(
    (await readFile((await download.path())!)).toString(),
  );
  expect(portable.format).toBe("opendraft-takeoff");
  expect(portable.version).toBe(1);
  expect(portable.coordinateSpace).toBe("unrotated-pdf-user-space");
  expect(portable.takeoff.scales[0].pageIndex).toBe(1);
  expect(
    portable.takeoff.records.map(
      (record: { pageIndex: number }) => record.pageIndex,
    ),
  ).toEqual([1, 1]);
  expect(portable.takeoff.scales[0].reference.distance).toBe(10);
  expect(portable.takeoff.records[0].points).toEqual([
    [0, 0],
    [144, 0],
  ]);
});

test("report buttons download real CSV and independently readable PDF reports", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Open PDF files", { exact: true }).setInputFiles({
    name: "reports.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await drawingFixture()),
  });
  await page
    .getByLabel("Markup tool", { exact: true })
    .selectOption("rectangle");
  await page
    .getByLabel("Markup contents", { exact: true })
    .fill("=review detail");
  await page.getByRole("button", { name: "Add markup", exact: true }).click();
  await expect(page.locator(".markup-list button")).toHaveCount(1);
  const [csv] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Export markup CSV", exact: true })
      .click(),
  ]);
  expect(csv.suggestedFilename()).toBe("reports-markups.csv");
  const csvText = (await readFile((await csv.path())!)).toString();
  expect(csvText).toContain('"summary","reports.pdf","2","1"');
  expect(csvText).toContain('"\'=review detail"');
  const [report] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Export markup PDF", exact: true })
      .click(),
  ]);
  expect(report.suggestedFilename()).toBe("reports-markups.pdf");
  const task = getDocument({
    data: new Uint8Array(await readFile((await report.path())!)),
    standardFontDataUrl:
      path
        .resolve("node_modules/pdfjs-dist/standard_fonts")
        .replaceAll("\\", "/") + "/",
  });
  try {
    const pdf = await task.promise;
    const text = await (await pdf.getPage(1)).getTextContent();
    expect(
      text.items
        .filter((item) => "str" in item)
        .map((item) => item.str)
        .join(" "),
    ).toContain("Contents: =review detail");
  } finally {
    await task.destroy();
  }
});

test("model-only calibration leaves protected source PDF bytes untouched while PDF editing stays blocked", async ({
  page,
}) => {
  const pdf = await PDFDocument.load(await drawingFixture());
  const signature = pdf.context.register(
    pdf.context.obj({
      Type: "Sig",
      ByteRange: [0, 1, 2, 3],
      Contents: PDFString.of("synthetic structural signature fixture"),
    }),
  );
  pdf.catalog.set(PDFName.of("Perms"), pdf.context.obj({ DocMDP: signature }));
  const original = await pdf.save();
  await page.goto("/");
  await page.getByLabel("Open PDF files", { exact: true }).setInputFiles({
    name: "protected.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(original),
  });
  await page
    .getByLabel("Known calibration distance", { exact: true })
    .fill("10");
  await page
    .getByLabel("Review calibration reference", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Save reviewed calibration", exact: true })
    .click();
  await expect(page.getByText(/Page scale: .*Reference: 10 ft/)).toBeVisible();
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(
    page.getByText(
      "No reviewed scale for this page. Length, area and volume require calibration.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Redo edit", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save PDF", exact: true }).click(),
  ]);
  expect(new Uint8Array(await readFile((await download.path())!))).toEqual(
    original,
  );
  await page
    .getByRole("button", { name: "Rotate page clockwise", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("signature");
});

test("conflicting viewport calibration reports rejection and preserves quantities and undo history", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Open PDF files", { exact: true })
    .setInputFiles({
      name: "conflict.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(await drawingFixture()),
    });
  await page
    .getByLabel("Known calibration distance", { exact: true })
    .fill("10");
  await page
    .getByLabel("Review calibration reference", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Save reviewed calibration", exact: true })
    .click();
  await page
    .getByLabel("Measurement label", { exact: true })
    .fill("Existing reviewed run");
  await page
    .getByLabel("Measurement points", { exact: true })
    .fill("0,0;144,0");
  await page
    .getByRole("button", { name: "Add measurement", exact: true })
    .click();
  const records = page.getByLabel("Measurement records", { exact: true });
  await expect(records).toContainText(
    "Existing reviewed run · length: 20.000000 ft",
  );
  await page.getByLabel("Use calibration viewport", { exact: true }).check();
  await page
    .getByLabel("Calibration viewport bounds", { exact: true })
    .fill("0,0;100,100");
  await page
    .getByLabel("Review calibration reference", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Save reviewed calibration", exact: true })
    .click();
  const status = page.getByRole("status", {
    name: "Measurement status",
    exact: true,
  });
  await expect(status).toContainText("Ambiguous calibration");
  await expect(status).not.toContainText("Calibration saved");
  await expect(page.getByRole("alert")).toContainText("Ambiguous calibration");
  await expect(records).toContainText(
    "Existing reviewed run · length: 20.000000 ft",
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Export takeoff JSON", exact: true })
      .click(),
  ]);
  const model = JSON.parse(
    (await readFile((await download.path())!)).toString(),
  ).takeoff;
  expect(model.scales).toHaveLength(1);
  expect(model.scales[0].viewport).toBeUndefined();
  expect(model.records).toHaveLength(1);
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(records).toContainText("0 measurement(s)");
  await expect(page.getByText(/Page scale: .*Reference: 10 ft/)).toBeVisible();
});
