import type { Markup } from './annotations.ts';
import type { MarkupLayer } from './markup-layers.ts';
import type { TakeoffState } from './takeoff.ts';

/**
 * Shared, versioned collaborative model. Each item carries a server version; a batch applies only
 * when every operation's base version matches (optimistic concurrency per item), so concurrent
 * edits to different items merge and edits to the same item surface as reviewable conflicts.
 * Used verbatim by the browser client and the self-hosted server.
 */
export const collections = ['layers', 'markups', 'scales', 'records'] as const;
export type Collection = typeof collections[number];
export type Entry = { v: number; seq: number; item: unknown };
export type Store = Record<Collection, Record<string, Entry>>;
export type Operation = { c: Collection; id: string; base: number; item: unknown | null };
export type Conflict = { c: Collection; id: string; base: number; server: Entry | null };
export type SharedState = { markups: Markup[]; layers: MarkupLayer[]; takeoff: TakeoffState };

export const emptyStore = (): Store => ({ layers: {}, markups: {}, scales: {}, records: {} });
const idOf = (item: unknown) => (item as { id?: unknown } | null)?.id;

export function stateItems(state: SharedState): Record<Collection, unknown[]> {
  return { layers: state.layers, markups: state.markups, scales: state.takeoff.scales, records: state.takeoff.records };
}

/** Rebuild ordered shared state; order is creation sequence so z-order converges for all clients. */
export function storeState(store: Store): SharedState {
  const ordered = (c: Collection) => Object.values(store[c]).sort((a, b) => a.seq - b.seq).map(entry => structuredClone(entry.item));
  return { layers: ordered('layers') as MarkupLayer[], markups: ordered('markups') as Markup[], takeoff: { scales: ordered('scales') as TakeoffState['scales'], records: ordered('records') as TakeoffState['records'] } };
}

/** Operations turning the synchronized shadow into the local state. */
export function diffState(shadow: Store, local: SharedState): Operation[] {
  const ops: Operation[] = [], items = stateItems(local);
  for (const c of collections) {
    const seen = new Set<string>();
    for (const item of items[c]) {
      const id = idOf(item);
      if (typeof id !== 'string') throw new Error(`Shared ${c} item is missing an id.`);
      seen.add(id);
      const existing = shadow[c][id];
      if (!existing || JSON.stringify(existing.item) !== JSON.stringify(item)) ops.push({ c, id, base: existing?.v ?? 0, item: structuredClone(item) });
    }
    for (const [id, entry] of Object.entries(shadow[c])) if (!seen.has(id)) ops.push({ c, id, base: entry.v, item: null });
  }
  return ops;
}

export function validateOperations(value: unknown): Operation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20_000) throw new Error('A batch requires 1 to 20,000 operations.');
  const keys = new Set<string>();
  return value.map((raw): Operation => {
    const op = raw as Partial<Operation> | null;
    if (!op || typeof op !== 'object' || !collections.includes(op.c as Collection) || typeof op.id !== 'string' || !op.id || op.id.length > 200 ||
        !Number.isInteger(op.base) || op.base! < 0 || !('item' in op)) throw new Error('Invalid collaboration operation.');
    if (op.item !== null && idOf(op.item) !== op.id) throw new Error('Operation item id does not match.');
    const key = `${op.c}\u0000${op.id}`;
    if (keys.has(key)) throw new Error('A batch may change each item once.');
    keys.add(key);
    return { c: op.c!, id: op.id, base: op.base!, item: op.item === null ? null : structuredClone(op.item) };
  });
}

/**
 * All-or-nothing batch. Returns conflicts without changing the store, or the next store; the
 * caller must validate the resulting state before accepting it.
 */
export function applyOperations(store: Store, ops: readonly Operation[], nextSeq: () => number): { store: Store; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  for (const op of ops) {
    const current = store[op.c][op.id];
    if ((current?.v ?? 0) !== op.base) conflicts.push({ c: op.c, id: op.id, base: op.base, server: current ? structuredClone(current) : null });
  }
  if (conflicts.length) return { store, conflicts };
  const next = structuredClone(store);
  for (const op of ops) {
    const current = next[op.c][op.id];
    if (op.item === null) delete next[op.c][op.id];
    else next[op.c][op.id] = { v: (current?.v ?? 0) + 1, seq: current?.seq ?? nextSeq(), item: structuredClone(op.item) };
  }
  return { store: next, conflicts };
}

/** Apply already-accepted server changes to a client shadow. */
export function applyAccepted(store: Store, changes: readonly { c: Collection; id: string; entry: Entry | null }[]): Store {
  const next = structuredClone(store);
  for (const change of changes) {
    if (change.entry === null) delete next[change.c][change.id];
    else next[change.c][change.id] = structuredClone(change.entry);
  }
  return next;
}

export type LocalConflict = { c: Collection; id: string; mine: unknown | null; server: Entry | null };

/**
 * Re-apply local intent (local vs oldShadow) on top of newShadow. Items changed remotely and
 * locally to different values become conflicts; the server value is shown until the reviewer
 * explicitly keeps their own version. Local additions keep their local order after shared items.
 */
export function rebaseLocal(oldShadow: Store, newShadow: Store, local: SharedState): { state: SharedState; conflicts: LocalConflict[] } {
  const ops = diffState(oldShadow, local), conflicts: LocalConflict[] = [];
  const next = structuredClone(newShadow);
  let localSeq = Number.MAX_SAFE_INTEGER - ops.length;
  for (const op of ops) {
    const before = oldShadow[op.c][op.id], after = newShadow[op.c][op.id];
    if ((before?.v ?? 0) !== (after?.v ?? 0)) {
      const same = op.item === null ? !after : !!after && JSON.stringify(after.item) === JSON.stringify(op.item);
      if (!same) conflicts.push({ c: op.c, id: op.id, mine: op.item, server: after ? structuredClone(after) : null });
      continue;
    }
    if (op.item === null) delete next[op.c][op.id];
    else next[op.c][op.id] = { v: after?.v ?? 0, seq: after?.seq ?? localSeq++, item: structuredClone(op.item) };
  }
  return { state: storeState(next), conflicts };
}

/** Replace one item in a shared state, keeping its position when present. */
export function withItem(state: SharedState, c: Collection, id: string, item: unknown | null): SharedState {
  const items = stateItems(state);
  const list = items[c].slice(), index = list.findIndex(entry => (entry as { id?: unknown }).id === id);
  if (item === null) { if (index >= 0) list.splice(index, 1); }
  else if (index >= 0) list[index] = structuredClone(item); else list.push(structuredClone(item));
  const next = { ...items, [c]: list };
  return structuredClone({ layers: next.layers, markups: next.markups, takeoff: { scales: next.scales, records: next.records } }) as SharedState;
}
