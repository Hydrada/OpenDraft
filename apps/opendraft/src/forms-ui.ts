import { addFormField, fillForm, readFormFields, type FormField, type FormValues, type NewField } from './pdf-forms';

type Options = {
  document: () => { name: string; bytes: Uint8Array; pageIndex: number } | undefined;
  /** Shows a PDF that gained a field: replaces the current form-design tab or opens one. */
  showDesigned: (bytes: Uint8Array, name: string) => Promise<void>;
  download: (bytes: Uint8Array, name: string) => void;
  error: (message: string) => void;
};

/** Form panel: lists the open PDF's fields, collects values and saves a filled (optionally flattened) copy. */
export function mountForms(container: HTMLElement, options: Options) {
  container.innerHTML = '<h3>Form fields</h3>';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-label', 'Form status');
  const list = document.createElement('div'); list.className = 'markup-form';
  const flatten = document.createElement('input'); flatten.type = 'checkbox'; flatten.setAttribute('aria-label', 'Flatten filled fields');
  const flattenLabel = document.createElement('label'); flattenLabel.append(flatten, ' Flatten filled fields (no longer editable)');
  const save = document.createElement('button'); save.textContent = 'Save filled form copy';
  const inputs = new Map<string, () => string | boolean | string[]>();
  let loadedFor: Uint8Array | undefined;

  const control = (field: FormField) => {
    const label = document.createElement('label'); label.textContent = field.name + (field.readOnly ? ' (read-only)' : '');
    let element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (field.type === 'checkbox') { const box = document.createElement('input'); box.type = 'checkbox'; box.checked = field.value; element = box; inputs.set(field.name, () => box.checked); }
    else if (field.type === 'text') {
      const text = field.multiline ? document.createElement('textarea') : document.createElement('input');
      text.value = field.value; if (field.maxLength !== undefined) text.maxLength = field.maxLength; element = text; inputs.set(field.name, () => text.value);
    } else {
      const select = document.createElement('select'); select.multiple = field.type === 'list' && field.multiple;
      if (field.type !== 'list') select.append(new Option('(none)', ''));
      for (const option of field.options) select.append(new Option(option, option, false, Array.isArray(field.value) ? field.value.includes(option) : field.value === option));
      element = select;
      inputs.set(field.name, () => field.type === 'list' ? Array.from(select.selectedOptions, option => option.value) : select.value);
    }
    element.setAttribute('aria-label', `Form field ${field.name}`); element.disabled = field.readOnly;
    label.append(element); return label;
  };
  const load = async () => {
    const doc = options.document();
    if (doc?.bytes === loadedFor) return;
    loadedFor = doc?.bytes; inputs.clear(); list.replaceChildren();
    if (!doc) { status.textContent = 'Open a PDF to see its form fields.'; save.disabled = true; return; }
    try {
      const { fields, xfa } = await readFormFields(doc.bytes);
      if (doc.bytes !== loadedFor) return;
      list.append(...fields.map(control));
      save.disabled = !fields.length || xfa;
      status.textContent = xfa ? 'This PDF uses an XFA form, which OpenDraft cannot fill.' : fields.length ? `${fields.length} fillable field(s).` : 'This PDF has no fillable form fields.';
    } catch (e) { status.textContent = `Could not read form fields: ${e instanceof Error ? e.message : String(e)}`; save.disabled = true; }
  };
  save.onclick = async () => {
    const doc = options.document(); if (!doc) return;
    save.disabled = true;
    try {
      const values: FormValues = {}; for (const [name, read] of inputs) values[name] = read();
      options.download(await fillForm(doc.bytes, values, { flatten: flatten.checked }), `${doc.name.replace(/\.pdf$/i, '')}-filled.pdf`);
      status.textContent = `Saved a filled copy${flatten.checked ? ' with flattened fields' : ''}. The open document is unchanged.`;
    } catch (e) { const message = e instanceof Error ? e.message : String(e); status.textContent = message; options.error(message); }
    finally { save.disabled = false; }
  };
  // Field design: adds a field to a copy shown in a "(form design)" tab.
  const design = document.createElement('fieldset'); design.innerHTML = '<legend>Add a form field on the current page</legend>';
  const typeSelect = document.createElement('select'); typeSelect.setAttribute('aria-label', 'New field type');
  for (const [value, label] of [['text', 'Text'], ['multiline', 'Multi-line text'], ['checkbox', 'Checkbox'], ['dropdown', 'Dropdown'], ['signature', 'Signature (unsigned)']]) typeSelect.append(new Option(label, value));
  const newName = document.createElement('input'); newName.setAttribute('aria-label', 'New field name');
  const newBox = document.createElement('input'); newBox.setAttribute('aria-label', 'New field box (x1,y1;x2,y2 in PDF units)'); newBox.value = '40,40;240,64';
  const newOptions = document.createElement('input'); newOptions.setAttribute('aria-label', 'Dropdown options (comma separated)');
  const add = document.createElement('button'); add.textContent = 'Add form field';
  for (const [text, element] of [['Type', typeSelect], ['Name', newName], ['Box (x1,y1;x2,y2)', newBox], ['Dropdown options', newOptions]] as const) { const row = document.createElement('label'); row.textContent = text; row.append(element); design.append(row); }
  design.append(add);
  add.onclick = async () => {
    const doc = options.document(); if (!doc) return;
    add.disabled = true;
    try {
      const pairs = newBox.value.split(';').map(pair => pair.split(',').map(Number));
      if (pairs.length !== 2 || pairs.some(pair => pair.length !== 2 || !pair.every(Number.isFinite))) throw new Error('Enter the field box as x1,y1;x2,y2.');
      const field: NewField = { type: typeSelect.value as NewField['type'], name: newName.value, pageIndex: doc.pageIndex, rect: [pairs[0][0], pairs[0][1], pairs[1][0], pairs[1][1]], options: newOptions.value.split(',') };
      const bytes = await addFormField(doc.bytes, field);
      const name = /\(form design\)\.pdf$/i.test(doc.name) ? doc.name : `${doc.name.replace(/\.pdf$/i, '')} (form design).pdf`;
      await options.showDesigned(bytes, name);
      newName.value = '';
      status.textContent = `Added field "${field.name.trim()}". Save PDF to keep the form.`;
    } catch (e) { const message = e instanceof Error ? e.message : String(e); status.textContent = message; options.error(message); }
    finally { add.disabled = false; }
  };
  container.append(list, flattenLabel, save, design, status);
  void load();
  return { refresh: () => void load() };
}
