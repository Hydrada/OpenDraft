import { PDFDocument, PDFName, PDFString, PDFHexString } from 'pdf-lib';

// Annotations shaped like those written by Revu/Acrobat (standard ISO 32000 dictionaries only).
export async function foreignPdf() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([800, 600]);
  const add = entries => { const ref = pdf.context.register(pdf.context.obj({ Type: 'Annot', P: page.ref, ...entries })); return ref; };
  const s = value => PDFHexString.fromText(value);
  const square = add({ Subtype: 'Square', Rect: [100, 100, 300, 200], C: [0, 0, 1], BS: { W: 3 }, CA: 0.8, Contents: s('Check clearance'), T: s('Reviewer A'), CreationDate: PDFString.of('D:20260115093000Z'), M: PDFString.of('D:20260116100000Z'), NM: s('rev-1') });
  const cloud = add({ Subtype: 'Polygon', Rect: [400, 300, 600, 450], Vertices: [400, 300, 600, 300, 600, 450, 400, 450], BE: { S: 'C', I: 1 }, C: [1, 0, 0], Contents: s('Revise door') });
  const arrow = add({ Subtype: 'Line', Rect: [50, 400, 250, 500], L: [50, 400, 250, 500], LE: ['None', 'OpenArrow'], C: [0, 0.5, 0] });
  const callout = add({ Subtype: 'FreeText', Rect: [500, 100, 700, 160], CL: [450, 60, 480, 80, 500, 120], Contents: s('Verify riser'), DA: PDFString.of('/Helv 12 Tf 0 g') });
  const note = add({ Subtype: 'Text', Rect: [700, 550, 720, 570], Contents: s('Sticky note'), T: s('PM') });
  const stamp = add({ Subtype: 'Stamp', Rect: [600, 500, 780, 560], Name: 'Approved' });
  const custom = add({ Subtype: 'Stamp', Rect: [20, 20, 160, 60], Name: 'Reviewed#20by#20MEP' });
  const ink = add({ Subtype: 'Ink', Rect: [300, 500, 400, 590], InkList: [[300, 500, 350, 550, 400, 590], [310, 510, 320, 520]] });
  const measure = add({ Subtype: 'Line', Rect: [0, 0, 100, 10], L: [0, 5, 100, 5], IT: 'LineDimension', Measure: { Type: 'Measure' } });
  const link = add({ Subtype: 'Link', Rect: [0, 580, 50, 600] });
  const reply = add({ Subtype: 'Text', Rect: [100, 100, 120, 120], IRT: square, Contents: s('Done, see rev B'), T: s('Designer'), M: PDFString.of('D:20260117120000Z') });
  const unicode = add({ Subtype: 'Square', Rect: [10, 300, 60, 350], Contents: s('検査') });
  page.node.set(PDFName.of('Annots'), pdf.context.obj([square, cloud, arrow, callout, note, stamp, custom, ink, measure, link, reply, unicode]));
  return pdf.save();
}
