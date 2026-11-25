/**
 * Store contract: the one interface every component uses to reach the artifact database, plus an
 * in-memory fake with the platform's semantics (runtime contract 0.2.96, db.d.ts), the session
 * writer interface and the props `main.tsx` passes to the Trainer.
 *
 * Frozen after milestone M-a; change only by agreement between B1, B2 and B3.
 *
 * Semantics (same in the fake and the real adapter):
 * - `set` replaces the whole document (creating it); `update` merges and REJECTS `invalid_argument`
 *   when the document is missing; nested plain objects merge recursively, arrays and everything
 *   else replace wholesale. Writes are last-writer-wins; there is no version check on the page side
 *   (`if_version` exists only in Claude's ArtifactData tool).
 * - Every write is checked by `assertDocSize` first and rejects `doc_too_large` without touching
 *   the store.
 * - Delivered data is deep-frozen: clone before editing.
 * - Queries: top-level `where` filters (up to 10), at most one `orderBy` (missing field sorts last),
 *   `limit` 1 to 1000; without `orderBy`, results are ordered by document id.
 * - Subscriptions deliver asynchronously, never inside the call that subscribes. Subscribe once per
 *   doc or query (in React: inside `useEffect` with stable primitive dependencies).
 * - Paths follow the db grammar (see `assertDocPath` in docs.ts); a bad path throws `TypeError`
 *   synchronously.
 */
import { assertCollectionPath, assertDocPath, assertDocSize, DocTooLargeError } from './docs';
import type { SessionAttempt, SessionDoc } from './docs';
import type { CoachClient } from './coach';

// ---------------------------------------------------------------- core types

export type DocData = Record<string, unknown>;
export interface StoreDoc<T = DocData> {
  /** Full document path, e.g. `sessions/s-1-abc`. */
  path: string;
  /** Last path segment. */
  id: string;
  /** Deep-frozen body. */
  data: T;
  /**
   * Provenance of a `get()` result, when the store reports it. `fromCache` or `hasPendingWrites` means
   * the server has not confirmed this view (db.d.ts): never treat such a read as proof that data is
   * stored. Absent means authoritative (the in-memory store).
   */
  meta?: SnapshotMeta;
}
export interface SnapshotMeta {
  /** True when the view is not yet confirmed by the store (cached copy, offline, own unconfirmed write). */
  fromCache: boolean;
  hasPendingWrites: boolean;
}
export type WhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains';
export interface QuerySpec {
  /** Collection path (odd segment count), e.g. `sessions`. */
  collection: string;
  where?: Array<[field: string, op: WhereOp, value: unknown]>;
  orderBy?: { field: string; dir?: 'asc' | 'desc' };
  /** 1 to 1000. */
  limit?: number;
}
export type Unsubscribe = () => void;

/**
 * Error codes: the platform's db codes plus `doc_too_large` (our 180 KiB check) and `timeout`
 * (no answer within the load timer). Treat unknown codes as `unavailable`.
 */
export type StoreErrorCode =
  | 'invalid_argument' | 'resource_exhausted' | 'quota_exceeded' | 'unavailable' | 'revoked'
  | 'not_granted' | 'capability_disabled' | 'capability_removed' | 'transform_error'
  | 'doc_too_large' | 'timeout';
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
  }
}
/** Normalize anything a store call rejected with into a StoreError. */
export function toStoreError(e: unknown): StoreError {
  if (e instanceof StoreError) return e;
  if (e instanceof DocTooLargeError) return new StoreError('doc_too_large', e.message);
  if (e instanceof TypeError) return new StoreError('invalid_argument', e.message);
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown };
  const known: StoreErrorCode[] = ['invalid_argument', 'resource_exhausted', 'quota_exceeded', 'unavailable', 'revoked', 'not_granted', 'capability_disabled', 'capability_removed', 'transform_error', 'doc_too_large', 'timeout'];
  const code = known.includes(o.code as StoreErrorCode) ? (o.code as StoreErrorCode) : 'unavailable';
  return new StoreError(code, typeof o.message === 'string' ? o.message : String(e));
}

