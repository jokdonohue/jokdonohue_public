/**
 * The real Store: an adapter over the platform `db` namespace (`await claude.use("db")`,
 * runtime contract 0.2.96). Same semantics as `createFakeStore` (see src/contract/store.ts).
 *
 * Connection state: `connecting` until the first confirmed answer (a read, a write or a snapshot
 * with `fromCache: false`); `stale` when the 10 s load timer fires first or a call fails
 * transiently; `full` on `quota_exceeded`; `read-only` when a well-formed set/delete is refused
 * with `invalid_argument`; `revoked` on `revoked`. Verbs retry once on `unavailable` after a short
 * random delay, as db.d.ts asks; nothing loops.
 */
import { assertDocPath, assertDocSize } from '../contract/docs';
import {
  checkQuery, StoreError, toStoreError, type ConnectionState, type DocData, type QuerySpec, type SnapshotMeta, type Store, type StoreDoc, type Unsubscribe,
} from '../contract/store';
import type { PlatformDb, PlatformDocSnapshot, PlatformQuery } from './runtime';

export interface DbStoreOptions {
  /** Load timer (plan: 10 s). */
  timeoutMs?: number;
  /** Delay range for the single retry on `unavailable`. */
  retryDelayMs?: [number, number];
}

export function createDbStore(db: PlatformDb, options: DbStoreOptions = {}): Store {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const [minDelay, maxDelay] = options.retryDelayMs ?? [200, 800];
  let state: ConnectionState = 'connecting';
  const listeners = new Set<(s: ConnectionState) => void>();
  const setState = (next: ConnectionState) => {
    if (next === state || state === 'revoked') return;
    state = next;
    for (const l of listeners) setTimeout(() => l(next), 0);
  };
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => { timer = null; if (state === 'connecting') setState('stale'); }, timeoutMs);
  const confirmed = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (state === 'connecting' || state === 'stale') setState('live');
  };
  const failed = (e: StoreError, write: boolean) => {
    if (e.code === 'revoked') setState('revoked');
    else if (e.code === 'quota_exceeded') setState('full');
    else if (e.code === 'unavailable' || e.code === 'resource_exhausted') { if (state === 'live') setState('stale'); }
    else if (write && e.code === 'invalid_argument') setState('read-only');
    return e;
  };
  const sleep = () => new Promise(r => setTimeout(r, minDelay + Math.random() * (maxDelay - minDelay)));
  async function call<T>(fn: () => Promise<T>, kind: 'read' | 'write' | 'update'): Promise<T> {
    try {
      let result: T;
      try { result = await fn(); } catch (first) {
        if (toStoreError(first).code !== 'unavailable') throw first;
        await sleep();
        result = await fn();
      }
      if (kind !== 'read' && (state === 'full' || state === 'read-only')) setState('live');
      confirmed();
      return result;
    } catch (err) {
      // `update` on a missing document is an ordinary invalid_argument, not a write ban.
      throw failed(toStoreError(err), kind === 'write');
    }
  }
  const metaOf = (m: { fromCache: boolean; hasPendingWrites: boolean }): SnapshotMeta => ({ fromCache: !!m.fromCache, hasPendingWrites: !!m.hasPendingWrites });
  const toDoc = <T>(path: string, snap: PlatformDocSnapshot): StoreDoc<T> | null =>
    snap.exists ? { path, id: snap.id, data: (snap.data() ?? {}) as T, meta: metaOf(snap.metadata ?? { fromCache: false, hasPendingWrites: false }) } : null;
  const buildQuery = (spec: QuerySpec): PlatformQuery => {
    checkQuery(spec);
    let q: PlatformQuery = db.collection(spec.collection);
    for (const [field, op, value] of spec.where ?? []) q = q.where(field, op, value);
    if (spec.orderBy) q = q.orderBy(spec.orderBy.field, spec.orderBy.dir ?? 'asc');
    if (spec.limit !== undefined) q = q.limit(spec.limit);
    return q;
  };
  /** Plain JSON, as the fake stores it: drops `undefined` fields and functions, turns Dates into strings. */
  const plain = (data: DocData): DocData => {
    try { return JSON.parse(JSON.stringify(data)) as DocData; } catch (e) { throw new StoreError('invalid_argument', e instanceof Error ? e.message : 'Body is not JSON.'); }
  };
  const sized = (path: string, data: DocData) => {
    try { assertDocSize(data, path); } catch (e) { throw toStoreError(e); }
  };

  return {
    kind: 'db',
    async get<T>(path: string) {
      const ref = db.doc(assertDocPath(path));
      return call(async () => toDoc<T>(path, await ref.get()), 'read');
    },
    async set(path, data) {
      const ref = db.doc(assertDocPath(path));
      const body = plain(data);
      sized(path, body);
      await call(() => ref.set(body), 'write');
    },
    async update(path, data) {
      const ref = db.doc(assertDocPath(path));
      const body = plain(data);
      sized(path, body);
      await call(() => ref.update(body), 'update');
    },
    async delete(path) {
      const ref = db.doc(assertDocPath(path));
      await call(() => ref.delete(), 'write');
    },
    async query<T>(spec: QuerySpec) {
      const q = buildQuery(spec);
      return call(async () => (await q.get()).docs.map(d => ({ path: `${spec.collection}/${d.id}`, id: d.id, data: (d.data() ?? {}) as T })), 'read');
    },
    subscribe<T>(path: string, next: (doc: StoreDoc<T> | null, meta: SnapshotMeta) => void, error?: (e: StoreError) => void): Unsubscribe {
      const ref = db.doc(assertDocPath(path));
      return ref.onSnapshot(snap => {
        if (!snap.metadata.fromCache) confirmed();
        next(toDoc<T>(path, snap), metaOf(snap.metadata));
      }, e => { const err = failed(toStoreError(e), false); error?.(err); });
    },
    subscribeQuery<T>(spec: QuerySpec, next: (docs: StoreDoc<T>[], meta: SnapshotMeta) => void, error?: (e: StoreError) => void): Unsubscribe {
      const q = buildQuery(spec);
      return q.onSnapshot(snap => {
        if (!snap.metadata.fromCache) confirmed();
        next(snap.docs.filter(d => d.exists).map(d => ({ path: `${spec.collection}/${d.id}`, id: d.id, data: (d.data() ?? {}) as T })), metaOf(snap.metadata));
      }, e => { const err = failed(toStoreError(e), false); error?.(err); });
    },
    connection: () => state,
    onConnection(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
