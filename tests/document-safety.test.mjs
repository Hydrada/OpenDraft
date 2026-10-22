import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { inspectPdfSafety, assertEditablePdf } from '../apps/opendraft/src/document-safety.ts';

async function fixture(configure) {
  const pdf = await PDFDocument.create();
  pdf.addPage([612,792]);
  await configure?.(pdf);
  return pdf.save({useObjectStreams:false});
}

test('ordinary PDF and signature-looking content text are editable without false structural signature detection', async () => {
  const bytes = await fixture(pdf => pdf.getPage(0).drawText('/ByteRange [0 42] /FT /Sig'));
  const result = await assertEditablePdf(bytes);
  assert.equal(result.signed,false);
  assert.equal(result.hasSignatureFields,false);
  assert.deepEqual(result.warnings,[]);
});

test('nested empty signature field is distinct from populated signature dictionaries', async () => {
  for (const populated of [false,true]) {
    const bytes = await fixture(pdf => {
      const child = pdf.context.obj({T:PDFString.of('nested signature')});
      if (populated) child.set(PDFName.of('V'),pdf.context.register(pdf.context.obj({Type:'Sig',ByteRange:[0,12,25,30],Contents:PDFString.of('synthetic-not-a-real-signature')})));
      const parent = pdf.context.obj({FT:'Sig',Kids:[pdf.context.register(child)]});
      pdf.catalog.set(PDFName.of('AcroForm'),pdf.context.obj({Fields:[pdf.context.register(parent)]}));
    });
    const safety = await inspectPdfSafety(bytes);
    assert.equal(safety.hasSignatureFields,true);
    assert.equal(safety.signed,populated);
    assert.equal(safety.hasForms,false);
    if (populated) await assert.rejects(assertEditablePdf(bytes),/Signature validity has not been checked/);
    else assert.equal((await assertEditablePdf(bytes)).signed,false);
  }
});

test('certification dictionary and standalone ByteRange dictionaries conservatively block rewriting', async () => {
  for (const configure of [
    pdf => pdf.catalog.set(PDFName.of('Perms'),pdf.context.obj({DocMDP:pdf.context.register(pdf.context.obj({Type:'Sig'}))})),
    pdf => {pdf.context.register(pdf.context.obj({ByteRange:[0,3,5,10]}));}
  ]) {
    const bytes = await fixture(configure);
    assert.equal((await inspectPdfSafety(bytes)).signed,true);
    await assert.rejects(assertEditablePdf(bytes),/signature or certification/);
  }
});

test('forms, XFA, bookmarks, attachments, layers, actions and annotations are surfaced structurally', async () => {
  const bytes = await fixture(pdf => {
    // Build dictionaries directly: pdf-lib's high-level form API removes XFA.
    pdf.catalog.set(PDFName.of('AcroForm'),pdf.context.obj({Fields:[pdf.context.register(pdf.context.obj({FT:'Tx',T:PDFString.of('name')}))],XFA:PDFString.of('synthetic XFA')}));
    pdf.catalog.set(PDFName.of('Outlines'),pdf.context.obj({Type:'Outlines',Count:0}));
    pdf.catalog.set(PDFName.of('Names'),pdf.context.obj({EmbeddedFiles:{Names:[]},JavaScript:{Names:[]}}));
    pdf.catalog.set(PDFName.of('OCProperties'),pdf.context.obj({OCGs:[]}));
    pdf.getPage(0).node.set(PDFName.of('AA'),pdf.context.obj({O:{S:'JavaScript',JS:PDFString.of('throw new Error("must not execute")')}}));
    pdf.getPage(0).node.set(PDFName.of('Annots'),pdf.context.obj([pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Text',Rect:[0,0,10,10]}))]));
  });
  const safety = await inspectPdfSafety(bytes);
  for (const key of ['hasForms','hasXfa','hasBookmarks','hasAttachments','hasLayers','hasActions']) assert.equal(safety[key],true,key);
  assert.equal(safety.signed,false);
  assert.ok(safety.warnings.some(w=>w.includes('Annotations')));
  await assert.rejects(assertEditablePdf(bytes),/XFA forms cannot be safely preserved/);
});

test('encrypted and malformed inputs fail with preservation messages without bypassing encryption', async () => {
  const encrypted = await fixture(pdf => {pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({Filter:'Standard',V:1,R:2,Length:40}));});
  await assert.rejects(assertEditablePdf(encrypted),/Encrypted PDF editing is unsupported/);
  await assert.rejects(inspectPdfSafety(new TextEncoder().encode('not a PDF')),/Could not inspect PDF/);
});
