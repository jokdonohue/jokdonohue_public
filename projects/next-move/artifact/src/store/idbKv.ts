/**
 * IndexedDB-backed KvStore for the offline attempt queue (and the pack-chunk cache).
 * Falls back to an in-memory KvStore when IndexedDB is missing or blocked (private window, tests).
 */
import { createMemoryKv, type KvStore } from '../contract/store';

const STORE = 'kv';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openIdbKv(name = 'next-move', factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB): Promise<KvStore & { persistent: boolean }> {
  if (!factory) return { ...createMemoryKv(), persistent: false };
  let db: IDBDatabase;
  try {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE); };
    db = await Promise.race([
      request(open),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('IndexedDB open timed out')), 3000)),
    ]);
  } catch {
    return { ...createMemoryKv(), persistent: false };
  }
  const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  return {
    persistent: true,
    async get<T>(key: string) { return (await request(tx('readonly').get(key))) as T | undefined; },
    async set(key, value) { await request(tx('readwrite').put(JSON.parse(JSON.stringify(value)), key)); },
    async delete(key) { await request(tx('readwrite').delete(key)); },
    async keys(prefix = '') {
      const all = (await request(tx('readonly').getAllKeys())) as IDBValidKey[];
      return all.map(String).filter(k => k.startsWith(prefix));
    },
  };
}
