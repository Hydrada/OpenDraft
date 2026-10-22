import { test, expect } from '@playwright/test';

test('recovery preserves binary workspace across reload and clears explicitly', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    // @ts-ignore Browser loads the real Vite module.
    const { saveRecovery, clearRecovery } = await import('/src/recovery.ts');
    await clearRecovery();
    const snapshot = { version: 1, documents: [{ id: 'a', name: 'drawing.pdf', bytes: new Uint8Array([37,80,68,70]), page: 2, zoom: 1.25, rotations: [[2,90]] }], activeId: 'a' };
    const pending = saveRecovery(snapshot);
    snapshot.documents[0].bytes[0] = 0;
    await pending;
  });
  await page.reload();
  const restored = await page.evaluate(async () => {
    // @ts-ignore Browser loads the real Vite module.
    const { loadRecovery, clearRecovery } = await import('/src/recovery.ts');
    const snapshot = await loadRecovery();
    const result = { ...snapshot, documents: snapshot.documents.map((d: any) => ({ ...d, bytes: Array.from(d.bytes) })) };
    await clearRecovery();
    return { result, cleared: await loadRecovery() };
  });
  expect(restored.result).toEqual({ version: 1, documents: [{ id: 'a', name: 'drawing.pdf', bytes: [37,80,68,70], page: 2, zoom: 1.25, rotations: [[2,90]] }], activeId: 'a' });
  expect(restored.cleared).toBeNull();
});

test('invalid snapshots and quota failures preserve the prior atomic snapshot', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // @ts-ignore Browser loads the real Vite module.
    const { saveRecovery, loadRecovery, clearRecovery } = await import('/src/recovery.ts');
    await clearRecovery();
    const valid = { version: 1, documents: [], activeId: '' };
    await saveRecovery(valid);
    const errors: string[] = [];
    for (const invalid of [{ ...valid, version: 2 }, { ...valid, activeId: 'missing' }, { ...valid, documents: [{ id:'a', name:'x', bytes:[1], page:1, zoom:1, rotations:[] }], activeId:'a' }]) {
      try { await saveRecovery(invalid); } catch (error) { errors.push((error as Error).message); }
    }
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException('test quota exhausted', 'QuotaExceededError'); };
    try { await saveRecovery(valid); } catch (error) { errors.push((error as Error).message); }
    finally { IDBObjectStore.prototype.put = original; }
    return { errors, snapshot: await loadRecovery() };
  });
  expect(result.errors).toHaveLength(4);
  expect(result.errors[3]).toContain('Recovery storage is full');
  expect(result.snapshot).toEqual({ version: 1, documents: [], activeId: '' });
});

test('incompatible persisted versions fail visibly instead of silently discarding work', async ({ page }) => {
  await page.goto('/');
  const error = await page.evaluate(async () => {
    // @ts-ignore Browser loads the real Vite module.
    const { clearRecovery, loadRecovery } = await import('/src/recovery.ts');
    await clearRecovery();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('opendraft-recovery', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('workspace', 'readwrite');
        transaction.objectStore('workspace').put({ version: 999, documents: [], activeId: '' }, 'latest');
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    });
    try { await loadRecovery(); return ''; }
    catch (error) { return (error as Error).message; }
    finally { await clearRecovery(); }
  });
  expect(error).toContain('Unsupported or damaged recovery snapshot');
});
