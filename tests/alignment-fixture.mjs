import {PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix} from 'pdf-lib';

/** Authorized asymmetric construction-like glyphs with a known displayed-coordinate transform. */
export async function alignmentDrawing({scale = 1, rotation = 0, dx = 0, dy = 0, blank = false} = {}) {
  const pdf = await PDFDocument.create({updateMetadata: false}), width = 600, height = 500;
  const page = pdf.addPage([width, height]), font = await pdf.embedFont(StandardFonts.Helvetica), black = rgb(0, 0, 0);
  const angle = rotation * Math.PI / 180, a = scale * Math.cos(angle), b = scale * Math.sin(angle), c = -b, d = a;
  // Convert a top-left page-coordinate transform to PDF bottom-left coordinates.
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, -b, -c, d, c * height + dx, height - d * height - dy));
  let state = 1297729;
  const random = () => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296;};
  if (!blank) for (let row = 0; row < 5; row++) for (let column = 0; column < 6; column++) {
    const id = row * 6 + column, x = 35 + column * 90 + random() * 10, y = 35 + row * 90 + random() * 12;
    const w = 25 + random() * 38, h = 18 + random() * 38;
    page.drawRectangle({x, y, width: w, height: h, borderWidth: 1 + id % 3, borderColor: black});
    page.drawLine({start: {x, y}, end: {x: x + w, y: y + h}, thickness: 1, color: black});
    if (id % 2) page.drawCircle({x: x + 13, y: y + h / 2, size: 4 + id % 5, borderWidth: 1.5, borderColor: black});
    page.drawText(`V${id + 11} ${Math.floor(random() * 900)}`, {x: x - 2, y: y + h + 4, size: 9 + id % 5, font, color: black});
    for (let bar = 0; bar < 3; bar++) page.drawRectangle({x: x + 4 + bar * 8, y: y + 3, width: 3, height: 3 + random() * 14, color: black});
  }
  page.pushOperators(popGraphicsState());
  return pdf.save();
}
