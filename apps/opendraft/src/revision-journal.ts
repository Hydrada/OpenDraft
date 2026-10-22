export type RevisionEntry = {
  id: string;
  createdAt: string;
  reason: string;
  baseSha256: string;
  revisionSha256: string;
  replacements: {targetPage: number; revisionPage: number}[];
  markupPolicy: 'retain' | 'remove';
  clearedMeasurements: number;
  clearedScales: number;
  operation?: 'replace' | 'insert-before';
};

/** Local operation evidence, not a cryptographic audit or stable page identity. */
export function validateRevisionJournal(value: unknown): RevisionEntry[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Revision journal must contain at most 1000 entries.');
  const ids = new Set<string>();
  return Array.from(value, item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid revision journal entry.');
    const {id,createdAt,reason,baseSha256,revisionSha256,replacements,markupPolicy,clearedMeasurements,clearedScales,operation} = item as RevisionEntry;
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || ids.has(id)) throw new Error('Revision entry IDs must be nonempty, unique and at most 200 characters.');
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
      throw new Error('Revision entry time must be a canonical ISO timestamp.');
    }
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new Error('Revision reason must contain 1–1000 characters.');
    for (const hash of [baseSha256,revisionSha256]) {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)) throw new Error('Revision source hashes must be lowercase SHA-256 hex.');
    }
    if (markupPolicy !== 'retain' && markupPolicy !== 'remove') throw new Error('Invalid revision markup policy.');
    if (operation !== undefined && operation !== 'replace' && operation !== 'insert-before') throw new Error('Invalid revision operation.');
    if (operation === 'insert-before' && markupPolicy !== 'retain') throw new Error('Inserted revisions retain the old-page markups.');
    for (const count of [clearedMeasurements,clearedScales]) {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Revision cleared counts must be nonnegative safe integers.');
    }
    if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 100) throw new Error('Each revision entry must replace 1–100 pages.');
    const targets = new Set<number>(), revisions = new Set<number>();
    const copied = Array.from(replacements, replacement => {
      if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) throw new Error('Invalid revision replacement.');
      const {targetPage,revisionPage} = replacement;
      if (!Number.isSafeInteger(targetPage) || targetPage < 1 || targets.has(targetPage) || !Number.isSafeInteger(revisionPage) || revisionPage < 1 || revisions.has(revisionPage)) {
        throw new Error('Revision replacement pages must be positive one-to-one safe integer snapshots.');
      }
      targets.add(targetPage); revisions.add(revisionPage);
      return {targetPage,revisionPage};
    });
    ids.add(id);
    return {id,createdAt,reason,baseSha256,revisionSha256,replacements:copied,markupPolicy,clearedMeasurements,clearedScales,...(operation === undefined ? {} : {operation})};
  });
}
