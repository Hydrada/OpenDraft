import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

export type Cell = string | number;
export type LinkedSheet = { name: string; rows: Cell[][] };
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const SHEET_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const SHEET_CONTENT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

const xml = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
const column = (index: number) => { let name = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name; return name; };

/** A worksheet of literal values: numbers stay numeric, strings are inline text (never formulas). */
function sheetXml(rows: Cell[][]): string {
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
    const ref = `${column(c)}${r + 1}`;
    if (typeof cell === 'number') return Number.isFinite(cell) ? `<c r="${ref}"><v>${cell}</v></c>` : '';
    return cell === '' ? '' : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(cell.slice(0, 32767))}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN}"><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * Quantity link: writes (or refreshes) OpenDraft sheets inside an existing workbook and leaves every
 * other part untouched, so formulas such as =SUMIFS('OpenDraft Summary'!D:D, ...) update. Excel is
 * told to recalculate on open. Only .xlsx (Office Open XML) workbooks are supported.
 */
export function linkIntoWorkbook(workbook: Uint8Array, sheets: readonly LinkedSheet[]): Uint8Array {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(workbook); } catch { throw new Error('The file is not an .xlsx workbook.'); }
  const read = (path: string) => { const file = files[path]; if (!file) throw new Error(`The workbook is missing ${path}; save it as .xlsx in Excel and try again.`); return strFromU8(file); };
  const workbookPath = 'xl/workbook.xml', relsPath = 'xl/_rels/workbook.xml.rels', typesPath = '[Content_Types].xml';
  let book = read(workbookPath), rels = read(relsPath), types = read(typesPath);
  for (const sheet of sheets) {
    if (!/^[^\\/?*[\]:]{1,31}$/.test(sheet.name)) throw new Error(`Invalid sheet name "${sheet.name}".`);
    const escaped = xml(sheet.name);
    const existing = new RegExp(`<sheet\\b[^>]*\\bname="${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`).exec(book);
    let target: string;
    if (existing) {
      // Refresh in place: same sheet, same relationship, new values.
      const id = /r:id="([^"]+)"/.exec(existing[0])?.[1];
      const rel = id ? new RegExp(`<Relationship\\b[^>]*\\bId="${id}"[^>]*/>`).exec(rels)?.[0] : undefined;
      const href = rel ? /Target="([^"]+)"/.exec(rel)?.[1] : undefined;
      if (!href) throw new Error(`Could not locate the existing "${sheet.name}" sheet.`);
      target = href.startsWith('/') ? href.slice(1) : `xl/${href.replace(/^\.\//, '')}`;
    } else {
      let n = 1; while (files[`xl/worksheets/sheet${n}.xml`] || rels.includes(`worksheets/sheet${n}.xml`)) n++;
      target = `xl/worksheets/sheet${n}.xml`;
      const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1])), rid = `rId${Math.max(0, ...ids) + 1}`;
      const sheetIds = [...book.matchAll(/sheetId="(\d+)"/g)].map(m => Number(m[1]));
      rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="${SHEET_TYPE}" Target="worksheets/sheet${n}.xml"/></Relationships>`);
      if (!/<sheets\b[^>]*>/.test(book)) throw new Error('The workbook has no sheet list.');
      book = book.replace('</sheets>', `<sheet name="${escaped}" sheetId="${Math.max(0, ...sheetIds) + 1}" r:id="${rid}"/></sheets>`);
      if (!/xmlns:r=/.test(book.slice(0, book.indexOf('>', book.indexOf('<workbook'))))) book = book.replace(/<workbook\b/, '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
      types = types.replace('</Types>', `<Override PartName="/${target}" ContentType="${SHEET_CONTENT}"/></Types>`);
    }
    files[target] = strToU8(sheetXml(sheet.rows));
  }
  // Recalculate on open so formulas that read the linked sheets show current quantities.
  // calcPr must follow sheets/functionGroups/externalReferences/definedNames in schema order.
  if (/<calcPr\b[^>]*\/>/.test(book)) book = book.replace(/<calcPr\b([^>]*?)\s*\/>/, (_, attrs: string) => `<calcPr${attrs.replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`);
  else {
    const after = ['</definedNames>', '</externalReferences>', '</functionGroups>', '</sheets>'].find(tag => book.includes(tag))!;
    book = book.replace(after, `${after}<calcPr fullCalcOnLoad="1"/>`);
  }
  files[workbookPath] = strToU8(book); files[relsPath] = strToU8(rels); files[typesPath] = strToU8(types);
  const zippable: Zippable = {}; for (const [path, data] of Object.entries(files)) zippable[path] = [data, { level: 6 }];
  return zipSync(zippable);
}

// Summary totals feed spreadsheet formulas: drop binary floating-point noise (199.99999999999997 -> 200).
const tidy = (value: number) => Number(value.toPrecision(12));

/** The two linked sheets: every measurement, and totals by space/item/type/unit for formulas. */
export async function quantityLinkSheets(document: string, pageCount: number, takeoff: Parameters<typeof import('./takeoff-reports.ts').takeoffRows>[2]): Promise<LinkedSheet[]> {
  const { takeoffRows } = await import('./takeoff-reports.ts'), { legendRows } = await import('./takeoff-legend.ts');
  const summary: Cell[][] = [['Space', 'Item', 'Type', 'Unit', 'Total', 'Count', 'Derived total', 'Derived unit'],
    ...legendRows(takeoff, pageCount).map(row => [row.space, row.label, row.kind, row.unit, tidy(row.total), row.count, row.derived ? tidy(row.derived.total) : '', row.derived?.unit ?? ''])];
  return [{ name: 'OpenDraft Summary', rows: summary }, { name: 'OpenDraft Takeoff', rows: takeoffRows(document, pageCount, takeoff) }];
}
