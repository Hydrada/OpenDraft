export type RevisionPlanSource = {sha256: string; pageCount: number};
export type SavedRevisionPlan = {
  schema: 'opendraft.revision-plan';
  version: 1;
  createdAt: string;
  base: RevisionPlanSource;
  revision: RevisionPlanSource;
  operation: 'replace' | 'insert-before';
  markupPolicy: 'retain' | 'remove';
  reason: string;
  pairs: {basePage: number; revisionPage: number}[];
};

export const REVISION_PLAN_MAX_BYTES = 256 * 1024;

function record(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`Invalid revision plan ${name}.`);
  }
  return value as Record<string, unknown>;
}

function source(value: unknown): RevisionPlanSource {
  const input = record(value, ['sha256','pageCount'], 'source');
  const {sha256,pageCount} = input;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256)) throw new Error('Revision plan source hash must be lowercase SHA-256 hex.');
  if (typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 200) throw new Error('Revision plan source must contain 1–200 pages.');
  return {sha256,pageCount};
}

/** Saved plans carry instructions and source identity, never approval or document bytes. */
export function validateRevisionPlan(value: unknown): SavedRevisionPlan {
  const input = record(value, ['schema','version','createdAt','base','revision','operation','markupPolicy','reason','pairs'], 'document');
  const {schema,version,createdAt,operation,markupPolicy,reason,pairs} = input;
  if (schema !== 'opendraft.revision-plan' || version !== 1) throw new Error('Unsupported revision plan schema or version.');
  if (typeof createdAt !== 'string' || createdAt.length > 27 || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) throw new Error('Revision plan time must be a canonical ISO timestamp.');
  const base = source(input.base), revision = source(input.revision);
  if (operation !== 'replace' && operation !== 'insert-before') throw new Error('Invalid revision plan operation.');
  if (markupPolicy !== 'retain' && markupPolicy !== 'remove') throw new Error('Invalid revision plan markup policy.');
  if (operation === 'insert-before' && markupPolicy !== 'retain') throw new Error('Inserted revisions must retain old-page markups.');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new Error('Revision plan reason must contain 1–1000 characters.');
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 100) throw new Error('Revision plan requires 1–100 sheet pairs.');
  const basePages = new Set<number>(), revisionPages = new Set<number>();
  const copied = Array.from(pairs, pair => {
    const inputPair = record(pair, ['basePage','revisionPage'], 'sheet pair');
    const {basePage,revisionPage} = inputPair;
    if (typeof basePage !== 'number' || !Number.isSafeInteger(basePage) || basePage < 1 || basePage > base.pageCount || basePages.has(basePage) || typeof revisionPage !== 'number' || !Number.isSafeInteger(revisionPage) || revisionPage < 1 || revisionPage > revision.pageCount || revisionPages.has(revisionPage)) throw new Error('Revision plan sheet pairs must be one-to-one and within both sources.');
    basePages.add(basePage); revisionPages.add(revisionPage);
    return {basePage,revisionPage};
  });
  return {schema,version,createdAt,base,revision,operation,markupPolicy,reason,pairs:copied};
}

export function parseRevisionPlan(text: string): SavedRevisionPlan {
  if (typeof text !== 'string' || text.length > REVISION_PLAN_MAX_BYTES || new TextEncoder().encode(text).byteLength > REVISION_PLAN_MAX_BYTES) throw new Error('Revision plan exceeds the 256 KiB UTF-8 input limit.');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Revision plan is not valid JSON.'); }
  return validateRevisionPlan(value);
}

export function serializeRevisionPlan(value: unknown): string {
  return JSON.stringify(validateRevisionPlan(value), null, 2) + '\n';
}

/** Revalidate even typed inputs: imported objects and current document snapshots are untrusted. */
export function assertRevisionPlanSources(plan: SavedRevisionPlan, base: RevisionPlanSource, revision: RevisionPlanSource): void {
  const expected = validateRevisionPlan(plan), actualBase = source(base), actualRevision = source(revision);
  if (expected.base.sha256 !== actualBase.sha256 || expected.base.pageCount !== actualBase.pageCount || expected.revision.sha256 !== actualRevision.sha256 || expected.revision.pageCount !== actualRevision.pageCount) throw new Error('Revision plan sources do not match these exact PDF snapshots and page counts.');
}