/**
 * Connection state, for the banner B2 renders:
 * - `connecting`: waiting for `claude.use("db")` or the first confirmed snapshot (at most 10 s);
 * - `live`: the database answered;
 * - `stale`: 10 s passed with no confirmed answer, or a transient failure; showing cached data;
 * - `local-only`: no database in this view (signed out, not granted, outside claude.ai): progress
 *   is kept on this device only and nothing reaches Claude;
 * - `read-only`: writes are refused for this viewer (`invalid_argument` on a well-formed write);
 * - `full`: a write hit `quota_exceeded` (show a message; Claude rolls up summaries);
 * - `revoked`: access was withdrawn during this page load.
 */
export type ConnectionState = 'connecting' | 'live' | 'stale' | 'local-only' | 'read-only' | 'full' | 'revoked';

export interface Store {
  /** `db` = the artifact database; `memory` = the in-memory fake (tests, or the local-only fallback). */
  readonly kind: 'db' | 'memory';
  /** Read once. A missing (or invisible) document resolves null. */
  get<T = DocData>(path: string): Promise<StoreDoc<T> | null>;
  /** Full replace, creating the document. Rejects StoreError. */
  set(path: string, data: DocData): Promise<void>;
  /** Merge-write; rejects `invalid_argument` when the document does not exist. */
  update(path: string, data: DocData): Promise<void>;
  /** Idempotent delete. */
  delete(path: string): Promise<void>;
  /** Read a collection once, in query order. */
  query<T = DocData>(spec: QuerySpec): Promise<StoreDoc<T>[]>;
  /** Subscribe to one document; `next(null)` when it is missing. `error` fires at most once, then the listener is dead. */
  subscribe<T = DocData>(path: string, next: (doc: StoreDoc<T> | null, meta: SnapshotMeta) => void, error?: (e: StoreError) => void): Unsubscribe;
  /** Subscribe to a query; same contract as `subscribe`. */
  subscribeQuery<T = DocData>(spec: QuerySpec, next: (docs: StoreDoc<T>[], meta: SnapshotMeta) => void, error?: (e: StoreError) => void): Unsubscribe;
  /** Current connection state, and a listener for changes (called async; returns an unsubscribe). */
  connection(): ConnectionState;
  onConnection(listener: (state: ConnectionState) => void): Unsubscribe;
}

// ---------------------------------------------------------------- helpers shared by fake and adapter

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** The platform's `update` merge: nested plain objects merge recursively; everything else replaces. */
export function mergeDoc(base: DocData, patch: DocData): DocData {
  const out: DocData = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isPlain(v) && isPlain(out[k]) ? mergeDoc(out[k] as DocData, v) : v;
  return out;
}
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}
function matches(data: DocData, [field, op, value]: [string, WhereOp, unknown]): boolean {
  const v = data[field];
  switch (op) {
    case '==': return JSON.stringify(v) === JSON.stringify(value);
    case '!=': return v !== undefined && JSON.stringify(v) !== JSON.stringify(value);
    case '<': return v !== undefined && compare(v, value) < 0;
    case '<=': return v !== undefined && compare(v, value) <= 0;
    case '>': return v !== undefined && compare(v, value) > 0;
    case '>=': return v !== undefined && compare(v, value) >= 0;
    case 'in': return Array.isArray(value) && value.some(x => JSON.stringify(x) === JSON.stringify(v));
    case 'not-in': return v !== undefined && Array.isArray(value) && !value.some(x => JSON.stringify(x) === JSON.stringify(v));
    case 'array-contains': return Array.isArray(v) && v.some(x => JSON.stringify(x) === JSON.stringify(value));
  }
}
/** Validate a QuerySpec as the platform would (throws TypeError / StoreError invalid_argument). */
export function checkQuery(spec: QuerySpec): void {
  assertCollectionPath(spec.collection);
  if ((spec.where?.length ?? 0) > 10) throw new StoreError('invalid_argument', 'At most 10 filters.');
  if (spec.limit !== undefined && (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 1000)) throw new StoreError('invalid_argument', 'limit must be 1-1000.');
}
/** Apply a QuerySpec to documents of its collection (direct children only). */
export function runQuery(docs: Map<string, DocData>, spec: QuerySpec): StoreDoc[] {
  const prefix = spec.collection + '/';
  let out: StoreDoc[] = [];
  for (const [path, data] of docs) {
    if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
    if ((spec.where ?? []).every(w => matches(data, w))) out.push({ path, id: path.slice(prefix.length), data });
  }
  out.sort((a, b) => compare(a.id, b.id));
  if (spec.orderBy) {
    const { field, dir = 'asc' } = spec.orderBy;
    out.sort((a, b) => {
      const av = a.data[field], bv = b.data[field];
      if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? 1 : -1;
      return dir === 'desc' ? compare(bv, av) : compare(av, bv);
    });
  }
  if (spec.limit !== undefined) out = out.slice(0, spec.limit);
  return out;
}
const lastSegment = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// ---------------------------------------------------------------- the fake

