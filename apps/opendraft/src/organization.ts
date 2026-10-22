import { PDFDocument, PDFObjectCopier, PDFName, PDFDict, PDFArray, PDFNumber, PDFHexString, PDFRef, PDFStream, PDFPage, degrees } from 'pdf-lib';
import { assertEditablePdf } from './document-safety.ts';

/** Source page index is zero based; rotation is a clockwise delta from its original rotation. */
export type PageRef = { sourceId: string; pageIndex: number; rotation: number; replacement?: {sourceId: string; pageIndex: number}; inserted?: true; label?: string };

export function validatePages(pages: readonly PageRef[]): PageRef[] {
  if (!Array.isArray(pages) || !pages.length) throw new Error('A document must contain at least one page.');
  return pages.map(page => {
    if (!page || typeof page.sourceId !== 'string' || !page.sourceId.trim()) throw new Error('A page must identify its source document.');
    if (!Number.isInteger(page.pageIndex) || page.pageIndex < 0) throw new Error('Page index must be a non-negative integer.');
    if (!Number.isFinite(page.rotation) || page.rotation % 90 !== 0) throw new Error('Rotation must be a multiple of 90 degrees.');
    if (page.inserted !== undefined && page.inserted !== true) throw new Error('Inserted page flag must be true when present.');
    if (page.label !== undefined && (!page.inserted || typeof page.label !== 'string' || !page.label.trim() || page.label.length > 1000)) throw new Error('Only inserted pages may have a nonempty label of at most 1000 characters.');
    const replacement = page.replacement;
    if (replacement !== undefined && (!replacement || typeof replacement.sourceId !== 'string' || !replacement.sourceId.trim() || !Number.isInteger(replacement.pageIndex) || replacement.pageIndex < 0)) throw new Error('Replacement must identify a source document and non-negative page index.');
    return { sourceId: page.sourceId, pageIndex: page.pageIndex, rotation: ((page.rotation % 360) + 360) % 360, ...(replacement ? {replacement: {sourceId: replacement.sourceId, pageIndex: replacement.pageIndex}} : {}), ...(page.inserted ? {inserted: true as const, ...(page.label !== undefined ? {label: page.label} : {})} : {}) };
  });
}

/**
 * Full single-source permutations retain original page references and catalog.
 * Partial/multi-source page copying preserves only primary-source Info/XMP metadata;
 * bookmarks, attachments, layers, forms and cross-document links remain unsupported there.
 * Primary means the first used source in the caller's source-map insertion order.
 * Sources are never mutated; apparent signed/certified, XFA and encrypted rewrites reject.
 */
