import type { PDFDocumentProxy } from 'pdfjs-dist';

export type Bookmark = { title: string; pageNumber: number | null; url: string | null; children: Bookmark[] };
export type Attachment = { id: string; filename: string; bytes: Uint8Array | null; error: string | null };
export type Layer = { id: string; name: string; visible: boolean };
export type DocumentNavigation = {
  bookmarks: Bookmark[]; attachments: Attachment[]; layers: Layer[];
  optionalContentConfig: Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>;
};

/** Display/open only after explicit user action; never use unsafeUrl or PDF actions. */
export function sanitizedHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function safeAttachmentFilename(value: string): string {
  let name = value.split(/[\\/]/).at(-1)!.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_').replace(/[ .]+$/g, '').slice(0, 180).trim();
  if (!name || name === '.' || name === '..') name = 'attachment.bin';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

/** Read-only PDF metadata; no embedded action is executed and no remote resource is fetched. */
export async function readDocumentNavigation(pdf: PDFDocumentProxy): Promise<DocumentNavigation> {
  const outline = await pdf.getOutline();
  let nodeCount = 0;
  type Outline = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number];
  const convert = async (nodes: Outline[], depth = 0): Promise<Bookmark[]> => {
    if (depth > 32) throw new Error('Bookmark nesting exceeds the preview limit.');
    const result: Bookmark[] = [];
    for (const node of nodes ?? []) {
      if (++nodeCount > 5000) throw new Error('Bookmark count exceeds the preview limit.');
      let pageNumber: number | null = null;
      try {
        const dest = typeof node.dest === 'string' ? await pdf.getDestination(node.dest) : node.dest;
        if (Array.isArray(dest) && dest.length) {
          const index = Number.isInteger(dest[0]) ? dest[0] : await pdf.getPageIndex(dest[0]);
          if (Number.isInteger(index) && index >= 0 && index < pdf.numPages) pageNumber = index + 1;
        }
      } catch { /* Broken destinations remain visible but not navigable. */ }
      result.push({ title: String(node.title ?? '').slice(0, 4096), pageNumber, url: sanitizedHttpUrl(node.url), children: await convert(node.items ?? [], depth + 1) });
    }
    return result;
  };
  const bookmarks = await convert(outline ?? []);
  const rawAttachments = await pdf.getAttachments();
  const attachments: Attachment[] = [];
  let total = 0;
  for (const [id, item] of rawAttachments ?? []) {
    const attachment: Attachment = { id, filename: safeAttachmentFilename(item.filename || id), bytes: null, error: null };
    try {
      const bytes = item.content ?? await pdf.getAttachmentContent(id);
      if (!(bytes instanceof Uint8Array)) throw new Error('Attachment content is unavailable.');
      if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Attachment exceeds the 25 MB preview limit.');
      if (total + bytes.byteLength > 100 * 1024 * 1024) throw new Error('Attachments exceed the 100 MB total preview limit.');
      total += bytes.byteLength;
      attachment.bytes = bytes.slice();
    } catch (error) { attachment.error = error instanceof Error ? error.message : 'Attachment could not be read.'; }
    attachments.push(attachment);
  }
  const optionalContentConfig = await pdf.getOptionalContentConfig({ intent: 'display' });
  const layers: Layer[] = [];
  for (const [id, group] of optionalContentConfig) layers.push({ id, name: String(group.name ?? id), visible: Boolean(group.visible) });
  return { bookmarks, attachments, layers, optionalContentConfig };
}