export interface FakeStoreOptions {
  /** Initial documents, path -> body (not size-checked, so tests can seed anything). */
  seed?: Record<string, DocData>;
  /** Artificial latency per call, ms (default 0: resolves on the next macrotask). */
  latencyMs?: number;
  /** Starting connection state (default `live`). */
  connection?: ConnectionState;
}
export interface FakeStore extends Store {
  readonly kind: 'memory';
  /** Test hook: while offline every call rejects `unavailable` and subscriptions stay silent. */
  setOffline(offline: boolean): void;
  /** Test hook: make the next N writes reject with `code`. */
  failNextWrites(n: number, code?: StoreErrorCode): void;
  /** Test hook: change the reported connection state. */
  setConnection(state: ConnectionState): void;
  /** Number of successful set/update/delete calls, per path. */
  readonly writeCounts: Map<string, number>;
  /** Plain copy of every document. */
  dump(): Record<string, DocData>;
}

/** In-memory Store with the platform's semantics. Used by tests, by B2 before the adapter exists, and as the local-only fallback. */
export function createFakeStore(options: FakeStoreOptions = {}): FakeStore {
  const docs = new Map<string, DocData>();
  for (const [path, data] of Object.entries(options.seed ?? {})) docs.set(assertDocPath(path), deepFreeze(clone(data)));
  const latency = options.latencyMs ?? 0;
  let offline = false;
  let failures: { n: number; code: StoreErrorCode } = { n: 0, code: 'unavailable' };
  let state: ConnectionState = options.connection ?? 'live';
  const writeCounts = new Map<string, number>();
  const docListeners = new Set<{ path: string; fn: () => void }>();
  const queryListeners = new Set<{ spec: QuerySpec; fn: () => void }>();
  const connListeners = new Set<(s: ConnectionState) => void>();
  const wait = () => new Promise<void>(r => setTimeout(r, latency));
  const meta: SnapshotMeta = Object.freeze({ fromCache: false, hasPendingWrites: false });

  const read = (path: string): StoreDoc | null => {
    const data = docs.get(path);
    return data ? { path, id: lastSegment(path), data } : null;
  };
  const notify = (path: string) => {
    for (const l of docListeners) if (l.path === path) setTimeout(l.fn, 0);
    const parent = path.slice(0, path.lastIndexOf('/'));
    for (const l of queryListeners) if (l.spec.collection === parent) setTimeout(l.fn, 0);
  };
  const guard = async () => {
    await wait();
    if (offline) throw new StoreError('unavailable', 'The store cannot be reached (fake offline).');
  };
  const write = async (path: string, apply: () => void) => {
    await guard();
    if (failures.n > 0) { failures.n--; throw new StoreError(failures.code, `Injected ${failures.code}.`); }
    apply();
    writeCounts.set(path, (writeCounts.get(path) ?? 0) + 1);
    notify(path);
  };
  const sized = (path: string, data: DocData) => {
    try { assertDocSize(data, path); } catch (e) { throw toStoreError(e); }
  };

  const store: FakeStore = {
    kind: 'memory',
    writeCounts,
    async get<T>(path: string) { assertDocPath(path); await guard(); return read(path) as StoreDoc<T> | null; },
    async set(path, data) {
      assertDocPath(path);
      if (!isPlain(data)) throw new StoreError('invalid_argument', 'Body must be a plain object.');
      sized(path, data);
      const body = deepFreeze(clone(data));
      await write(path, () => docs.set(path, body));
    },
    async update(path, data) {
      assertDocPath(path);
      if (!isPlain(data)) throw new StoreError('invalid_argument', 'Body must be a plain object.');
      const patch = clone(data);
      // Merge at write time, as the platform does, so overlapping updates to one doc both land.
      await write(path, () => {
        const old = docs.get(path);
        if (!old) throw new StoreError('invalid_argument', `update: ${path} does not exist.`);
        const merged = mergeDoc(clone(old), patch);
        sized(path, merged);
        docs.set(path, deepFreeze(merged));
      });
    },
    async delete(path) { assertDocPath(path); await write(path, () => docs.delete(path)); },
    async query<T>(spec: QuerySpec) { checkQuery(spec); await guard(); return runQuery(docs, spec) as StoreDoc<T>[]; },
    subscribe<T>(path: string, next: (doc: StoreDoc<T> | null, meta: SnapshotMeta) => void) {
      assertDocPath(path);
      let last: DocData | undefined | null = null; let first = true; let live = true;
      const fn = () => {
        if (!live || offline) return;
        const doc = read(path);
        if (!first && doc?.data === last) return;
        first = false; last = doc?.data;
        next(doc as StoreDoc<T> | null, meta);
      };
      const entry = { path, fn };
      docListeners.add(entry);
      setTimeout(fn, latency);
      return () => { live = false; docListeners.delete(entry); };
    },
    subscribeQuery<T>(spec: QuerySpec, next: (docs: StoreDoc<T>[], meta: SnapshotMeta) => void) {
      checkQuery(spec);
      let live = true;
      const fn = () => { if (live && !offline) next(runQuery(docs, spec) as StoreDoc<T>[], meta); };
      const entry = { spec, fn };
      queryListeners.add(entry);
      setTimeout(fn, latency);
      return () => { live = false; queryListeners.delete(entry); };
    },
    connection: () => state,
    onConnection(listener) { connListeners.add(listener); return () => { connListeners.delete(listener); }; },
    setOffline(value) {
      offline = value;
      if (!value) { for (const l of docListeners) setTimeout(l.fn, 0); for (const l of queryListeners) setTimeout(l.fn, 0); }
    },
    failNextWrites(n, code = 'unavailable') { failures = { n, code }; },
    setConnection(next) { if (next === state) return; state = next; for (const l of connListeners) setTimeout(() => l(next), 0); },
    dump() { return Object.fromEntries([...docs].map(([p, d]) => [p, clone(d)])); },
  };
  return store;
}

