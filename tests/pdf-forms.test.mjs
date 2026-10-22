import test from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fillForm, readFormFields } from '../apps/opendraft/src/pdf-forms.ts';
import { transmittalForm } from './form-fixture.mjs';

test('fields are listed with types, options and read-only state', async () => {
  const { fields, xfa } = await readFormFields(await transmittalForm());
  assert.equal(xfa, false);
  assert.deepEqual(fields.map(f => [f.name, f.type]), [['project', 'text'], ['notes', 'text'], ['sheet', 'text'], ['urgent', 'checkbox'], ['status', 'radio'], ['discipline', 'dropdown'], ['form number', 'text']]);
  assert.deepEqual(fields.find(f => f.name === 'discipline').options, ['Architectural', 'Mechanical', 'Electrical']);
  assert.equal(fields.find(f => f.name === 'form number').readOnly, true);
});

test('filled values are readable by pdf.js; flattening removes the fields but keeps the text visible', async () => {
  const values = { project: 'North Pump Station', notes: 'Line 1\nLine 2', sheet: 'M201', urgent: true, status: 'Revise', discipline: 'Mechanical' };
  const filled = await fillForm(await transmittalForm(), values);
  const reread = (await readFormFields(filled)).fields;
  assert.equal(reread.find(f => f.name === 'project').value, 'North Pump Station');
  assert.equal(reread.find(f => f.name === 'urgent').value, true);
  assert.equal(reread.find(f => f.name === 'status').value, 'Revise');
  const doc = await pdfjs.getDocument({ data: filled.slice() }).promise;
  const widgets = await (await doc.getPage(1)).getAnnotations();
  assert.equal(widgets.find(w => w.fieldName === 'project').fieldValue, 'North Pump Station');
  await doc.cleanup();
  const flat = await fillForm(await transmittalForm(), values, { flatten: true });
  assert.deepEqual((await readFormFields(flat)).fields, []);
  const flatDoc = await pdfjs.getDocument({ data: flat.slice() }).promise;
  const text = (await (await flatDoc.getPage(1)).getTextContent()).items.map(i => i.str).join(' ');
  assert.match(text, /North Pump Station/); assert.match(text, /M201/);
  await flatDoc.cleanup();
});

test('invalid values, unknown fields and read-only changes are refused', async () => {
  const form = await transmittalForm();
  await assert.rejects(fillForm(form, { nope: 'x' }), /does not exist/);
  await assert.rejects(fillForm(form, { sheet: 'TOO-LONG-NUMBER' }), /at most 6/);
  await assert.rejects(fillForm(form, { discipline: 'Plumbing' }), /not an option/);
  await assert.rejects(fillForm(form, { urgent: 'yes' }), /checked or unchecked/);
  await assert.rejects(fillForm(form, { 'form number': 'T-999' }), /read-only/);
  await fillForm(form, { 'form number': 'T-001' }); // unchanged read-only value is allowed
});

test('new fields of every type are added, listed and fillable; invalid definitions are refused', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const blank = await PDFDocument.create(); blank.addPage([600, 400]);
  const { addFormField } = await import('../apps/opendraft/src/pdf-forms.ts');
  let bytes = await blank.save();
  bytes = await addFormField(bytes, { type: 'text', name: 'Project', pageIndex: 0, rect: [40, 340, 300, 364] });
  bytes = await addFormField(bytes, { type: 'multiline', name: 'Remarks', pageIndex: 0, rect: [40, 200, 300, 320] });
  bytes = await addFormField(bytes, { type: 'checkbox', name: 'Urgent', pageIndex: 0, rect: [40, 160, 56, 176] });
  bytes = await addFormField(bytes, { type: 'dropdown', name: 'Discipline', pageIndex: 0, rect: [40, 120, 240, 144], options: ['Arch', 'Mech'] });
  bytes = await addFormField(bytes, { type: 'signature', name: 'Reviewer signature', pageIndex: 0, rect: [320, 40, 560, 100] });
  const { fields } = await readFormFields(bytes);
  assert.deepEqual(fields.map(f => [f.name, f.type]), [['Project', 'text'], ['Remarks', 'text'], ['Urgent', 'checkbox'], ['Discipline', 'dropdown']]);
  const filled = await fillForm(bytes, { Project: 'Pump Station', Discipline: 'Mech', Urgent: true });
  assert.equal((await readFormFields(filled)).fields.find(f => f.name === 'Discipline').value, 'Mech');
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getForm().getFields().length, 5); // signature field present, unsigned
  await assert.rejects(addFormField(bytes, { type: 'text', name: 'Project', pageIndex: 0, rect: [0, 0, 50, 20] }), /already exists/);
  await assert.rejects(addFormField(bytes, { type: 'dropdown', name: 'X', pageIndex: 0, rect: [0, 0, 50, 20], options: [] }), /1–200 distinct/);
  await assert.rejects(addFormField(bytes, { type: 'text', name: 'Y', pageIndex: 0, rect: [590, 390, 700, 420] }), /lie on the page/);
});
