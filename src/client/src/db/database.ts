/**
 * Thin promise wrapper over IndexedDB. No dependencies -- the raw API is verbose but small,
 * and pulling in a wrapper library would put a third-party package on the critical boot path
 * that docs/adr/0003 is built around keeping tiny.
 */

import { DB_NAME, DB_VERSION, MIGRATIONS, type StoreName } from './schema.js';

export type Mode = 'readonly' | 'readwrite';

let cached: Promise<IDBDatabase> | undefined;

export function openDatabase(name = DB_NAME, version = DB_VERSION): Promise<IDBDatabase> {
  if (name === DB_NAME && cached) return cached;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction!;
      // Run only the migrations this client hasn't seen. oldVersion is 0 on first open.
      for (let v = event.oldVersion; v < version; v++) {
        MIGRATIONS[v]?.(db, tx);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // A newer tab wanting a schema upgrade blocks on this connection; close so it can proceed.
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('IndexedDB upgrade blocked by another open tab.'));
  });

  if (name === DB_NAME) cached = promise;
  return promise;
}

/** Drops the cached connection. Tests and the import path need this. */
export function resetConnection(): void {
  cached = undefined;
}

export function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Runs `work` in a transaction and resolves once the transaction COMMITS, not merely when the
 * last request succeeds. Resolving early is the classic IndexedDB bug: callers observe a write
 * that a later abort silently rolls back.
 */
export async function transact<T>(
  stores: StoreName | StoreName[],
  mode: Mode,
  work: (tx: IDBTransaction) => Promise<T> | T,
  db?: IDBDatabase,
): Promise<T> {
  const database = db ?? (await openDatabase());
  const names = Array.isArray(stores) ? stores : [stores];
  const tx = database.transaction(names, mode);

  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted.'));
  });

  const result = await work(tx);
  await committed;
  return result;
}

export function getAllFromIndex<T>(
  tx: IDBTransaction,
  store: StoreName,
  index: string,
  range?: IDBKeyRange,
): Promise<T[]> {
  return promisify(tx.objectStore(store).index(index).getAll(range) as IDBRequest<T[]>);
}

export function getAll<T>(tx: IDBTransaction, store: StoreName): Promise<T[]> {
  return promisify(tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

export function getById<T>(
  tx: IDBTransaction,
  store: StoreName,
  id: string,
): Promise<T | undefined> {
  return promisify(tx.objectStore(store).get(id) as IDBRequest<T | undefined>);
}

export function put<T>(tx: IDBTransaction, store: StoreName, value: T): Promise<IDBValidKey> {
  return promisify(tx.objectStore(store).put(value) as IDBRequest<IDBValidKey>);
}