// ---------------------------------------------------------------- session writer (attempt queue)

/**
 * Key-value persistence for the offline attempt queue. The browser implementation is IndexedDB
 * (`src/store/idbKv.ts`); tests use `createMemoryKv()`.
 */
export interface KvStore {
  /** False when the data does not outlive this page load (IndexedDB missing or blocked). Absent means true. */
  readonly persistent?: boolean;
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}
export function createMemoryKv(): KvStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(k: string) { return data.has(k) ? (clone(data.get(k)) as T) : undefined; },
    async set(k, v) { data.set(k, clone(v)); },
    async delete(k) { data.delete(k); },
    async keys(prefix = '') { return [...data.keys()].filter(k => k.startsWith(prefix)); },
  };
}

/**
 * What the session writer can truthfully say about this device's answers (first matching wins):
 * - `device-full`: IndexedDB refused to store the queue during this load: answers the database has not
 *   confirmed live in memory only and are lost when the page closes (`persistent` is then false too);
 * - `set-aside`: an answer failed validation this load and was set aside: it will never upload;
 * - `error`: the database refused a save permanently (quota_exceeded, invalid_argument, revoked, ...):
 *   the answers stay on this device and are sent on a later save or load, not retried on a timer;
 * - `retrying`: a save failed for a transient reason, timed out with an unknown result, or its
 *   read-back was missing answers: the answers stay on this device and are sent again automatically;
 * - `pending`: some answers are not yet confirmed and a save or read-back is due or in progress;
 * - `saved`: a read-back of the database showed every answer this device holds, and nothing is outstanding.
 * `unconfirmed()` empties only on that read-back confirmation.
 */
