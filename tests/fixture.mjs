import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

export async function drawingFixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([612, 792]);
  first.drawText('OpenDraft synthetic drawing A101', { x: 40, y: 730, size: 18, font });
  first.drawLine({ start: { x: 40, y: 500 }, end: { x: 328, y: 500 }, thickness: 2, color: rgb(0, 0, 0) });
  const second = pdf.addPage([792, 612]);
  second.setRotation(degrees(90));
  second.drawText('Valve schedule B202', { x: 40, y: 540, size: 18, font });
  return pdf.save();
}
