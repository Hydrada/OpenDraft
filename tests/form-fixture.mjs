import { PDFDocument, StandardFonts } from 'pdf-lib';

// A transmittal-style form built with standard AcroForm fields.
export async function transmittalForm() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 500]), form = pdf.getForm(), font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('TRANSMITTAL', { x: 40, y: 450, size: 20, font });
  const project = form.createTextField('project'); project.addToPage(page, { x: 40, y: 380, width: 300, height: 24 });
  const notes = form.createTextField('notes'); notes.enableMultiline(); notes.addToPage(page, { x: 40, y: 260, width: 300, height: 80 });
  const sheet = form.createTextField('sheet'); sheet.setMaxLength(6); sheet.addToPage(page, { x: 360, y: 380, width: 100, height: 24 });
  const urgent = form.createCheckBox('urgent'); urgent.addToPage(page, { x: 40, y: 220, width: 16, height: 16 });
  const status = form.createRadioGroup('status');
  status.addOptionToPage('Approved', page, { x: 40, y: 180, width: 16, height: 16 }); status.addOptionToPage('Revise', page, { x: 120, y: 180, width: 16, height: 16 });
  const discipline = form.createDropdown('discipline'); discipline.addOptions(['Architectural', 'Mechanical', 'Electrical']); discipline.addToPage(page, { x: 40, y: 130, width: 200, height: 24 });
  const locked = form.createTextField('form number'); locked.setText('T-001'); locked.enableReadOnly(); locked.addToPage(page, { x: 360, y: 440, width: 100, height: 24 });
  return pdf.save();
}
