import {PDFDocument} from 'pdf-lib';
import {exportPdf} from './document.ts';
import {assemblePdf, validatePages, type PageRef} from './organization.ts';
import {applyMarkups, type Markup} from './annotations.ts';
import {validateMarkupLayers, type MarkupLayer} from './markup-layers.ts';
import {assertEditablePdf} from './document-safety.ts';

/** Rebuild from immutable sources and the complete edit state, never from a prior edited export. */
export async function materializeWorkspace(
  sources:ReadonlyMap<string,Uint8Array>,
  pages:readonly PageRef[],
  markups:readonly Markup[],
  flatten=false,
  layers:readonly MarkupLayer[]=[],
):Promise<Uint8Array>{
  layers=validateMarkupLayers(layers);
  pages=validatePages(pages);
  if(!pages.length)throw new Error('A document must contain at least one page.');
  const first=sources.get(pages[0].sourceId);
  if(!first)throw new Error('Missing original PDF source.');
  const original=await PDFDocument.load(first,{updateMetadata:false});
  const originalLayout=original.getPageCount()===pages.length&&pages.every((page,index)=>page.sourceId===pages[0].sourceId&&page.pageIndex===index&&!page.replacement&&!page.inserted);
  const unchanged=originalLayout&&pages.every(page=>page.rotation===0)&&markups.length===0&&layers.length===0;
  if(unchanged)return first.slice();
  // A signature image is not a digital signature. Never imply that a rewrite retains certification.
  for(const id of new Set(pages.flatMap(page=>[page.sourceId,...(page.replacement?[page.replacement.sourceId]:[])]))){
    const bytes=sources.get(id);if(!bytes)throw new Error(`Missing PDF source: ${id}`);
    await assertEditablePdf(bytes);
  }
  const base=originalLayout
    ?await exportPdf(first,new Map(pages.map((page,index)=>[index+1,page.rotation])))
    :await assemblePdf(sources,pages);
  return markups.length||layers.length?applyMarkups(base,markups,{flatten,layers}):base;
}
