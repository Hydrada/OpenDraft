import { type Markup } from "./annotations.ts";
import { validatePages, type PageRef } from "./organization.ts";
import { validateTakeoff, type TakeoffState } from "./takeoff.ts";
import { validateLayerAssignments, type MarkupLayer } from "./markup-layers.ts";
import { validateRevisionJournal, type RevisionEntry } from "./revision-journal.ts";

export type RecoveryWorkspace = {
  sources: Array<{ id: string; bytes: Uint8Array }>;
  pages: PageRef[];
  markups: Markup[];
  takeoff?: TakeoffState;
  layers?: MarkupLayer[];
  revisions?: RevisionEntry[];
};
/** Local-only recovery. One transaction replaces the latest workspace atomically. */
export type RecoverySnapshot = {
  version: 1;
  documents: Array<{
    id: string;
    name: string;
    bytes: Uint8Array;
    page: number;
    zoom: number;
    rotations: Array<[number, number]>;
    workspace?: RecoveryWorkspace;
  }>;
  activeId: string;
};

const DATABASE = "opendraft-recovery";
const STORE = "workspace";
const KEY = "latest";

function validate(value: unknown): asserts value is RecoverySnapshot {
  const snapshot = value as RecoverySnapshot | null;
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.documents) ||
    typeof snapshot.activeId !== "string"
  ) {
    throw new Error("Unsupported or damaged recovery snapshot.");
  }
  const ids = new Set<string>();
  if (snapshot.documents.length > 32)
    throw new Error(
      "Recovery supports at most 32 open documents. Export and close some PDFs.",
    );
  let retainedBytes = 0;
  for (const document of snapshot.documents) {
    if (
      !document ||
      typeof document.id !== "string" ||
      !document.id ||
      ids.has(document.id) ||
      typeof document.name !== "string" ||
      !(document.bytes instanceof Uint8Array) ||
      document.bytes.byteLength === 0 ||
      !Number.isInteger(document.page) ||
      document.page < 1 ||
      !Number.isFinite(document.zoom) ||
      document.zoom < 0.25 ||
      document.zoom > 3 ||
      !Array.isArray(document.rotations)
    )
      throw new Error("Unsupported or damaged recovery document.");
    ids.add(document.id);
    retainedBytes += document.bytes.byteLength;
    const pages = new Set<number>();
    for (const rotation of document.rotations) {
      if (
        !Array.isArray(rotation) ||
        rotation.length !== 2 ||
        !Number.isInteger(rotation[0]) ||
        rotation[0] < 1 ||
        pages.has(rotation[0]) ||
        !Number.isFinite(rotation[1]) ||
        rotation[1] % 90 !== 0
      )
        throw new Error("Invalid recovery page rotation.");
      pages.add(rotation[0]);
    }
    if (document.workspace !== undefined) {
      const workspace = document.workspace;
      if (
        !workspace ||
        !Array.isArray(workspace.sources) ||
        workspace.sources.length < 1 ||
        workspace.sources.length > 256 ||
        !Array.isArray(workspace.pages) ||
        !workspace.pages.length ||
        workspace.pages.length > 20000
      )
        throw new Error("Unsupported or damaged editable recovery state.");
      const sourceIds = new Set<string>();
      for (const source of workspace.sources) {
        if (
          !source ||
          typeof source.id !== "string" ||
          !source.id ||
          sourceIds.has(source.id) ||
          !(source.bytes instanceof Uint8Array) ||
          !source.bytes.length
        )
          throw new Error("Invalid editable recovery source.");
        sourceIds.add(source.id);
        retainedBytes += source.bytes.byteLength;
      }
      for (const ref of workspace.pages) {
        if (
          !ref ||
          !sourceIds.has(ref.sourceId) ||
          !Number.isInteger(ref.pageIndex) ||
          ref.pageIndex < 0 ||
          !Number.isFinite(ref.rotation) ||
          ref.rotation % 90 !== 0
        )
          throw new Error("Invalid editable recovery page.");
        if (ref.replacement !== undefined && (
          !ref.replacement ||
          typeof ref.replacement !== 'object' ||
          !sourceIds.has(ref.replacement.sourceId) ||
          !Number.isSafeInteger(ref.replacement.pageIndex) ||
          ref.replacement.pageIndex < 0
        )) throw new Error('Invalid editable recovery replacement page.');
      }
      // Validate the shared page model; PDF parsing checks upper source-page bounds on restore.
      validatePages(workspace.pages);
      if (workspace.revisions !== undefined) validateRevisionJournal(workspace.revisions);
      validateLayerAssignments(workspace.markups, workspace.layers ?? [], workspace.pages.length);
      if (workspace.takeoff !== undefined)
        validateTakeoff(workspace.takeoff, workspace.pages.length);
      if (document.page > workspace.pages.length)
        throw new Error(
          "Recovery current page is outside its editable document.",
        );
    }
    if (retainedBytes > 512 * 1024 * 1024)
      throw new Error(
        "Recovery exceeds the 512 MB retained-byte limit. Export and close some PDFs.",
      );
  }
  if (
    snapshot.documents.length
      ? !ids.has(snapshot.activeId)
      : snapshot.activeId !== ""
  )
    throw new Error("Invalid recovery active document.");
}

function storageError(action: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  const quota =
    error instanceof DOMException && error.name === "QuotaExceededError";
  return new Error(
    quota
      ? "Recovery storage is full. Your current workspace remains open; export your work."
      : `Could not ${action} local recovery: ${reason}`,
    { cause: error },
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser."));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE);
    };
    request.onblocked = () => {
      blocked = true;
      reject(
        new Error("Recovery database upgrade is blocked by another window."),
      );
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Recovery transaction aborted."));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Recovery transaction failed."));
      try {
        const request = operation(transaction.objectStore(STORE));
        request.onsuccess = () => {
          result = request.result;
        };
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  } finally {
    database.close();
  }
}

export async function saveRecovery(snapshot: RecoverySnapshot): Promise<void> {
  try {
    validate(snapshot);
    // Clone before awaiting storage so caller mutations cannot change a pending save.
    const copy = structuredClone(snapshot);
    await transact("readwrite", (store) => store.put(copy, KEY));
  } catch (error) {
    throw storageError("save", error);
  }
}

export async function loadRecovery(): Promise<RecoverySnapshot | null> {
  try {
    const value: unknown = await transact("readonly", (store) =>
      store.get(KEY),
    );
    if (value === undefined) return null;
    validate(value);
    return value;
  } catch (error) {
    throw storageError("read", error);
  }
}

export async function clearRecovery(): Promise<void> {
  try {
    await transact("readwrite", (store) => store.delete(KEY));
  } catch (error) {
    throw storageError("clear", error);
  }
}