export async function assemblePdf(sources: ReadonlyMap<string, Uint8Array>, pages: readonly PageRef[]): Promise<Uint8Array> {
  const refs = validatePages(pages);
  const loaded = new Map<string, PDFDocument>();
  for (const page of refs) for (const ref of [page, ...(page.replacement ? [page.replacement] : [])]) {
    if (!loaded.has(ref.sourceId)) {
      const bytes = sources.get(ref.sourceId);
      if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error(`Missing PDF source: ${ref.sourceId}`);
      await assertEditablePdf(bytes);
      loaded.set(ref.sourceId, await PDFDocument.load(bytes,{updateMetadata:false}));
    }
    if (ref.pageIndex >= loaded.get(ref.sourceId)!.getPageCount()) throw new Error('Page index is outside the source document.');
  }
  for (const ref of refs) {
    const donor = ref.replacement ?? (ref.inserted ? ref : undefined);
    if (donor && loaded.get(donor.sourceId)!.catalog.has(PDFName.of('OCProperties'))) throw new Error('Replacement or inserted drawings with PDF layers are unsupported; optional-content configurations cannot be merged safely.');
  }
  const baseRefs = refs.filter(ref => !ref.inserted);
  const baseIds = new Set(baseRefs.map(ref => ref.sourceId));
  if (baseIds.size === 1) {
    const source = loaded.get(baseRefs[0].sourceId)!;
    if (baseRefs.length === source.getPageCount() && new Set(baseRefs.map(ref => ref.pageIndex)).size === baseRefs.length) {
      const originals = source.getPages();
      // Reparenting would otherwise discard attributes inherited from nested page-tree nodes.
      for (const page of originals) for (const key of ['Resources','MediaBox','CropBox','Rotate']) {
        const name = PDFName.of(key), value = page.node.getInheritableAttribute(name);
        if (value !== undefined) page.node.set(name,value);
      }
      // Capture every donor before changing any target (including same-document swaps).
      const prepared = refs.map(ref => {
        const donor = ref.replacement ?? (ref.inserted ? ref : undefined);
        return donor ? prepareReplacement(loaded.get(donor.sourceId)!, donor.pageIndex) : undefined;
      });
      const orderedPages = refs.map((ref, index) => {
        const page = ref.inserted ? PDFPage.create(source) : originals[ref.pageIndex];
        if (prepared[index]) replaceDrawing(source, page, prepared[index]!);
        return page;
      });
      remapPageLabels(source, refs);
      remapNumericDestinations(source, refs);
      for (let index = originals.length - 1; index >= 0; index--) source.removePage(index);
      for (let index=0; index<refs.length; index++) {
        const ref = refs[index], page = orderedPages[index];
        page.setRotation(degrees(((page.getRotation().angle + ref.rotation) % 360 + 360) % 360));
        source.addPage(page);
      }
      return source.save({updateFieldAppearances:false});
    }
  }
  const output = await PDFDocument.create({updateMetadata:false});
  const primaryId = [...sources.keys()].find(id => baseIds.has(id)) ?? refs[0].sourceId;
  const primary = loaded.get(primaryId)!;
  const copier = PDFObjectCopier.for(primary.context,output.context);
  if (primary.context.trailerInfo.Info) output.context.trailerInfo.Info = copier.copy(primary.context.trailerInfo.Info);
  const metadata = primary.catalog.get(PDFName.of('Metadata'));
  if (metadata) output.catalog.set(PDFName.of('Metadata'),copier.copy(metadata));
  // Copy each source's requested pages in one operation, retaining requested duplicates.
  const copies = new Map<string, Awaited<ReturnType<PDFDocument['copyPages']>>>();
  for (const [sourceId, source] of loaded) {
    if (!baseIds.has(sourceId)) continue;
    copies.set(sourceId, await output.copyPages(source, refs.filter(ref => !ref.inserted && ref.sourceId === sourceId).map(ref => ref.pageIndex)));
  }
  const positions = new Map<string, number>();
  for (const ref of refs) {
    const position = positions.get(ref.sourceId) ?? 0;
    const page = ref.inserted ? PDFPage.create(output) : copies.get(ref.sourceId)![position];
    if (!ref.inserted) positions.set(ref.sourceId, position + 1);
    const donor = ref.replacement ?? (ref.inserted ? ref : undefined);
    if (donor) replaceDrawing(output, page, prepareReplacement(loaded.get(donor.sourceId)!, donor.pageIndex));
    page.setRotation(degrees(((page.getRotation().angle + ref.rotation) % 360 + 360) % 360));
    output.addPage(page);
  }
  return output.save({updateFieldAppearances:false});
}

