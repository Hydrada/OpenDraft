import { PDFDocument, PDFDict, PDFName, PDFHexString, PDFString, StandardFonts, StandardFontEmbedder, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';
import {PDFArray, PDFOperator, PDFOperatorNames} from 'pdf-lib';
import type { PDFFont, PDFRef } from 'pdf-lib';
import {validateMarkupLayers, type MarkupLayer} from './markup-layers.ts';
import {validateMarkupComments, type MarkupComment} from './markup-comments.ts';

export const STAMP_NAMES = ['Approved', 'Experimental', 'NotApproved', 'AsIs', 'Expired', 'NotForPublicRelease', 'Confidential', 'Final', 'Sold', 'Departmental', 'ForComment', 'TopSecret', 'Draft', 'ForPublicRelease'] as const;
export type StampName = typeof STAMP_NAMES[number];

export type MarkupKind = 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'highlight' | 'ink' | 'text' | 'cloud' | 'callout' | 'stamp';
/** Embedded stamp artwork (logo, seal image, or page 1 of a PDF). Base64 of the original bytes, at most 2 MB. */
export type StampImage = { format: 'png' | 'jpeg' | 'pdf'; data: string };
export type Markup = { image?: StampImage; id: string; pageIndex: number; kind: MarkupKind; points: [number, number][]; callout?: [number, number][]; stampName?: StampName; groupId?: string; layerId?: string; comments?: MarkupComment[]; color: [number, number, number]; width: number; opacity: number; contents: string; author: string; status: 'open' | 'accepted' | 'rejected'; locked: boolean; createdAt: string; modifiedAt: string };
const kinds: MarkupKind[] = ['rectangle', 'ellipse', 'line', 'arrow', 'highlight', 'ink', 'text', 'cloud', 'callout', 'stamp'];
const n = (value: number) => String(Math.round(value * 100000) / 100000);
const date = (value: string) => `D:${new Date(value).toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Number(value.slice(0, 4)) > 0;
}
function validate(mark: Markup, count: number, font: Pick<PDFFont, 'encodeText'>): void {
  if (!mark || typeof mark.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(mark.id) || !Number.isInteger(mark.pageIndex) || mark.pageIndex < 0 || mark.pageIndex >= count || !kinds.includes(mark.kind)) throw new Error('Invalid markup identity, page or kind.');
  if (!Array.isArray(mark.points) || (mark.kind === 'ink' ? mark.points.length < 2 || mark.points.length > 10000 : mark.points.length !== 2) || mark.points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > 1e7))) throw new Error('Markup requires finite valid page coordinates.');
  if (!Array.isArray(mark.color) || mark.color.length !== 3 || Array.from(mark.color).some(v => !Number.isFinite(v) || v < 0 || v > 1) || !Number.isFinite(mark.width) || mark.width < 0.25 || mark.width > 100 || !Number.isFinite(mark.opacity) || mark.opacity < 0 || mark.opacity > 1) throw new Error('Invalid markup color, width or opacity.');
  if (typeof mark.contents !== 'string' || mark.contents.length > 10000 || typeof mark.author !== 'string' || mark.author.length > 200 || !['open', 'accepted', 'rejected'].includes(mark.status) || typeof mark.locked !== 'boolean' || !validTimestamp(mark.createdAt) || !validTimestamp(mark.modifiedAt)) throw new Error('Invalid markup text, status or timestamps.');
  if (mark.groupId !== undefined && (typeof mark.groupId !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(mark.groupId))) throw new Error('Invalid markup group id.');
  if (mark.layerId !== undefined && (typeof mark.layerId !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(mark.layerId))) throw new Error('Invalid markup layer id.');
  // Helvetica is WinAnsi only. Fail clearly rather than silently changing engineering notes.
  font.encodeText(mark.contents.replace(/\r?\n/g, ''));
  const [first, second] = mark.points;
  if (mark.kind !== 'ink' && first[0] === second[0] && first[1] === second[1]) throw new Error('Markup geometry must have nonzero size.');
  if (['rectangle', 'ellipse', 'highlight', 'text', 'cloud', 'callout', 'stamp'].includes(mark.kind) && (first[0] === second[0] || first[1] === second[1])) throw new Error('Markup box must have positive width and height.');
  if (mark.kind === 'callout') {
    if (!Array.isArray(mark.callout) || ![2, 3].includes(mark.callout.length) || mark.callout.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > 1e7))) throw new Error('Callout requires two or three finite leader points.');
    if (new Set(mark.callout.map(p => p.join(','))).size !== mark.callout.length) throw new Error('Callout leader points must be distinct.');
    const [x, y] = mark.callout.at(-1)!, l = Math.min(first[0], second[0]), r = Math.max(first[0], second[0]), b = Math.min(first[1], second[1]), t = Math.max(first[1], second[1]);
    if (!(x >= l && x <= r && y >= b && y <= t && (x === l || x === r || y === b || y === t))) throw new Error('Callout anchor must lie on the text box boundary.');
  } else if (mark.callout !== undefined) throw new Error('Leader points are supported only for callout annotations.');
  if (mark.kind === 'stamp') {
    if (!STAMP_NAMES.includes(mark.stampName as StampName)) throw new Error('Stamp requires a supported standard stamp name.');
  } else if (mark.stampName !== undefined) throw new Error('Stamp names are supported only for stamp annotations.');
  if (mark.image !== undefined) validateStampImage(mark);
}

function validateStampImage(mark: Markup) {
  const image = mark.image;
  if (mark.kind !== 'stamp') throw new Error('Images are supported only on stamps.');
  if (!image || (image.format !== 'png' && image.format !== 'jpeg' && image.format !== 'pdf') || typeof image.data !== 'string' || !image.data.length || image.data.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data))
    throw new Error('Stamp artwork must be a PNG, JPEG or PDF of at most 2 MB.');
  const head = atob(image.data.slice(0, 12));
  const code = (index: number) => head.charCodeAt(index);
  const ok = image.format === 'png' ? code(0) === 0x89 && head.slice(1, 4) === 'PNG' : image.format === 'pdf' ? head.startsWith('%PDF-') : code(0) === 0xff && code(1) === 0xd8 && code(2) === 0xff;
  if (!ok) throw new Error('Stamp image content does not match its format.');
}

/** Synchronous recovery/schema validation. Returns only supported fields with deep copies. */
export function validateMarkups(markups: readonly Markup[], pageCount: number): Markup[] {
  if (!Array.isArray(markups) || markups.length > 10000 || !Number.isInteger(pageCount) || pageCount < 1) throw new Error('Invalid markup list or page count.');
  const encoder = StandardFontEmbedder.for('Helvetica' as Parameters<typeof StandardFontEmbedder.for>[0]), ids = new Set<string>();
  const commentIds = new Set<string>(); let commentCount=0, commentText=0;
  const canonical = markups.map((mark: Markup): Markup => {
    validate(mark, pageCount, encoder);
    if (ids.has(mark.id)) throw new Error('Duplicate markup id.'); ids.add(mark.id);
    const comments=mark.comments === undefined ? undefined : validateMarkupComments(mark.comments);
    for (const comment of comments ?? []) {
      if (commentIds.has(comment.id)) throw new Error('Duplicate comment id across annotations.');
      commentIds.add(comment.id); commentCount++; commentText+=comment.author.length+comment.contents.length;
      if (commentCount>5000 || commentText>2_000_000) throw new Error('Workspace comment count or text budget exceeded.');
    }
    return { id: mark.id, pageIndex: mark.pageIndex, kind: mark.kind, points: mark.points.map(([x, y]) => [x, y]), ...(mark.callout ? { callout: mark.callout.map(([x, y]): [number, number] => [x, y]) } : {}), ...(mark.kind === 'stamp' ? { stampName: mark.stampName } : {}), ...(mark.image ? { image: { format: mark.image.format, data: mark.image.data } } : {}), ...(mark.groupId !== undefined ? {groupId:mark.groupId} : {}), ...(mark.layerId !== undefined ? {layerId:mark.layerId} : {}), ...(comments !== undefined ? {comments} : {}), color: [...mark.color], width: mark.width, opacity: mark.opacity, contents: mark.contents, author: mark.author, status: mark.status, locked: mark.locked, createdAt: mark.createdAt, modifiedAt: mark.modifiedAt };
  });
  const groups = new Map<string, {pageIndex:number; layerId?:string; count:number}>();
  for (const mark of canonical) if (mark.groupId !== undefined) {
    const group = groups.get(mark.groupId);
    if (group && group.pageIndex !== mark.pageIndex) throw new Error('Markup groups must remain on one page.');
    if (group && group.layerId !== mark.layerId) throw new Error('Markup groups must remain on the same annotation layer.');
    groups.set(mark.groupId, {pageIndex:mark.pageIndex,layerId:mark.layerId,count:(group?.count ?? 0)+1});
  }
  if ([...groups.values()].some(group => group.count < 2)) throw new Error('Markup groups require at least two members.');
  return canonical;
}

function textLines(contents: string, width: number, height: number, font: PDFFont): string[] {
  if (width < 12 || height < 16) throw new Error('Text box is too small for 12 point text.');
  const lines: string[] = [];
  for (const paragraph of contents.replace(/\r\n/g, '\n').split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (font.widthOfTextAtSize(line + character, 12) > width - 8) { if (!line) throw new Error('Text box is too narrow.'); lines.push(line); line = ''; }
      line += character;
    }
    lines.push(line);
  }
  if (lines.length * 14 + 6 > height) throw new Error('Text does not fit the box; enlarge it or shorten the note.');
  return lines;
}

/** Fit independently authored stamp lettering inside its border; never clip an overflowing label. */
function stampLayout(contents: string, stampName: StampName, width: number, height: number, stroke: number, font: PDFFont): { lines: string[]; size: number; margin: number; ascent: number; blockHeight: number } {
  const text = contents.trim() ? contents.replace(/\r\n/g, '\n') : stampName.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
  const margin = Math.max(6, stroke), availableWidth = width - 2 * margin, availableHeight = height - 2 * margin;
  for (let size = 36; size >= 8; size -= 0.5) {
    const lines: string[] = [];
    let fits = availableWidth > 0;
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const char of paragraph) {
        if (font.widthOfTextAtSize(char, size) > availableWidth) { fits = false; break; }
        if (font.widthOfTextAtSize(line + char, size) > availableWidth) { lines.push(line); line = ''; }
        line += char;
      }
      lines.push(line);
      if (!fits) break;
    }
    const ascent = font.heightAtSize(size, { descender: false });
    const blockHeight = font.heightAtSize(size, { descender: true }) + (lines.length - 1) * size * 1.2;
    if (fits && blockHeight <= availableHeight) return { lines, size, margin, ascent, blockHeight };
  }
  throw new Error('Stamp text does not fit at the minimum 8 point size; enlarge the box or shorten the label.');
}

/** Append authored optional content without replacing source configurations or visibility locks. */
function appendLayers(pdf:PDFDocument,layers:readonly MarkupLayer[]):Map<string,PDFRef> {
  const refs=new Map<string,PDFRef>();
  if(!layers.length)return refs;
  let properties=pdf.catalog.lookupMaybe(PDFName.of('OCProperties'),PDFDict);
  if(!properties){properties=pdf.context.obj({});pdf.catalog.set(PDFName.of('OCProperties'),properties);}
  const array=(dict:PDFDict,key:string,initial:PDFRef[]=[])=>{
    let value=dict.lookupMaybe(PDFName.of(key),PDFArray);
    if(!value){value=pdf.context.obj(initial) as PDFArray;dict.set(PDFName.of(key),value);}
    return value;
  };
  const all=array(properties,'OCGs'),existing=all.asArray().slice() as PDFRef[];
  let defaults=properties.lookupMaybe(PDFName.of('D'),PDFDict);
  if(!defaults){defaults=pdf.context.obj({BaseState:'ON'});properties.set(PDFName.of('D'),defaults);}
  const order=array(defaults,'Order',existing),on=array(defaults,'ON'),off=array(defaults,'OFF');
  for(const layer of layers){
    const ref=pdf.context.register(pdf.context.obj({Type:'OCG',Name:PDFHexString.fromText(layer.name),Intent:['View','Design']}));
    refs.set(layer.id,ref);all.push(ref);order.push(ref);(layer.visible?on:off).push(ref);
  }
  return refs;
}

/**
 * Append standard PDF annotations using explicit normal appearance Form XObjects.
 * PDF 32000-1:2008 §12.5, tables164/166/168 and subtype tables; later errata
 * https://pdf-issues.pdfa.org/32000-2-2020/clause12.html reviewed 2026-10-21.
 * Flatten draws these same appearances into page content. It does not flatten
 * unrelated existing annotations. Caller passes pristine baseline bytes for marks.
 * Rewriting invalidates cryptographic signatures; this API does not validate them.
 */
export async function applyMarkups(bytes: Uint8Array, markups: readonly Markup[], { flatten = false, layers = [] }: { flatten?: boolean; layers?: readonly MarkupLayer[] } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, {updateMetadata:false});
  markups = validateMarkups(markups, pdf.getPageCount());
  layers = validateMarkupLayers(layers);
  const layerById = new Map(layers.map(layer => [layer.id, layer]));
  for (const mark of markups) if (mark.layerId !== undefined && !layerById.has(mark.layerId)) throw new Error('Markup refers to a missing annotation layer.');
  const layerRefs = appendLayers(pdf, layers);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const stampFont = markups.some(mark => mark.kind === 'stamp') ? await pdf.embedFont(StandardFonts.HelveticaBold) : undefined;
  const ids = new Set<string>();
  for (const mark of markups) {
    validate(mark, pdf.getPageCount(), font);
    if (ids.has(mark.id)) throw new Error('Duplicate markup id.'); ids.add(mark.id);
    const box = pdf.getPage(mark.pageIndex).getMediaBox();
    if ([...mark.points, ...(mark.callout ?? [])].some(([x, y]) => x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height)) throw new Error('Markup coordinates are outside the page.');
  }
  for (const page of pdf.getPages()) {
    const annotations = page.node.Annots();
    if (annotations) for (let i = 0; i < annotations.size(); i++) {
      const existing = pdf.context.lookup(annotations.get(i));
      if (existing instanceof PDFDict) {
        const name = existing.get(PDFName.of('NM'));
        if ((name instanceof PDFString || name instanceof PDFHexString) && name.decodeText().startsWith('opendraft:') && ids.has(name.decodeText().slice(10))) throw new Error('Baseline already contains this markup id.');
      }
    }
  }
  const primaryGroups = new Map<string, PDFRef>();
  const images = new Map<string, { width: number; height: number; ref: PDFRef }>();
  for (const mark of markups) {
    const page = pdf.getPage(mark.pageIndex), [first, second] = mark.points;
    const geometry = [...mark.points, ...(mark.callout ?? [])];
    const xs = geometry.map(p => p[0]), ys = geometry.map(p => p[1]);
    const pad = mark.kind === 'highlight' || mark.kind === 'text' ? 0 : mark.kind === 'arrow' || mark.kind === 'callout' ? Math.max(8, mark.width * 4) + mark.width : mark.kind === 'cloud' ? 8 + mark.width : mark.width;
    const left = Math.min(...xs) - pad, bottom = Math.min(...ys) - pad, width = Math.max(...xs) - left + pad, height = Math.max(...ys) - bottom + pad;
    const p = mark.points.map(([x, y]) => [x - left, y - bottom]);
    const color = mark.color.map(n).join(' ');
    const commands = [`q /GS0 gs ${color} RG ${color} rg ${n(mark.width)} w 1 J 1 j`];
    let imageRef: PDFRef | undefined;
    if (mark.kind === 'stamp' && mark.image) {
      // Artwork is fitted inside the box, centred, keeping its aspect ratio.
      const w = Math.abs(first[0] - second[0]), h = Math.abs(first[1] - second[1]);
      const image = mark.image;
      const embedded = images.get(image.data) ?? await (async () => {
        const raw = Uint8Array.from(atob(image.data), c => c.charCodeAt(0));
        // A PDF stamp uses its first page as vector artwork (a form XObject).
        const loaded = image.format === 'pdf' ? (await pdf.embedPdf(raw, [0]))[0] : image.format === 'png' ? await pdf.embedPng(raw) : await pdf.embedJpg(raw);
        images.set(image.data, loaded);
        return loaded;
      })();
      const fit = Math.min(w / embedded.width, h / embedded.height), iw = embedded.width * fit, ih = embedded.height * fit;
      imageRef = embedded.ref;
      commands.push(`q ${n(iw)} 0 0 ${n(ih)} ${n(pad + (w - iw) / 2)} ${n(pad + (h - ih) / 2)} cm /Im0 Do Q`);
    }
    else if (mark.kind === 'stamp') {
      const w = Math.abs(first[0] - second[0]), h = Math.abs(first[1] - second[1]), bold = stampFont!;
      const layout = stampLayout(mark.contents, mark.stampName!, w, h, mark.width, bold);
      commands.push(`${n(pad)} ${n(pad)} ${n(w)} ${n(h)} re S`, `BT /F0 ${n(layout.size)} Tf ${color} rg`);
      const firstBaseline = pad + layout.margin + (h - 2 * layout.margin + layout.blockHeight) / 2 - layout.ascent;
      layout.lines.forEach((line, i) => commands.push(`1 0 0 1 ${n(pad + (w - bold.widthOfTextAtSize(line, layout.size)) / 2)} ${n(firstBaseline - i * layout.size * 1.2)} Tm ${bold.encodeText(line).toString()} Tj`));
      commands.push('ET');
    }
    else if (mark.kind === 'rectangle') commands.push(`${n(pad)} ${n(pad)} ${n(width - pad * 2)} ${n(height - pad * 2)} re S`);
    else if (mark.kind === 'cloud') {
      // Independently authored cubic scallops, bounded to 256 lobes per edge.
      const l = Math.min(p[0][0], p[1][0]), r = Math.max(p[0][0], p[1][0]), b = Math.min(p[0][1], p[1][1]), t = Math.max(p[0][1], p[1][1]);
      commands.push(`${n(l)} ${n(b)} m`);
      for (const [ax, ay, bx, by] of [[l,b,r,b], [r,b,r,t], [r,t,l,t], [l,t,l,b]]) {
        const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy), count = Math.min(256, Math.max(1, Math.ceil(length / 16))), bulge = Math.min(8, length / count / 2);
        for (let i = 0; i < count; i++) {
          const x = ax + dx * i / count, y = ay + dy * i / count, ex = ax + dx * (i + 1) / count, ey = ay + dy * (i + 1) / count, nx = dy / length * bulge, ny = -dx / length * bulge;
          commands.push(`${n(x + (ex-x)/3 + nx)} ${n(y + (ey-y)/3 + ny)} ${n(x + 2*(ex-x)/3 + nx)} ${n(y + 2*(ey-y)/3 + ny)} ${n(ex)} ${n(ey)} c`);
        }
      }
      commands.push('h S');
    }
    else if (mark.kind === 'callout') {
      const leader = mark.callout!.map(([x,y]) => [x-left,y-bottom]), tip = leader[0], next = leader[1], angle = Math.atan2(tip[1]-next[1],tip[0]-next[0]), length = Math.max(8,mark.width*4);
      commands.push(`${n(tip[0])} ${n(tip[1])} m`, ...leader.slice(1).map(([x,y]) => `${n(x)} ${n(y)} l`), 'S');
      for (const delta of [-0.5,0.5]) commands.push(`${n(tip[0]-Math.cos(angle+delta)*length)} ${n(tip[1]-Math.sin(angle+delta)*length)} m ${n(tip[0])} ${n(tip[1])} l S`);
      const x = Math.min(...p.map(q=>q[0])), y = Math.min(...p.map(q=>q[1])), w = Math.abs(first[0]-second[0]), h = Math.abs(first[1]-second[1]);
      commands.push(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re S`, `BT /F0 12 Tf ${color} rg`);
      textLines(mark.contents,w,h,font).forEach((line,i)=>commands.push(`1 0 0 1 ${n(x+4)} ${n(y+h-16-i*14)} Tm ${font.encodeText(line).toString()} Tj`));
      commands.push('ET');
    }
    else if (mark.kind === 'highlight') commands.push(`0 0 ${n(width)} ${n(height)} re f`);
    else if (mark.kind === 'ellipse') {
      const cx = width / 2, cy = height / 2, rx = width / 2 - pad, ry = height / 2 - pad, k = 0.55228475;
      commands.push(`${n(cx + rx)} ${n(cy)} m`, `${n(cx + rx)} ${n(cy + k * ry)} ${n(cx + k * rx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`, `${n(cx - k * rx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + k * ry)} ${n(cx - rx)} ${n(cy)} c`, `${n(cx - rx)} ${n(cy - k * ry)} ${n(cx - k * rx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`, `${n(cx + k * rx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - k * ry)} ${n(cx + rx)} ${n(cy)} c S`);
    } else if (mark.kind === 'text') {
      commands.push(`BT /F0 12 Tf ${color} rg`);
      textLines(mark.contents, width, height, font).forEach((line, i) => commands.push(`1 0 0 1 4 ${n(height - 16 - i * 14)} Tm ${font.encodeText(line).toString()} Tj`));
      commands.push('ET');
    } else {
      commands.push(`${n(p[0][0])} ${n(p[0][1])} m`, ...p.slice(1).map(([x, y]) => `${n(x)} ${n(y)} l`), 'S');
      if (mark.kind === 'arrow') {
        const angle = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]), length = Math.max(8, mark.width * 4);
        for (const delta of [-0.5, 0.5]) commands.push(`${n(p[1][0] - Math.cos(angle + delta) * length)} ${n(p[1][1] - Math.sin(angle + delta) * length)} m ${n(p[1][0])} ${n(p[1][1])} l S`);
      }
    }
    commands.push('Q');
    // Some viewers ignore annotation/Form /OC metadata; stream marked content retains visibility there too.
    const appearance = pdf.context.register(pdf.context.flateStream(mark.layerId === undefined ? commands.join('\n') : `/OC /OpenDraftLayer BDC\n${commands.join('\n')}\nEMC`, { Type: 'XObject', Subtype: 'Form', FormType: 1, ...(mark.layerId !== undefined ? {OC:layerRefs.get(mark.layerId)!} : {}), BBox: [0, 0, width, height], Resources: { ...(mark.layerId !== undefined ? {Properties:{OpenDraftLayer:layerRefs.get(mark.layerId)!}} : {}), Font: { F0: (mark.kind === 'stamp' ? stampFont! : font).ref }, ...(imageRef ? { XObject: { Im0: imageRef } } : {}), ExtGState: { GS0: { Type: 'ExtGState', CA: mark.opacity, ca: mark.opacity, BM: mark.kind === 'highlight' ? 'Multiply' : 'Normal' } } } }));
    if (flatten) {
      const key = page.node.newXObject('OpenDraft', appearance);
      const layerRef = mark.layerId === undefined ? undefined : layerRefs.get(mark.layerId);
      if (layerRef) {
        const resources = page.node.normalizedEntries().Resources;
        let properties = resources.lookupMaybe(PDFName.of('Properties'), PDFDict);
        if (!properties) { properties = pdf.context.obj({}); resources.set(PDFName.of('Properties'), properties); }
        let index = 1;
        while (properties.has(PDFName.of(`OpenDraftLayer${index}`))) index++;
        const property = PDFName.of(`OpenDraftLayer${index}`);
        properties.set(property, layerRef);
        page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), property]));
      }
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, left, bottom), drawObject(key), popGraphicsState());
      if (layerRef) page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
      continue;
    }
    const subtype = { rectangle: 'Square', ellipse: 'Circle', line: 'Line', arrow: 'Line', highlight: 'Highlight', ink: 'Ink', text: 'FreeText', cloud: 'Square', callout: 'FreeText', stamp: 'Stamp' }[mark.kind];
    const dictionary = pdf.context.obj({ Type: 'Annot', Subtype: subtype, Rect: [left, bottom, left + width, bottom + height], P: page.ref, NM: PDFHexString.fromText(`opendraft:${mark.id}`), T: PDFHexString.fromText(mark.author), Contents: PDFHexString.fromText(mark.contents), Subj: PDFHexString.fromText(`OpenDraft ${mark.kind}`), CreationDate: PDFString.of(date(mark.createdAt)), M: PDFString.of(date(mark.modifiedAt)), C: mark.color, CA: mark.opacity, F: 4 + ((mark.locked || (mark.layerId !== undefined && layerById.get(mark.layerId)?.locked)) ? 128 + 512 : 0), BS: { Type: 'Border', W: mark.width, S: 'S' }, AP: { N: appearance } });
    if (mark.layerId !== undefined) dictionary.set(PDFName.of('OC'), layerRefs.get(mark.layerId)!);
    if (mark.kind === 'stamp') dictionary.set(PDFName.of('Name'), PDFName.of(mark.stampName!));
    dictionary.set(PDFName.of('OpenDraftStatus'), PDFString.of(mark.status));
    if (mark.kind === 'line' || mark.kind === 'arrow') { dictionary.set(PDFName.of('L'), pdf.context.obj([...first, ...second])); dictionary.set(PDFName.of('LE'), pdf.context.obj(['None', mark.kind === 'arrow' ? 'OpenArrow' : 'None'])); }
    if (mark.kind === 'ink') dictionary.set(PDFName.of('InkList'), pdf.context.obj([mark.points.flat()]));
    if (mark.kind === 'highlight') dictionary.set(PDFName.of('QuadPoints'), pdf.context.obj([left, bottom + height, left + width, bottom + height, left, bottom, left + width, bottom]));
    if (mark.kind === 'cloud') { dictionary.set(PDFName.of('BE'), pdf.context.obj({ S: 'C', I: 1 })); dictionary.set(PDFName.of('RD'), pdf.context.obj([pad,pad,pad,pad])); }
    if (mark.kind === 'callout') {
      dictionary.set(PDFName.of('IT'), PDFName.of('FreeTextCallout'));
      dictionary.set(PDFName.of('CL'), pdf.context.obj(mark.callout!.flat()));
      dictionary.set(PDFName.of('LE'), PDFName.of('OpenArrow'));
      dictionary.set(PDFName.of('RD'), pdf.context.obj([Math.min(first[0],second[0])-left,Math.min(first[1],second[1])-bottom,left+width-Math.max(first[0],second[0]),bottom+height-Math.max(first[1],second[1])]));
    }
    if (mark.kind === 'text' || mark.kind === 'callout') dictionary.set(PDFName.of('DA'), PDFString.of(`/F0 12 Tf ${color} rg`));
    const ref = pdf.context.register(dictionary);
    if (mark.groupId !== undefined) {
      const primary = primaryGroups.get(mark.groupId);
      if (primary) { dictionary.set(PDFName.of('IRT'), primary); dictionary.set(PDFName.of('RT'), PDFName.of('Group')); }
      else primaryGroups.set(mark.groupId, ref);
    }
    page.node.addAnnot(ref);
    const replyRefs=new Map<string,PDFRef>();
    for (const comment of mark.comments ?? []) {
      // Replies are threaded metadata, not independently printed note icons (PDF 1.6 RT /R).
      const reply=pdf.context.obj({Type:'Annot',Subtype:'Text',P:page.ref,Rect:[left,bottom,left+Math.min(width,18),bottom+Math.min(height,18)],
        NM:PDFHexString.fromText(`opendraft:comment:${comment.id}`),T:PDFHexString.fromText(comment.author),Contents:PDFHexString.fromText(comment.contents),
        CreationDate:PDFString.of(date(comment.createdAt)),M:PDFString.of(date(comment.modifiedAt)),IRT:comment.parentId === undefined ? ref : replyRefs.get(comment.parentId)!,RT:'R',
        F:32+((mark.locked || (mark.layerId !== undefined && layerById.get(mark.layerId)?.locked)) ? 128+512 : 0),Open:false});
      if (mark.layerId !== undefined) reply.set(PDFName.of('OC'),layerRefs.get(mark.layerId)!);
      const replyRef=pdf.context.register(reply);replyRefs.set(comment.id,replyRef);page.node.addAnnot(replyRef);
    }
  }
  return pdf.save();
}
