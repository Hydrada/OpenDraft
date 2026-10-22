import { PDFArray, PDFCheckBox, PDFDocument, PDFDropdown, PDFHexString, PDFName, PDFOptionList, PDFRadioGroup, PDFSignature, PDFTextField, StandardFonts } from 'pdf-lib';

export type FormField =
  | { name: string; type: 'text'; value: string; multiline: boolean; maxLength?: number; readOnly: boolean }
  | { name: string; type: 'checkbox'; value: boolean; readOnly: boolean }
  | { name: string; type: 'radio' | 'dropdown'; value: string; options: string[]; readOnly: boolean }
  | { name: string; type: 'list'; value: string[]; options: string[]; multiple: boolean; readOnly: boolean };
export type FormValues = Record<string, string | boolean | string[]>;

/** Lists fillable AcroForm fields. XFA-only forms are reported as unsupported; signature fields are skipped. */
export async function readFormFields(bytes: Uint8Array): Promise<{ fields: FormField[]; xfa: boolean }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = pdf.getForm(), xfa = form.hasXFA();
  const fields: FormField[] = [];
  for (const field of form.getFields()) {
    const name = field.getName(), readOnly = field.isReadOnly();
    if (field instanceof PDFTextField) fields.push({ name, type: 'text', value: field.getText() ?? '', multiline: field.isMultiline(), ...(field.getMaxLength() !== undefined ? { maxLength: field.getMaxLength() } : {}), readOnly });
    else if (field instanceof PDFCheckBox) fields.push({ name, type: 'checkbox', value: field.isChecked(), readOnly });
    else if (field instanceof PDFRadioGroup) fields.push({ name, type: 'radio', value: field.getSelected() ?? '', options: field.getOptions(), readOnly });
    else if (field instanceof PDFDropdown) fields.push({ name, type: 'dropdown', value: field.getSelected()[0] ?? '', options: field.getOptions(), readOnly });
    else if (field instanceof PDFOptionList) fields.push({ name, type: 'list', value: field.getSelected(), options: field.getOptions(), multiple: field.isMultiselect(), readOnly });
    else if (field instanceof PDFSignature) continue;
  }
  return { fields, xfa };
}

/**
 * Writes values into a copy. Every named field must exist and accept the value; read-only fields
 * cannot be changed. Appearances are regenerated so every viewer shows the values; `flatten`
 * burns them into the page so they can no longer be edited.
 */
export async function fillForm(bytes: Uint8Array, values: FormValues, { flatten = false } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = pdf.getForm();
  if (form.hasXFA()) throw new Error('This PDF uses an XFA form, which OpenDraft cannot fill. Fill it in a viewer that supports XFA.');
  if (form.getFields().some(field => field instanceof PDFSignature && field.acroField.dict.has(PDFName.of('V')))) throw new Error('This PDF is signed; filling it would invalidate the signature.');
  const before = new Map((await readFormFields(bytes)).fields.map(item => [item.name, item.value]));
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) throw new Error(`Form field "${name}" does not exist.`);
    if (field.isReadOnly() && JSON.stringify(before.get(name)) !== JSON.stringify(value)) throw new Error(`Form field "${name}" is read-only.`);
    if (field instanceof PDFTextField) {
      if (typeof value !== 'string') throw new Error(`Form field "${name}" needs text.`);
      const max = field.getMaxLength();
      if (max !== undefined && value.length > max) throw new Error(`Form field "${name}" allows at most ${max} characters.`);
      field.setText(value || undefined);
    } else if (field instanceof PDFCheckBox) {
      if (typeof value !== 'boolean') throw new Error(`Form field "${name}" needs checked or unchecked.`);
      if (value) field.check(); else field.uncheck();
    } else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown) {
      if (typeof value !== 'string' || (value && !field.getOptions().includes(value))) throw new Error(`"${value}" is not an option of form field "${name}".`);
      if (field instanceof PDFRadioGroup) { if (value) field.select(value); else field.clear(); }
      else if (value) field.select(value); else field.clear();
    } else if (field instanceof PDFOptionList) {
      const list = Array.isArray(value) ? value : [];
      if (!Array.isArray(value) || list.some(item => !field.getOptions().includes(item)) || (!field.isMultiselect() && list.length > 1)) throw new Error(`Invalid selection for list field "${name}".`);
      if (list.length) field.select(list); else field.clear();
    } else throw new Error(`Form field "${name}" cannot be filled.`);
  }
  form.updateFieldAppearances(await pdf.embedFont(StandardFonts.Helvetica));
  if (flatten) form.flatten();
  return pdf.save();
}

export type NewField = { type: 'text' | 'multiline' | 'checkbox' | 'dropdown' | 'signature'; name: string; pageIndex: number; rect: [number, number, number, number]; options?: string[] };

/** Adds one AcroForm field to a copy. Names must be unique; signature fields are left unsigned. */
export async function addFormField(bytes: Uint8Array, field: NewField): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = pdf.getForm();
  if (form.hasXFA()) throw new Error('This PDF uses an XFA form; fields cannot be added.');
  const name = field.name.trim();
  if (!name || name.length > 120 || /[.\u0000-\u001f]/.test(name)) throw new Error('Field names need 1–120 characters, without periods or control characters.');
  if (form.getFieldMaybe(name)) throw new Error(`A field named "${name}" already exists.`);
  if (!Number.isInteger(field.pageIndex) || field.pageIndex < 0 || field.pageIndex >= pdf.getPageCount()) throw new Error('Field page does not exist.');
  const [x1, y1, x2, y2] = field.rect;
  if (![x1, y1, x2, y2].every(Number.isFinite)) throw new Error('Field box needs four numbers.');
  const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  if (box.width < 8 || box.height < 8) throw new Error('Field box must be at least 8 x 8 points.');
  const page = pdf.getPage(field.pageIndex), media = page.getMediaBox();
  if (box.x < media.x || box.y < media.y || box.x + box.width > media.x + media.width || box.y + box.height > media.y + media.height) throw new Error('Field box must lie on the page.');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  if (field.type === 'text' || field.type === 'multiline') {
    const text = form.createTextField(name); if (field.type === 'multiline') text.enableMultiline();
    text.addToPage(page, { ...box, font });
  } else if (field.type === 'checkbox') form.createCheckBox(name).addToPage(page, box);
  else if (field.type === 'dropdown') {
    const options = (field.options ?? []).map(option => option.trim()).filter(Boolean);
    if (!options.length || new Set(options).size !== options.length || options.length > 200) throw new Error('A dropdown needs 1–200 distinct options.');
    const dropdown = form.createDropdown(name); dropdown.addOptions(options); dropdown.addToPage(page, { ...box, font });
  } else if (field.type === 'signature') {
    // pdf-lib has no signature-field builder: write a standard unsigned /Sig widget.
    const widget = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFHexString.fromText(name), Rect: [box.x, box.y, box.x + box.width, box.y + box.height], F: 4, P: page.ref, MK: { BC: [0.2, 0.3, 0.5] } }));
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (annots) annots.push(widget); else page.node.set(PDFName.of('Annots'), pdf.context.obj([widget]));
    form.acroForm.addField(widget);
  } else throw new Error('Unsupported field type.');
  return pdf.save();
}
