import type { Markup } from './annotations.ts';
import { validateLayerAssignments, type MarkupLayer } from './markup-layers.ts';

export type MarkupComment = {
  id: string;
  parentId?: string;
  author: string;
  contents: string;
  createdAt: string;
  modifiedAt: string;
};

const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(value);
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value || Number(value.slice(0,4)) < 1)
    throw new Error('Invalid comment timestamp.');
}

/** Comment arrays are topologically ordered: each parent precedes every reply. */
export function validateMarkupComments(value: unknown): MarkupComment[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Markup comments must be an array of at most 100 entries.');
  const seen = new Set<string>();
  return Array.from(value, (entry: unknown): MarkupComment => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid markup comment.');
    const item = entry as Record<string, unknown>;
    if (!safeId(item.id) || seen.has(item.id)) throw new Error('Invalid or duplicate comment id.');
    if (item.parentId !== undefined && (!safeId(item.parentId) || !seen.has(item.parentId)))
      throw new Error('Comment reply parent must exist earlier in the same thread.');
    if (typeof item.author !== 'string' || typeof item.contents !== 'string') throw new Error('Comment author and contents must be text.');
    const author = item.author.trim(), contents = item.contents.trim();
    if (!author || author.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(author) || /[\uD800-\uDFFF]/u.test(author))
      throw new Error('Comment author must contain 1–200 characters without control characters.');
    if (!contents || contents.length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(contents) || /[\uD800-\uDFFF]/u.test(contents))
      throw new Error('Comment contents must contain 1–10000 characters without unsupported control characters.');
    timestamp(item.createdAt); timestamp(item.modifiedAt);
    if (Date.parse(item.modifiedAt) < Date.parse(item.createdAt)) throw new Error('Comment modification precedes its creation.');
    seen.add(item.id);
    return { id:item.id, ...(item.parentId !== undefined ? {parentId:item.parentId as string} : {}), author, contents, createdAt:item.createdAt, modifiedAt:item.modifiedAt };
  });
}

function selected(marks: readonly Markup[], markupId: string, pageCount: number, layers: readonly MarkupLayer[]): { marks: Markup[]; mark: Markup } {
  const canonical = validateLayerAssignments(marks,layers,pageCount);
  const mark = canonical.find(item => item.id === markupId);
  if (!mark) throw new Error('Select an existing markup before changing comments.');
  if (mark.locked) throw new Error('Unlock this markup before changing comments.');
  if (layers.some(layer => layer.id === mark.layerId && layer.locked)) throw new Error('Unlock the annotation layer before changing comments.');
  return {marks:canonical,mark};
}
function candidate(state: {marks:Markup[];mark:Markup}, comments: MarkupComment[], modifiedAt: string, pageCount: number, layers: readonly MarkupLayer[]): Markup[] {
  timestamp(modifiedAt);
  if (Date.parse(modifiedAt) < Date.parse(state.mark.modifiedAt)) throw new Error('Comment operation timestamp precedes the latest markup modification.');
  return validateLayerAssignments(state.marks.map(mark => mark.id === state.mark.id ? {...mark,comments,modifiedAt} : mark),layers,pageCount);
}

/** A discussion belongs to one annotation, even when that annotation is grouped. */
export function addMarkupComment(marks: readonly Markup[], markupId: string, comment: MarkupComment, pageCount: number, layers: readonly MarkupLayer[] = []): Markup[] {
  const state = selected(marks,markupId,pageCount,layers);
  const comments = validateMarkupComments([...(state.mark.comments ?? []),comment]);
  return candidate(state,comments,comments.at(-1)!.modifiedAt,pageCount,layers);
}

export function updateMarkupComment(marks: readonly Markup[], markupId: string, commentId: string, patch: {author:string;contents:string}, modifiedAt: string, pageCount: number, layers: readonly MarkupLayer[] = []): Markup[] {
  const state = selected(marks,markupId,pageCount,layers);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['author','contents'].includes(key)) || Object.getOwnPropertySymbols(patch).length)
    throw new Error('Comment edits support only author and contents.');
  if (!state.mark.comments?.some(comment => comment.id === commentId)) throw new Error('Selected comment no longer exists.');
  const comments = validateMarkupComments(state.mark.comments.map(comment => comment.id === commentId ? {...comment,author:patch.author,contents:patch.contents,modifiedAt} : comment));
  return candidate(state,comments,modifiedAt,pageCount,layers);
}

/** Explicit subtree deletion never leaves dangling replies; undo restores the complete tree. */
export function deleteMarkupComment(marks: readonly Markup[], markupId: string, commentId: string, modifiedAt: string, pageCount: number, layers: readonly MarkupLayer[] = []): Markup[] {
  const state = selected(marks,markupId,pageCount,layers);
  if (!state.mark.comments?.some(comment => comment.id === commentId)) throw new Error('Selected comment no longer exists.');
  const deleted = new Set([commentId]);
  for (const comment of state.mark.comments) if (comment.parentId !== undefined && deleted.has(comment.parentId)) deleted.add(comment.id);
  return candidate(state,state.mark.comments.filter(comment => !deleted.has(comment.id)),modifiedAt,pageCount,layers);
}
