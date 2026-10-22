export type SheetPair = {
  id: string;
  basePage: number;
  revisionPage: number;
  reason: 'order' | 'label' | 'manual';
  scale: number;
  rotationDegrees: number;
  offsetX: number;
  offsetY: number;
};

export const SHEET_PAIRING_LIMITS = Object.freeze({maxPages: 200, maxSelectedPairs: 100});

function pageCount(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > SHEET_PAIRING_LIMITS.maxPages) {
    throw new Error('Each source must have between 1 and 200 pages.');
  }
}

function labels(value: (string | null)[]): string[] {
  if (!Array.isArray(value)) throw new Error('Page labels must be an array.');
  pageCount(value.length);
  return Array.from(value, label => {
    if (label === null) return '';
    if (typeof label !== 'string') throw new Error('Each page label must be text or null.');
    return label.normalize('NFC').trim().replace(/\s+/gu, ' ').toUpperCase().normalize('NFC');
  });
}

/** Labels are metadata, never a fallback page number. Ambiguous labels remain unmatched. */
export function pairSheets(baseLabels: (string | null)[], revisionLabels: (string | null)[], strategy: 'order' | 'label') {
  if (strategy !== 'order' && strategy !== 'label') throw new Error('Unknown sheet pairing strategy.');
  const base = labels(baseLabels), revision = labels(revisionLabels);
  const pairs: SheetPair[] = [], warnings: string[] = [];
  const add = (basePage: number, revisionPage: number) => pairs.push({
    id: `sheet-${basePage}-${revisionPage}`, basePage, revisionPage, reason: strategy,
    scale: 1, rotationDegrees: 0, offsetX: 0, offsetY: 0,
  });
  if (strategy === 'order') {
    for (let i = 1; i <= Math.min(base.length, revision.length); i++) add(i, i);
  } else {
    const index = (values: string[], source: string) => {
      const map = new Map<string, number[]>();
      values.forEach((label, i) => {
        if (!label) {
          warnings.push(`${source} page ${i + 1} has no nonempty PDF label; it was not automatically paired.`);
          return;
        }
        const pages = map.get(label) ?? [];
        pages.push(i + 1); map.set(label, pages);
      });
      for (const pages of map.values()) {
        if (pages.length > 1) warnings.push(`${source} pages ${pages.join(', ')} have duplicate normalized labels; they were not automatically paired.`);
      }
      return map;
    };
    const baseIndex = index(base, 'Base'), revisionIndex = index(revision, 'Revision');
    base.forEach((label, i) => {
      const candidates = revisionIndex.get(label);
      if (label && baseIndex.get(label)?.length === 1 && candidates?.length === 1) add(i + 1, candidates[0]);
    });
  }
  const usedBase = new Set(pairs.map(pair => pair.basePage)), usedRevision = new Set(pairs.map(pair => pair.revisionPage));
  return {
    pairs,
    unmatchedBase: base.flatMap((_, i) => usedBase.has(i + 1) ? [] : [i + 1]),
    unmatchedRevision: revision.flatMap((_, i) => usedRevision.has(i + 1) ? [] : [i + 1]),
    warnings,
  };
}

/** Validate the selected review plan and detach it from mutable caller-owned objects. */
export function validateSheetPairs(pairs: SheetPair[], baseCount: number, revisionCount: number): SheetPair[] {
  pageCount(baseCount); pageCount(revisionCount);
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > SHEET_PAIRING_LIMITS.maxSelectedPairs) {
    throw new Error('Select between 1 and 100 sheet pairs.');
  }
  const ids = new Set<string>(), basePages = new Set<number>(), revisionPages = new Set<number>();
  return Array.from(pairs, pair => {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)) throw new Error('Invalid sheet pair.');
    const {id, basePage, revisionPage, reason, scale, rotationDegrees, offsetX, offsetY} = pair;
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) throw new Error('Sheet pair IDs must be nonempty and unique.');
    if (!Number.isInteger(basePage) || basePage < 1 || basePage > baseCount || basePages.has(basePage)) {
      throw new Error('Each base page must be in range and used at most once.');
    }
    if (!Number.isInteger(revisionPage) || revisionPage < 1 || revisionPage > revisionCount || revisionPages.has(revisionPage)) {
      throw new Error('Each revision page must be in range and used at most once.');
    }
    if (reason !== 'order' && reason !== 'label' && reason !== 'manual') throw new Error('Invalid pairing reason.');
    if (!Number.isFinite(scale) || scale < 0.1 || scale > 10) throw new Error('Sheet scale must be between 0.1 and 10.');
    if (!Number.isFinite(rotationDegrees) || Math.abs(rotationDegrees) > 3600) throw new Error('Sheet rotation must be finite and within 3600 degrees.');
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY) || Math.abs(offsetX) > 100000 || Math.abs(offsetY) > 100000) {
      throw new Error('Sheet offsets must be finite and within 100000 points.');
    }
    ids.add(id); basePages.add(basePage); revisionPages.add(revisionPage);
    return {id, basePage, revisionPage, reason, scale, rotationDegrees, offsetX, offsetY};
  });
}
