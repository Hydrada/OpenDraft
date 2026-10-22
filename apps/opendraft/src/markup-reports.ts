import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { type Markup } from "./annotations.ts";
import { validateLayerAssignments, validateMarkupLayers, type MarkupLayer } from "./markup-layers.ts";

const MAX_ROWS = 5000;
const MAX_TEXT = 2_000_000;
const MAX_POINTS = 50_000;

function reportInput(
  filename: string,
  pageCount: number,
  markups: readonly Markup[],
  layers: readonly MarkupLayer[] = [],
): Markup[] {
  if (
    typeof filename !== "string" ||
    !filename.length ||
    filename.length > 1000
  )
    throw new Error("Report filename must contain 1–1000 characters.");
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 1_000_000)
    throw new Error("Invalid report document page count.");
  if (!Array.isArray(markups) || markups.length > MAX_ROWS)
    throw new Error(`Reports support at most ${MAX_ROWS} authored markups.`);
  let textSize = filename.length,
    points = 0,
    comments = 0;
  for (const mark of markups) {
    textSize += typeof mark?.contents === "string" ? mark.contents.length : 0;
    textSize += typeof mark?.author === "string" ? mark.author.length : 0;
    if (Array.isArray(mark?.comments)) {
      comments += mark.comments.length;
      if (mark.comments.length > 100 || comments > 5000)
        throw new Error("Markup report exceeds its comment count budget.");
      for (const comment of mark.comments) {
        for (const value of [comment?.id, comment?.parentId, comment?.author, comment?.contents, comment?.createdAt, comment?.modifiedAt])
          textSize += typeof value === "string" ? value.length : 0;
        if (textSize > MAX_TEXT)
          throw new Error("Markup report exceeds its text or geometry budget.");
      }
    }
    points += Array.isArray(mark?.points) ? mark.points.length : 0;
    if (textSize > MAX_TEXT || points > MAX_POINTS)
      throw new Error("Markup report exceeds its text or geometry budget.");
  }
  return validateLayerAssignments(markups, layers, pageCount);
}

/** Quoting handles CSV syntax; apostrophe-prefixing additionally neutralizes spreadsheet formulas. */
function csvCell(value: unknown): string {
  const text = String(value);
  // Include Unicode whitespace/BOM and ASCII control characters before a formula prefix.
  const protectedText = /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text)
    ? `'${text}`
    : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

const coordinates = (mark: Markup): string =>
  mark.points.map(([x, y]) => `${x},${y}`).join(" ; ");

/** UTF-8 CSV: one explicit summary record followed by authored markup records. No source model mutation. */
export function markupCsv(
  filename: string,
  pageCount: number,
  markups: readonly Markup[],
  layers: readonly MarkupLayer[] = [],
): string {
  const marks = reportInput(filename, pageCount, markups, layers);
  layers = validateMarkupLayers(layers);
  const headers = [
    "Record type",
    "Document",
    "Document pages",
    "Report markup count",
    "Markup ID",
    "Page",
    "Type",
    "Author",
    "Status",
    "Locked",
    "Contents",
    "Coordinates (PDF units)",
    "RGB",
    "Line width",
    "Opacity",
    "Created at",
    "Modified at",
    "Stamp appearance",
    "Group ID",
    "Layer ID",
    "Layer name",
    "Layer visible",
    "Layer edit locked",
    "Comment count",
    "Comments JSON",
  ];
  const records: unknown[][] = [
    headers,
    ["summary", filename, pageCount, marks.length, ...Array(headers.length - 4).fill("")],
  ];
  for (const mark of marks)
    records.push([
      "markup",
      filename,
      pageCount,
      marks.length,
      mark.id,
      mark.pageIndex + 1,
      mark.kind,
      mark.author,
      mark.status,
      mark.locked,
      mark.contents,
      coordinates(mark),
      mark.color.join(","),
      mark.width,
      mark.opacity,
      mark.createdAt,
      mark.modifiedAt,
      mark.stampName ?? "",
      mark.groupId ?? "",
      mark.layerId ?? "",
      layers.find(layer => layer.id === mark.layerId)?.name ?? "",
      layers.find(layer => layer.id === mark.layerId)?.visible ?? "",
      layers.find(layer => layer.id === mark.layerId)?.locked ?? "",
      mark.comments?.length ?? 0,
      JSON.stringify(mark.comments ?? []),
    ]);
  return (
    records.map((record) => record.map(csvCell).join(",")).join("\r\n") + "\r\n"
  );
}