const DRAWING_KEYS = ['Contents','Resources','MediaBox','CropBox','BleedBox','TrimBox','ArtBox','Rotate','UserUnit','Group'] as const;
/** A detached donor graph ensures same-document swaps cannot observe earlier replacements. */
function prepareReplacement(source: PDFDocument, index: number) {
  const page = source.getPage(index);
  const values = new Map<PDFName, ReturnType<typeof page.node.get>>();
  for (const key of DRAWING_KEYS) {
    const name = PDFName.of(key);
    values.set(name, ['Resources','MediaBox','CropBox','Rotate'].includes(key) ? page.node.getInheritableAttribute(name) : page.node.get(name));
  }
  // Defaults must be explicit so a target's old page-tree inheritance cannot leak in.
  if (values.get(PDFName.of('CropBox')) === undefined) values.set(PDFName.of('CropBox'), values.get(PDFName.of('MediaBox')));
  if (values.get(PDFName.of('Rotate')) === undefined) values.set(PDFName.of('Rotate'), PDFNumber.of(0));
  if (values.get(PDFName.of('Resources')) === undefined) values.set(PDFName.of('Resources'), source.context.obj({}));
  return {source, page, values};
}
function replaceDrawing(output: PDFDocument, target: PDFPage, donor: ReturnType<typeof prepareReplacement>) {
  const copier = PDFObjectCopier.for(donor.source.context, output.context);
  const originalEntries = donor.page.node.entries();
  const sourceObjects = [...donor.values.values()].filter(value => value !== undefined);
  // Page back-references in resource graphs may point to the selected donor page,
  // but importing an unrelated page through a resource is not a supported merge.
  const visited = new Set<unknown>();
  const inspect = (value: unknown) => {
    const object = donor.source.context.lookup(value as Parameters<typeof donor.source.context.lookup>[0]);
    if (!object || visited.has(object)) return;
    visited.add(object); if (visited.size > 100000) throw new Error('Replacement resource graph exceeds its traversal budget.');
    if (object instanceof PDFDict && object.get(PDFName.of('Type'))?.toString() === '/Page') {
      if (object !== donor.page.node) throw new Error('Replacement resources reference another page; cross-page resource dependencies are unsupported.');
      return;
    }
    if (object instanceof PDFDict) for (const [, child] of object.entries()) inspect(child);
    else if (object instanceof PDFArray) for (const child of object.asArray()) inspect(child);
    else if (object instanceof PDFStream) inspect(object.dict);
  };
  for (const value of sourceObjects) inspect(value);
  const copied = new Map<PDFName, ReturnType<typeof target.node.get>>();
  let donorRef: PDFRef | undefined;
  try {
    // A resource /P may lead back to the donor page. Strip all non-drawing keys
    // during copy so this cannot import donor annotations/actions or its page tree.
    for (const [key] of originalEntries) donor.page.node.delete(key);
    donor.page.node.set(PDFName.of('Type'), PDFName.of('Page'));
    for (const [name, value] of donor.values) if (value !== undefined) donor.page.node.set(name, value);
    for (const [name, value] of donor.values) copied.set(name, value === undefined ? undefined : copier.copy(value));
    donorRef = copier.copy(donor.page.ref) as PDFRef;
  } finally {
    for (const [key] of donor.page.node.entries()) donor.page.node.delete(key);
    for (const [key, value] of originalEntries) donor.page.node.set(key, value);
  }
  const repaired = new Set<unknown>();
  const repair = (value: unknown) => {
    const object = output.context.lookup(value as Parameters<typeof output.context.lookup>[0]);
    if (!object || repaired.has(object)) return;
    repaired.add(object);
    if (object instanceof PDFDict) for (const [key, child] of object.entries()) {
      if (child === donorRef) object.set(key, target.ref); else repair(child);
    }
    else if (object instanceof PDFArray) for (let i=0;i<object.size();i++) { const child=object.get(i); if(child===donorRef)object.set(i,target.ref);else repair(child); }
    else if (object instanceof PDFStream) repair(object.dict);
  };
  for (const value of copied.values()) if (value !== undefined) repair(value);
  for (const [name, value] of copied) { if (value === undefined) target.node.delete(name); else target.node.set(name, value); }
}

