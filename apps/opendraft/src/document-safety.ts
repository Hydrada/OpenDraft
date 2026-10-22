import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';

export type PdfSafety = {
  signed: boolean;
  hasSignatureFields: boolean;
  hasForms: boolean;
  hasXfa: boolean;
  hasBookmarks: boolean;
  hasAttachments: boolean;
  hasLayers: boolean;
  hasActions: boolean;
  warnings: string[];
};

/** Structural preservation inspection only. This does not validate signatures or certify PDF safety. */
export async function inspectPdfSafety(bytes: Uint8Array): Promise<PdfSafety> {
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (error) {
    if (error instanceof Error && /encrypted/i.test(error.message)) throw new Error('Encrypted PDF editing is unsupported. Keep the original; encryption is never bypassed.');
    throw new Error(`Could not inspect PDF preservation requirements: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result: PdfSafety = { signed:false,hasSignatureFields:false,hasForms:false,hasXfa:false,hasBookmarks:false,hasAttachments:false,hasLayers:false,hasActions:false,warnings:[] };
  const key = (name: string) => PDFName.of(name);
  const lookup = (object: PDFObject | undefined): PDFObject | undefined => object ? pdf.context.lookup(object) : undefined;
  const read = (dictionary: PDFDict, name: string) => lookup(dictionary.get(key(name)));
  const present = (dictionary: PDFDict, name: string) => { const value = read(dictionary,name); return value !== undefined && value !== PDFNull; };
  const isName = (value: PDFObject | undefined, name: string) => value instanceof PDFName && value.asString() === `/${name}`;
  const names = read(pdf.catalog,'Names');
  const permissions = read(pdf.catalog,'Perms');
  result.signed = permissions instanceof PDFDict && present(permissions,'DocMDP');
  result.hasBookmarks = present(pdf.catalog,'Outlines');
  result.hasLayers = present(pdf.catalog,'OCProperties');
  result.hasAttachments = present(pdf.catalog,'AF') || (names instanceof PDFDict && present(names,'EmbeddedFiles'));
  result.hasActions = present(pdf.catalog,'OpenAction') || present(pdf.catalog,'AA') || (names instanceof PDFDict && present(names,'JavaScript'));
  const acroForm = read(pdf.catalog,'AcroForm');
  if (acroForm instanceof PDFDict) {
    result.hasXfa = present(acroForm,'XFA');
    const fields = read(acroForm,'Fields');
    const queue: Array<{ object:PDFObject; fieldType?:PDFObject; fieldValue?:PDFObject }> = [];
    if (fields instanceof PDFArray) for (let n=0;n<fields.size();n++) queue.push({object:fields.get(n)});
    const visited = new Set<PDFDict>();
    for (let n=0;n<queue.length;n++) {
      const item = queue[n];
      const field = lookup(item.object);
      if (!(field instanceof PDFDict) || visited.has(field)) continue;
      visited.add(field);
      const fieldType = read(field,'FT') ?? item.fieldType;
      const fieldValue = read(field,'V') ?? item.fieldValue;
      if (isName(fieldType,'Sig')) {
        result.hasSignatureFields = true;
        if (fieldValue instanceof PDFDict && (isName(read(fieldValue,'Type'),'Sig') || present(fieldValue,'ByteRange') || present(fieldValue,'Contents'))) result.signed = true;
      } else if (fieldType instanceof PDFName) result.hasForms = true;
      if (present(field,'AA') || present(field,'A')) result.hasActions = true;
      const kids = read(field,'Kids');
      if (kids instanceof PDFArray) for (let k=0;k<kids.size();k++) queue.push({object:kids.get(k),fieldType,fieldValue});
    }
  }
  let annotations = false;
  for (const page of pdf.getPages()) {
    if (present(page.node,'AA') || present(page.node,'A')) result.hasActions = true;
    if (present(page.node,'AF')) result.hasAttachments = true;
    const annots = read(page.node,'Annots');
    if (annots instanceof PDFArray && annots.size()) {
      annotations = true;
      for (let n=0;n<annots.size();n++) {
        const annotation = lookup(annots.get(n));
        if (!(annotation instanceof PDFDict)) continue;
        if (present(annotation,'A') || present(annotation,'AA')) result.hasActions = true;
        if (isName(read(annotation,'Subtype'),'FileAttachment')) result.hasAttachments = true;
      }
    }
  }
  // Enumerate parsed dictionaries, never regex-scan content bytes. An apparent signature
  // marker conservatively blocks rewriting; it does not establish cryptographic validity.
  for (const [,object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (present(object,'ByteRange')) result.signed = true;
    if (isName(read(object,'FT'),'Sig')) result.hasSignatureFields = true;
    if (present(object,'JS') || isName(read(object,'S'),'JavaScript') || present(object,'AA') || present(object,'A')) result.hasActions = true;
    if (isName(read(object,'Subtype'),'FileAttachment')) result.hasAttachments = true;
  }
  if (result.signed) result.warnings.push('Apparent signature or certification markers found. Rewriting may invalidate signatures; validity has not been checked.');
  else if (result.hasSignatureFields) result.warnings.push('Empty signature fields found. Page copying may discard these fields; no signed value was detected.');
  if (result.hasForms) result.warnings.push('Form fields may be lost or disconnected by page organization.');
  if (result.hasXfa) result.warnings.push('XFA forms are unsupported and cannot be safely preserved by this editor.');
  if (result.hasBookmarks) result.warnings.push('Extraction, deletion and merging may omit document bookmarks; full single-source reordering retains the catalog.');
  if (result.hasAttachments) result.warnings.push('Embedded or associated files may not be preserved by page organization.');
  if (result.hasLayers) result.warnings.push('Extraction, deletion and merging may omit source layer configuration; full single-source reordering retains the catalog.');
  if (result.hasActions) result.warnings.push('Document, page or annotation actions found. They are not executed by OpenDraft; preservation is not guaranteed.');
  if (annotations) result.warnings.push('Annotations found. Appearance and links require independent export verification.');
  return result;
}

export async function assertEditablePdf(bytes: Uint8Array): Promise<PdfSafety> {
  const safety = await inspectPdfSafety(bytes);
  if (safety.signed) throw new Error('Editing is blocked because apparent PDF signature or certification markers were found. Rewriting can invalidate signatures; preserve the original. Signature validity has not been checked.');
  if (safety.hasXfa) throw new Error('Editing is blocked because XFA forms cannot be safely preserved. Keep the original document.');
  return safety;
}
