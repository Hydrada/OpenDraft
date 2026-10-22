import type { Markup, MarkupKind } from './annotations.ts';
import type { MarkupLayer } from './markup-layers.ts';

export type MarkupQuery = {
  text?: string;
  status?: 'all' | Markup['status'];
  kind?: 'all' | MarkupKind;
  pageIndex?: number;
  /** Undefined selects all layers; an empty string selects unlayered annotations. */
  layerId?: string;
  lock?: 'all' | 'locked' | 'unlocked';
  sort?: 'source' | 'page' | 'author' | 'status' | 'kind' | 'created' | 'modified' | 'layer';
  direction?: 'asc' | 'desc';
};

const kinds = ['rectangle', 'ellipse', 'line', 'arrow', 'highlight', 'ink', 'text', 'cloud', 'callout', 'stamp'];
const statuses = ['open', 'accepted', 'rejected'];
const sorts = ['source', 'page', 'author', 'status', 'kind', 'created', 'modified', 'layer'];
const keys = new Set(['text', 'status', 'kind', 'pageIndex', 'layerId', 'lock', 'sort', 'direction']);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const normalized = (value: string) => value.normalize('NFC').toLocaleLowerCase('en');

function validate(query: MarkupQuery): void {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(key => !keys.has(key)) || Object.getOwnPropertySymbols(query).length)
    throw new Error('Invalid markup list query.');
  if (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 10000))
    throw new Error('Markup search text must be at most 10000 characters.');
  for (const [key, values] of [
    ['status', ['all', ...statuses]], ['kind', ['all', ...kinds]],
    ['lock', ['all', 'locked', 'unlocked']], ['sort', sorts], ['direction', ['asc', 'desc']],
  ] as const) {
    if (query[key] !== undefined && !values.includes(query[key] as never))
      throw new Error(`Invalid markup list ${key}.`);
  }
  if (query.pageIndex !== undefined && (!Number.isSafeInteger(query.pageIndex) || query.pageIndex < 0))
    throw new Error('Markup page filter must be a nonnegative integer.');
  if (query.layerId !== undefined && (typeof query.layerId !== 'string' ||
      (query.layerId !== '' && !/^[a-zA-Z0-9._:-]{1,120}$/.test(query.layerId))))
    throw new Error('Invalid markup layer filter.');
}

/** Query canonical workspace data without editing annotations or their stored/export order. */
export function queryMarkups(marks: readonly Markup[], layers: readonly MarkupLayer[], query: MarkupQuery): Markup[] {
  validate(query);
  const layerById = new Map(layers.map(layer => [layer.id, layer]));
  const text = normalized(query.text ?? '');
  const filtered = marks.map((mark, index) => ({ mark, index })).filter(({ mark }) => {
    const layer = mark.layerId === undefined ? undefined : layerById.get(mark.layerId);
    const locked = mark.locked || !!layer?.locked;
    if (query.pageIndex !== undefined && mark.pageIndex !== query.pageIndex) return false;
    if (query.status !== undefined && query.status !== 'all' && mark.status !== query.status) return false;
    if (query.kind !== undefined && query.kind !== 'all' && mark.kind !== query.kind) return false;
    if (query.layerId !== undefined && (mark.layerId ?? '') !== query.layerId) return false;
    if (query.lock === 'locked' && !locked || query.lock === 'unlocked' && locked) return false;
    return !text || normalized([
      mark.id, mark.kind, mark.stampName ?? '', mark.groupId ?? '', layer?.name ?? '',
      mark.contents, mark.author, mark.status, `Page ${mark.pageIndex + 1}`,
      ...(mark.comments ?? []).flatMap(comment => [comment.id,comment.author,comment.contents]),
    ].join(' ')).includes(text);
  });
  const sort = query.sort ?? 'source';
  if (sort !== 'source') {
    const direction = query.direction === 'desc' ? -1 : 1;
    filtered.sort((left, right) => {
      const a = left.mark, b = right.mark;
      let order: number;
      switch (sort) {
        case 'page': order = a.pageIndex - b.pageIndex; break;
        case 'status': order = statuses.indexOf(a.status) - statuses.indexOf(b.status); break;
        case 'created': order = Date.parse(a.createdAt) - Date.parse(b.createdAt); break;
        case 'modified': order = Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt); break;
        case 'author': order = collator.compare(a.author, b.author); break;
        case 'kind': order = collator.compare(a.kind, b.kind); break;
        case 'layer': order = collator.compare(layerById.get(a.layerId ?? '')?.name ?? '', layerById.get(b.layerId ?? '')?.name ?? ''); break;
      }
      // Ties always follow source order, including descending sorts.
      return order * direction || left.index - right.index;
    });
  }
  return filtered.map(({ mark }) => mark);
}