function wrappedLines(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    font.encodeText(paragraph); // Explicit WinAnsi failure, never substitute or discard characters.
    let line = "";
    for (const character of paragraph) {
      if (font.widthOfTextAtSize(line + character, fontSize) > maxWidth) {
        if (!line)
          throw new Error("Report text cannot fit the printable width.");
        lines.push(line);
        line = "";
      }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

/** Paginated searchable report of authored markups, not imported annotations or engineering measurements. */
export async function markupPdf(
  filename: string,
  pageCount: number,
  markups: readonly Markup[],
  layers: readonly MarkupLayer[] = [],
): Promise<Uint8Array> {
  const marks = reportInput(filename, pageCount, markups, layers);
  layers = validateMarkupLayers(layers);
  const pdf = await PDFDocument.create();
  pdf.setTitle("OpenDraft authored markup report");
  pdf.setSubject(
    "Review report; coordinates are unrotated PDF page units, not calibrated measurements.",
  );
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595.28,
    pageHeight = 841.89,
    margin = 42,
    lineHeight = 14;
  let current = pdf.addPage([pageWidth, pageHeight]),
    y = pageHeight - margin;
  const newPage = () => {
    current = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  };
  const write = (text: string, heading = false) => {
    const font = heading ? bold : regular,
      size = heading ? 12 : 10;
    let lines: string[];
    try {
      lines = wrappedLines(text, font, size, pageWidth - 2 * margin);
    } catch (error) {
      throw new Error(
        `Report text is not supported by the WinAnsi report font: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const line of lines) {
      if (y < margin + 24) newPage();
      if (line)
        current.drawText(line, {
          x: margin,
          y,
          font,
          size,
          color: rgb(0.12, 0.18, 0.25),
        });
      y -= lineHeight;
    }
  };
  write("OpenDraft authored markup report", true);
  write(`Document: ${filename}`);
  write(`Document pages: ${pageCount} | Authored markups: ${marks.length}`);
  write(
    "Coordinates are PDF page units; this report is not a calibrated takeoff.",
  );
  write("Imported source annotations are not included.");
  for (const status of ["open", "accepted", "rejected"] as const)
    write(
      `${status}: ${marks.filter((mark) => mark.status === status).length}`,
    );
  y -= 8;
  for (let index = 0; index < marks.length; index++) {
    const mark = marks[index];
    if (y < margin + 100) newPage();
    write(
      `${index + 1}. Page ${mark.pageIndex + 1} | ${mark.kind} | ${mark.status}`,
      true,
    );
    write(`ID: ${mark.id}`);
    write(`Author: ${mark.author} | Locked: ${mark.locked ? "yes" : "no"}`);
    write(
      `Color RGB: ${mark.color.join(", ")} | Width: ${mark.width} | Opacity: ${mark.opacity}`,
    );
    write(`Coordinates: ${coordinates(mark)}`);
    write(`Created: ${mark.createdAt} | Modified: ${mark.modifiedAt}`);
    write(`Contents: ${mark.contents}`);
    if (mark.stampName) write(`Stamp appearance: ${mark.stampName} | Visual review stamp; no verified digital signature.`);
    if (mark.groupId) write(`Group ID: ${mark.groupId}`);
    if (mark.layerId) {
      const layer = layers.find(layer => layer.id === mark.layerId)!;
      write(`Layer: ${layer.name} | ID: ${layer.id} | Visible: ${layer.visible} | Edit locked: ${layer.locked}`);
    }
    if (mark.comments?.length) {
      write(`Comments: ${mark.comments.length}`);
      for (const comment of mark.comments) {
        write(`Comment ID: ${comment.id}`);
        write(comment.parentId ? `Reply to comment: ${comment.parentId}` : `Reply to markup: ${mark.id}`);
        write(`Comment author: ${comment.author}`);
        write(`Comment created: ${comment.createdAt} | Modified: ${comment.modifiedAt}`);
        write(`Comment contents: ${comment.contents}`);
      }
    }
    y -= 8;
  }
  const count = pdf.getPageCount();
  for (let index = 0; index < count; index++)
    pdf
      .getPage(index)
      .drawText(`OpenDraft report | ${index + 1} / ${count}`, {
        x: margin,
        y: 24,
        font: regular,
        size: 9,
        color: rgb(0.35, 0.4, 0.45),
      });
  return pdf.save();
}

/**
 * Punch list: every markup that is still open (or all, when `includeClosed`), numbered P-001… in
 * page then top-to-bottom order, with its latest reply so the field team sees the current state.
 */
export function punchListCsv(document: string, pageCount: number, markups: readonly Markup[], { includeClosed = false, sheetNumbers = new Map<number, string>() }: { includeClosed?: boolean; sheetNumbers?: ReadonlyMap<number, string> } = {}): string {
  const items = reportInput(document, pageCount, markups, [])
    .filter(mark => includeClosed || mark.status === 'open')
    .sort((a, b) => a.pageIndex - b.pageIndex || Math.max(b.points[0][1], b.points[1]?.[1] ?? b.points[0][1]) - Math.max(a.points[0][1], a.points[1]?.[1] ?? a.points[0][1]) || a.points[0][0] - b.points[0][0]);
  const rows: unknown[][] = [['Item', 'Status', 'Page', 'Sheet', 'Type', 'Description', 'Assigned by', 'Created', 'Replies', 'Latest reply', 'Markup ID']];
  items.forEach((mark, index) => {
    const replies = mark.comments ?? [], latest = replies.reduce<typeof replies[number] | undefined>((best, item) => !best || item.modifiedAt > best.modifiedAt ? item : best, undefined);
    rows.push([`P-${String(index + 1).padStart(3, '0')}`, mark.status, mark.pageIndex + 1, sheetNumbers.get(mark.pageIndex) ?? '', mark.kind, mark.contents, mark.author, mark.createdAt, replies.length, latest ? `${latest.author}: ${latest.contents}` : '', mark.id]);
  });
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