export type SaveState = 'saved' | 'pending' | 'retrying' | 'error' | 'set-aside' | 'device-full';
/**
 * Writes this device's attempts to `sessions/<s-startMs-deviceId>` (its single writer).
 * `record` returns at once: the attempt is persisted locally first (KvStore), then the whole session
 * document is written 2 s after the last attempt. Failed writes stay queued and retry on `flush`,
 * on the next attempt and when the browser comes back online. Duplicate attempts (same
 * `puzzleId:at`) are dropped. A session holding 600 attempts rolls over to a new document; one
 * document per device per local day otherwise. An attempt leaves the local queue only after the
 * account database confirmed it: writes to a `local-only` store confirm nothing.
 */
export interface SessionWriter {
  /** False when the queue lives in memory only (no IndexedDB, or IndexedDB refused a write: see `device-full`): unconfirmed answers are lost when the page closes. */
  readonly persistent: boolean;
  /** Document id of the current session (`s-<startMs>-<deviceId>`). */
  readonly sessionId: string;
  record(attempt: SessionAttempt): void;
  /** Write every queued session now. Resolves when written, rejects with the StoreError otherwise (it stays queued). */
  flush(): Promise<void>;
  /** Stamp `endedAt` on the current session and flush. */
  end(): Promise<void>;
  /** Attempts recorded on this device that the store has not confirmed yet (show them in history). */
  unconfirmed(): SessionAttempt[];
  /** Every session document this writer holds locally (current plus unconfirmed older ones). */
  localSessions(): Array<{ id: string; doc: SessionDoc }>;
  saveState(): SaveState;
  onSaveState(listener: (state: SaveState, error?: StoreError) => void): Unsubscribe;
  dispose(): void;
}

// ---------------------------------------------------------------- the main.tsx -> Trainer seam

export type PermissionState = 'granted' | 'prompt' | 'denied' | 'unavailable';
/** The platform `downloads.save`, or null when the view has no downloads (hide the export button). */
export type SaveFile = (file: { filename: string; data: string | Blob }) => Promise<{ status: 'saved' | 'delivered' }>;

/**
 * Everything `main.tsx` hands the Trainer. B2: `components/Trainer.tsx` default-exports
 * `function Trainer(props: TrainerProps)`.
 */
export interface TrainerProps {
  store: Store;
  /** Stable per-browser id (localStorage), safe as a path segment. */
  deviceId: string;
  sessions: SessionWriter;
  /** B3's coach client, or null when `sample` is unavailable in this view (hide the button, keep the static panel). */
  coach: CoachClient | null;
  /** `downloads.save`, or null (hide "Export my progress"). */
  saveFile: SaveFile | null;
  /** True when the viewer is the artifact owner (`user.isOwner()`); null when unknown. */
  isOwner: boolean | null;
}