/** Preserve each original page's label, including its running style number, after a permutation. */
function remapPageLabels(pdf:PDFDocument, refs:readonly PageRef[]):void {
  const root = pdf.catalog.lookupMaybe(PDFName.of('PageLabels'),PDFDict);
  if (!root && !refs.some(ref => ref.inserted)) return;
  const originalCount = pdf.getPageCount();
  const labels = new Map<number,PDFDict>(), seen = new Set<PDFDict>();
  const visit = (node:PDFDict) => {
    if (seen.has(node) || seen.size > 10000) throw new Error('Invalid cyclic or excessive PDF page-label tree.');
    seen.add(node);
    const nums = node.lookupMaybe(PDFName.of('Nums'),PDFArray);
    if (nums) {
      if (nums.size()%2) throw new Error('Invalid PDF page-label number tree.');
      for (let i=0;i<nums.size();i+=2) {
        const index = nums.lookup(i,PDFNumber).asNumber(), value=nums.lookup(i+1,PDFDict);
        if (!Number.isSafeInteger(index)||index<0||index>=originalCount||labels.has(index)) throw new Error('Invalid PDF page-label index.');
        labels.set(index,value);
      }
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'),PDFArray);
    if (kids) for (let i=0;i<kids.size();i++) visit(kids.lookup(i,PDFDict));
  };
  if (root) visit(root);
  const ordered = [...labels.keys()].sort((a,b)=>a-b);
  if (root && (!ordered.length || ordered[0] !== 0)) throw new Error('PDF page labels must define their first page.');
  const nums = pdf.context.obj([]) as PDFArray;
  for (let index=0;index<refs.length;index++) {
    const ref = refs[index], originalIndex=ref.pageIndex;
    if (ref.inserted) {
      nums.push(PDFNumber.of(index)); nums.push(pdf.context.obj({P: PDFHexString.fromText(ref.label ?? `Revision page ${ref.pageIndex + 1}`)}));
      continue;
    }
    if (!root) {
      nums.push(PDFNumber.of(index)); nums.push(pdf.context.obj({S:'D',St:originalIndex+1}));
      continue;
    }
    let low=0,high=ordered.length-1;
    while(low<high){const middle=Math.ceil((low+high)/2);if(ordered[middle]<=originalIndex)low=middle;else high=middle-1;}
    const start=ordered[low];
    const label=labels.get(start)!.clone(pdf.context);
    if (label.has(PDFName.of('S'))) {
      const number=label.lookupMaybe(PDFName.of('St'),PDFNumber)?.asNumber()??1;
      if (!Number.isSafeInteger(number)||number<1||!Number.isSafeInteger(number+originalIndex-start)) throw new Error('Invalid PDF page-label starting number.');
      label.set(PDFName.of('St'),PDFNumber.of(number+originalIndex-start));
    }
    nums.push(PDFNumber.of(index));nums.push(label);
  }
  pdf.catalog.set(PDFName.of('PageLabels'),pdf.context.obj({Nums:nums}));
}

/** Legacy numeric local destinations need index remapping; page-reference destinations stay unchanged. */
function remapNumericDestinations(pdf:PDFDocument, refs:readonly PageRef[]):void {
  const positions = new Map(refs.flatMap((ref,index)=>ref.inserted?[]:[[ref.pageIndex,index]])), remapped = new Set<PDFArray>();
  const destination = (value:unknown) => {
    const object=pdf.context.lookup(value as Parameters<typeof pdf.context.lookup>[0]);
    if (!(object instanceof PDFArray)||remapped.has(object)||!object.size()) return;
    remapped.add(object);
    const first=object.lookup(0);
    if (first instanceof PDFNumber) {
      const index=first.asNumber();
      if (!Number.isSafeInteger(index)||!positions.has(index)) throw new Error('Invalid numeric local PDF destination.');
      object.set(0,PDFNumber.of(positions.get(index)!));
    }
  };
  const seen = new Set<PDFDict|PDFArray>();
  const visit = (value:unknown) => {
    const object=pdf.context.lookup(value as Parameters<typeof pdf.context.lookup>[0]);
    if (!(object instanceof PDFDict)&&!(object instanceof PDFArray)||seen.has(object)) return;
    if (seen.size>100000) throw new Error('PDF destination graph exceeds its traversal budget.');
    seen.add(object);
    if (object instanceof PDFDict) {
      if (object.has(PDFName.of('Dest'))) destination(object.get(PDFName.of('Dest')));
      if (object.get(PDFName.of('S'))?.toString()==='/GoTo') destination(object.get(PDFName.of('D')));
      for (const [,child] of object.entries()) visit(child);
    } else for (const child of object.asArray()) visit(child);
  };
  destination(pdf.catalog.get(PDFName.of('OpenAction')));
  const named = pdf.catalog.lookupMaybe(PDFName.of('Dests'),PDFDict);
  if (named) for (const [,value] of named.entries()) {
    const resolved=pdf.context.lookup(value);
    destination(resolved instanceof PDFDict?resolved.get(PDFName.of('D')):resolved);
  }
  const names=pdf.catalog.lookupMaybe(PDFName.of('Names'),PDFDict);
  const tree=names?.lookupMaybe(PDFName.of('Dests'),PDFDict), nameSeen=new Set<PDFDict>();
  const namedTree=(node:PDFDict)=>{
    if (nameSeen.has(node)||nameSeen.size>10000) throw new Error('Invalid PDF destination name tree.');
    nameSeen.add(node);
    const entries=node.lookupMaybe(PDFName.of('Names'),PDFArray);
    if (entries) {
      if (entries.size()%2) throw new Error('Invalid PDF destination name entries.');
      for(let i=1;i<entries.size();i+=2){const value=entries.lookup(i);destination(value instanceof PDFDict?value.get(PDFName.of('D')):value);}
    }
    const kids=node.lookupMaybe(PDFName.of('Kids'),PDFArray);
    if(kids)for(let i=0;i<kids.size();i++)namedTree(kids.lookup(i,PDFDict));
  };
  if(tree)namedTree(tree);
  visit(pdf.catalog);
}

/** In-memory command history. Persistence is the caller's responsibility. */
export class PageHistory {
  private states: PageRef[][];
  private cursor = 0;
  constructor(initial: readonly PageRef[]) { this.states = [validatePages(initial)]; }
  get pages(): PageRef[] { return validatePages(this.states[this.cursor]); }
  get canUndo(): boolean { return this.cursor > 0; }
  get canRedo(): boolean { return this.cursor < this.states.length - 1; }
  commit(next: readonly PageRef[]): void {
    const value = validatePages(next);
    if (JSON.stringify(value) === JSON.stringify(this.states[this.cursor])) return;
    this.states.splice(this.cursor + 1);
    this.states.push(value);
    if (this.states.length > 101) this.states.shift();
    this.cursor = this.states.length - 1;
  }
  undo(): void { if (this.canUndo) this.cursor--; }
  redo(): void { if (this.canRedo) this.cursor++; }
}
