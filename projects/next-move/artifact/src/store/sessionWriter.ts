/**
 * The offline attempt queue (port plan section 2): this device's session documents are kept in a
 * KvStore (IndexedDB in the page) and written to `sessions/<s-startMs-deviceId>`, the device being
 * the documents' only writer. See the SessionWriter interface and SaveState in src/contract/store.ts.
 *
 * Invariant (review 2, P0-1 and re-check F1): an answer counts as saved, and leaves the device queue,
 * only when a READ-BACK of its session document shows it. An acknowledged write is not enough; a
 * timeout, an abort, a rejection or a write to the local-only fallback store confirms nothing.
 * `saveState()` is `saved` only when every answer this device holds is confirmed that way and no
 * save is outstanding.
 *
 * One save cycle per session, single-flight (never two at once for one document):
 *   1. read the stored document;
 *   2. if it already holds every local answer (and `endedAt` when ended), confirm without writing
 *      (this is how a write that landed after its timeout is de-duplicated);
 *   3. otherwise write the UNION of stored and local answers (by `puzzleId:at`), so a write never
 *      drops an answer that is already stored;
 *   4. read back; confirm the answers it shows; if any is missing, report `retrying` and go again.
 * A cycle that outlives `writeTimeoutMs` is "unknown": the flush reports `retrying`, the answers stay
 * queued, and the next cycle for that document starts only after this one settles.
 *
 * Only a FRESH read confirms: a `get()` whose snapshot is `fromCache` or `hasPendingWrites` proves
 * nothing (review re-check 2).
 *
 * At load every queued session starts unconfirmed: only a read-back can confirm it again.
 *
 * Tabs: with Web Locks (`navigator.locks`) one tab owns each queued session, and a load continues
 * today's newest open session (one document per device per day). Without Web Locks every tab writes
 * its OWN session document (no day document is continued), and a queued session is adopted only when
 * its owner's heartbeat (stamped every `heartbeatMs`) is older than three intervals. Until then this
 * tab reports `pending`, never `saved`, while such a session holds unconfirmed answers, and re-reads
 * the queue on every flush and heartbeat.
 */
import { ATTEMPTS_PER_SESSION_DOC, attemptKey, DocTooLargeError, paths, prepareWrite, sessionAttemptSchema, type SessionAttempt, type SessionDoc } from '../contract/docs';
import { StoreError, toStoreError, type KvStore, type SaveState, type SessionWriter, type Store, type Unsubscribe } from '../contract/store';

const PREFIX = 'session:';
const BAD_PREFIX = 'bad-session:';
const LOCK_PREFIX = 'next-move-session:';
/**
 * What the KvStore holds per session. `confirmed` = leading local answers a read-back has shown
 * stored (answers only append). `owner` is the heartbeat used when Web Locks are unavailable.
 */
interface Entry { id: string; doc: SessionDoc; confirmed: number; endConfirmed: boolean; rev: number; owner?: { tab: string; at: number } }

/** The subset of the Web Locks API the writer uses. */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => unknown): Promise<unknown>;
}

export interface SessionWriterOptions {
  store: Store;
  kv: KvStore;
  deviceId: string;
  now?: () => number;
  /** Delay after the last attempt before the session document is written (plan: 2 s). */
  debounceMs?: number;
  /** First retry delay after a transient failure; doubles up to 60 s. */
  retryMs?: number;
  /** A save cycle with no result after this long is reported as `retrying` (unknown result; default 30 s). */
  writeTimeoutMs?: number;
  /** Whether the store is the account database. Default: the store is not `local-only`. */
  durable?: () => boolean;
  /** Web Locks, for one owner per queued session across tabs. Default `navigator.locks`; null uses the per-tab fallback. */
  locks?: LockManagerLike | null;
  /** Heartbeat interval for the no-Web-Locks fallback (default 10 s). */
  heartbeatMs?: number;
  /** Listen for `online` and page-hide events on this target (the window in the page). */
  events?: { addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void } | null;
}

const PERMANENT = new Set(['invalid_argument', 'doc_too_large', 'quota_exceeded', 'revoked', 'not_granted', 'capability_disabled', 'capability_removed', 'transform_error']);

/** Local calendar day of an epoch-ms time. */
function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function defaultLocks(): LockManagerLike | null {
  try { return ((globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks) ?? null; } catch { return null; }
}
/** Node keeps a process alive for pending timers; the page has no such concern. */
function unref<T>(timer: T): T { (timer as { unref?: () => void }).unref?.(); return timer; }

/** Load the persisted queue and return a ready writer. Queued sessions are read back and saved at once. */
export async function createSessionWriter(options: SessionWriterOptions): Promise<SessionWriter> {
  const { store, kv, deviceId } = options;
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? 2000;
  const baseRetry = options.retryMs ?? 5000;
  const writeTimeoutMs = options.writeTimeoutMs ?? 30_000;
  const durable = options.durable ?? (() => store.connection() !== 'local-only');
  const locks = options.locks === undefined ? defaultLocks() : options.locks;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const tabId = `t${Math.random().toString(36).slice(2, 10)}`;
  const releasers = new Map<string, () => void>();

  function tryLock(id: string): Promise<boolean> {
    if (!locks) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      try {
        locks.request(LOCK_PREFIX + id, { ifAvailable: true }, lock => {
          if (!lock) { done(false); return undefined; }
          done(true);
          return new Promise<void>(release => { releasers.set(id, release); });
        }).catch(() => done(true));
      } catch { done(true); }
    });
  }
  function release(id: string) { releasers.get(id)?.(); releasers.delete(id); }
  /** Without Web Locks: another tab's session is left alone while its heartbeat is fresh. */
  const ownedElsewhere = (e: Entry) => !locks && !!e.owner && e.owner.tab !== tabId && now() - e.owner.at < 3 * heartbeatMs;

  const entries = new Map<string, Entry>();
  /**
   * Without Web Locks: queued sessions another tab claimed recently (fresh heartbeat), as last read
   * from the queue. While any of them holds unconfirmed answers this tab never reports `saved`, and
   * each flush and heartbeat re-reads them, adopting one once its heartbeat is stale.
   */
  const foreign = new Map<string, Entry>();
  for (const key of await kv.keys(PREFIX)) {
    const entry = await kv.get<Entry>(key);
    if (!entry?.doc || !Array.isArray(entry.doc.attempts)) { await kv.delete(key); continue; }
    if (ownedElsewhere(entry)) { foreign.set(entry.id, entry); continue; }
    if (!(await tryLock(entry.id))) continue; // another open tab owns it
    // Only a read-back on this load can confirm anything.
    entries.set(entry.id, { id: entry.id, doc: entry.doc, confirmed: 0, endConfirmed: false, rev: entry.rev ?? 0, owner: entry.owner });
  }
  const needsSave = (e: Entry) => e.confirmed < e.doc.attempts.length || (e.doc.endedAt !== undefined && !e.endConfirmed);

  // With Web Locks, continue today's newest open session; without them each tab keeps its own document.
  const today = localDay(now());
  let current: Entry | null = !locks ? null : [...entries.values()]
    .filter(e => e.doc.endedAt === undefined && e.doc.attempts.length < ATTEMPTS_PER_SESSION_DOC && localDay(e.doc.startedAt) === today)
    .sort((a, b) => b.doc.startedAt - a.doc.startedAt)[0] ?? null;
  const seen = new Set<string>();
  for (const e of entries.values()) for (const a of e.doc.attempts) seen.add(attemptKey(a));

  let persistent = kv.persistent !== false;
  let deviceFull = false;
  let setAside = 0;
  let failure: { kind: 'retrying' | 'error'; error: StoreError } | null = null;
  let state: SaveState = 'saved';
  const listeners = new Set<(s: SaveState, e?: StoreError) => void>();
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let retryDelay = baseRetry;
  let chain: Promise<void> = Promise.resolve();
  let persistChain: Promise<void> = Promise.resolve();
  let disposed = false;
  /** The one outstanding save cycle per session id. */
  const inflight = new Map<string, Promise<void>>();
  /** Sessions whose cycle outlived a flush: when it settles, flush again. */
  const late = new Set<string>();

  function computeState(): SaveState {
    if (deviceFull) return 'device-full';
    if (setAside > 0) return 'set-aside';
    if (failure) return failure.kind;
    if (inflight.size > 0 || [...entries.values()].some(needsSave) || [...foreign.values()].some(needsSave)) return 'pending';
    return 'saved';
  }
  /** Without Web Locks: re-read the queue; adopt sessions whose owner's heartbeat went stale. */
  async function rescan(): Promise<void> {
    if (locks) return;
    let keys: string[];
    try { keys = await kv.keys(PREFIX); } catch { return; }
    const present = new Set(keys.map(k => k.slice(PREFIX.length)));
    for (const id of [...foreign.keys()]) if (!present.has(id)) foreign.delete(id);
    for (const key of keys) {
      const id = key.slice(PREFIX.length);
      if (entries.has(id)) continue;
      const entry = await kv.get<Entry>(key).catch(() => undefined);
      if (!entry?.doc || !Array.isArray(entry.doc.attempts)) { foreign.delete(id); continue; }
      if (ownedElsewhere(entry)) { foreign.set(id, entry); continue; }
      foreign.delete(id);
      const adopted: Entry = { id: entry.id, doc: entry.doc, confirmed: 0, endConfirmed: false, rev: entry.rev ?? 0, owner: entry.owner };
      entries.set(id, adopted);
      for (const a of adopted.doc.attempts) seen.add(attemptKey(a));
      void persist(adopted); // claim it
    }
  }
  /** Recompute and tell listeners on a change (always on a new failure, so they see each error). */
  function refresh(force = false) {
    const next = computeState();
    if (next === state && !force) return;
    state = next;
    for (const l of listeners) l(next, failure?.error);
  }
  function persist(e: Entry) {
    if (!locks) e.owner = { tab: tabId, at: now() };
    const copy = JSON.parse(JSON.stringify(e)) as Entry;
    persistChain = persistChain.then(() => kv.set(PREFIX + e.id, copy)).catch(() => {
      // IndexedDB refused the write (full or blocked): unconfirmed answers now live in memory only.
      persistent = false;
      if (!deviceFull) { deviceFull = true; refresh(true); }
    });
    return persistChain;
  }
  function forget(e: Entry) {
    entries.delete(e.id);
    persistChain = persistChain.then(() => kv.delete(PREFIX + e.id)).catch(() => undefined);
    release(e.id);
  }
  function newEntry(startMs: number): Entry {
    let start = Math.trunc(startMs);
    while (entries.has(`s-${start}-${deviceId}`)) start++;
    const id = paths.session(start, deviceId).split('/')[1];
    const entry: Entry = { id, doc: { device: deviceId, startedAt: start, attempts: [] }, confirmed: 0, endConfirmed: false, rev: 0 };
    entries.set(id, entry);
    void tryLock(id);
    return entry;
  }
  function schedule(ms: number) {
    if (disposed) return;
    if (debounce) clearTimeout(debounce);
    debounce = unref(setTimeout(() => { debounce = null; flush().catch(() => undefined); }, ms));
  }
  function withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      p.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => { timer = unref(setTimeout(() => reject(new StoreError('timeout', `No result from the database after ${writeTimeoutMs} ms; the answers are kept and sent again.`)), writeTimeoutMs)); }),
    ]);
  }

  type StoredSession = { attempts?: unknown[]; endedAt?: number };
  /** A read the server has confirmed (not served from cache, no pending local write). Only such a read can confirm answers. */
  type Read = { data: StoredSession | undefined; fresh: boolean };
  async function readSession(path: string): Promise<Read> {
    const doc = await store.get<StoredSession>(path);
    return { data: doc?.data, fresh: !doc?.meta || (!doc.meta.fromCache && !doc.meta.hasPendingWrites) };
  }
  const keysOf = (doc: StoredSession | undefined) => new Set((doc?.attempts ?? []).map(a => attemptKey(a as { puzzleId: string; at: number })));
  /** Mark the first `count` local answers (and `endedAt`) confirmed if `stored` shows them. Returns true when all are shown. */
  /** The answer keys the last read-back of each session showed (used to avoid re-storing them when salvaging). */
  const lastShown = new Map<string, Set<string>>();
  async function confirmFrom(e: Entry, read: Read, count: number, ended: boolean): Promise<boolean> {
    if (!read.fresh) return false; // a cached or pending view proves nothing
    const stored = read.data;
    const have = keysOf(stored);
    lastShown.set(e.id, have);
    let shown = 0;
    while (shown < count && have.has(attemptKey(e.doc.attempts[shown]))) shown++;
    e.confirmed = Math.max(e.confirmed, shown);
    if (ended && stored?.endedAt !== undefined) e.endConfirmed = true;
    const complete = shown === count && (!ended || e.endConfirmed);
    if (entries.has(e.id)) {
      if (!needsSave(e) && e !== current) forget(e);
      else await persist(e);
    }
    return complete;
  }

  /** One single-flight save cycle: read, write the union if needed, read back. */
  async function cycle(e: Entry): Promise<void> {
    const path = `sessions/${e.id}`;
    const count = e.doc.attempts.length;
    const ended = e.doc.endedAt !== undefined;
    if (!durable()) {
      // Local-only: show the answers on the page; nothing is confirmed.
      await store.set(path, prepareWrite(path, e.doc));
      return;
    }
    const beforeRead = await readSession(path);
    const before = beforeRead.data;
    if (await confirmFrom(e, beforeRead, count, ended)) return; // already stored: no write
    const local = e.doc.attempts.slice(0, count);
    const localKeys = new Set(local.map(attemptKey));
    const storedOnly = (before?.attempts ?? []).filter(a => sessionAttemptSchema.safeParse(a).success && !localKeys.has(attemptKey(a as SessionAttempt))) as SessionAttempt[];
    let attempts = [...storedOnly, ...local].sort((a, b) => a.at - b.at);
    if (attempts.length > ATTEMPTS_PER_SESSION_DOC) attempts = local; // cannot happen with one writer; never exceed the cap
    const body = prepareWrite(path, { ...e.doc, attempts, ...(ended ? { endedAt: e.doc.endedAt } : {}) });
    await store.set(path, body);
    if (!(await confirmFrom(e, await readSession(path), count, ended))) throw new StoreError('unavailable', 'The read-back did not confirm every answer yet; sending again.');
  }

  /** Run (or join) the single save cycle for this session, bounded by the timeout. */
  async function saveOne(e: Entry): Promise<void> {
    const prior = inflight.get(e.id);
    if (prior) {
      try { await withTimeout(prior.catch(() => undefined)); } catch (err) { late.add(e.id); throw err; }
    }
    if (!entries.has(e.id) || !needsSave(e)) return;
    const run: Promise<void> = cycle(e).finally(() => {
      if (inflight.get(e.id) === run) inflight.delete(e.id);
      if (late.delete(e.id) && !disposed) schedule(0);
    });
    inflight.set(e.id, run);
    run.catch(() => undefined);
    try { await withTimeout(run); } catch (err) {
      if (err instanceof StoreError && err.code === 'timeout') late.add(e.id);
      throw err;
    }
  }

  function flush(): Promise<void> {
    if (debounce) { clearTimeout(debounce); debounce = null; }
    const run = chain.then(async () => {
      await rescan();
      const pending = [...entries.values()].filter(needsSave);
      if (pending.length === 0) { if (inflight.size === 0) failure = null; refresh(); return; }
      refresh();
      let firstError: StoreError | null = null;
      for (const e of pending) {
        try { await saveOne(e); } catch (err) {
          if (!(err instanceof StoreError) && !(err instanceof DocTooLargeError)) {
            // Not a store condition (a schema failure): it can never be written. Set it aside so it
            // does not block later sessions; it stays in the KvStore under `bad-session:` for inspection.
            const wasCurrent = current === e;
            if (wasCurrent) current = null;
            forget(e);
            setAside++;
            persistChain = persistChain.then(() => kv.set(BAD_PREFIX + e.id, { entry: e, error: err instanceof Error ? err.message : String(err) })).catch(() => undefined);
            // Salvage the valid answers no read-back has shown yet into a fresh session.
            const shown = lastShown.get(e.id) ?? new Set<string>();
            const good = e.doc.attempts.slice(e.confirmed).filter(a => sessionAttemptSchema.safeParse(a).success && !shown.has(attemptKey(a)));
            if (good.length > 0 && good.length < e.doc.attempts.length - e.confirmed) {
              const fresh = newEntry(now());
              fresh.doc.attempts = good;
              fresh.rev = 1;
              void persist(fresh);
              if (wasCurrent) current = fresh;
              schedule(0);
            }
            firstError ??= new StoreError('invalid_argument', `Session ${e.id} failed validation and was set aside.`);
            continue;
          }
          firstError ??= toStoreError(err);
        }
      }
      if (firstError) {
        const error = firstError;
        const transient = !PERMANENT.has(error.code);
        failure = { kind: transient ? 'retrying' : 'error', error };
        refresh(true);
        if (transient && !disposed) {
          if (retry) clearTimeout(retry);
          retry = unref(setTimeout(() => { retry = null; flush().catch(() => undefined); }, retryDelay));
          retryDelay = Math.min(retryDelay * 2, 60_000);
        }
        throw error;
      }
      retryDelay = baseRetry;
      if (inflight.size === 0 && ![...entries.values()].some(needsSave)) failure = null;
      refresh();
    });
    chain = run.catch(() => undefined);
    return run;
  }

  const onOnline = () => { retryDelay = baseRetry; flush().catch(() => undefined); };
  const onHide = () => { if ((globalThis as { document?: { visibilityState?: string } }).document?.visibilityState !== 'visible') flush().catch(() => undefined); };
  options.events?.addEventListener('online', onOnline);
  options.events?.addEventListener('visibilitychange', onHide);
  options.events?.addEventListener('pagehide', onHide);
  if (!locks) {
    // Claim adopted sessions now, then keep the claim fresh while this tab is open.
    for (const e of entries.values()) void persist(e);
    heartbeat = unref(setInterval(() => {
      for (const e of entries.values()) void persist(e);
      if (foreign.size > 0) flush().catch(() => undefined); // adopts and uploads a closed tab's queue once its heartbeat is stale
    }, heartbeatMs));
  }

  state = computeState();
  if (entries.size > 0 || foreign.size > 0) flush().catch(() => undefined);

  const writer: SessionWriter = {
    get persistent() { return persistent; },
    get sessionId() {
      if (!current) current = newEntry(now());
      return current.id;
    },
    record(attempt) {
      const parsed = sessionAttemptSchema.safeParse(attempt);
      if (!parsed.success) throw new TypeError(`Invalid attempt: ${parsed.error.issues[0]?.message ?? 'schema'}`);
      const a = parsed.data as SessionAttempt;
      const key = attemptKey(a);
      if (seen.has(key)) return;
      seen.add(key);
      if (!current || current.doc.endedAt !== undefined || localDay(current.doc.startedAt) !== localDay(now())) {
        if (current && current.doc.attempts.length > 0 && current.doc.endedAt === undefined) {
          current.doc.endedAt = now();
          current.rev++;
          void persist(current);
        }
        current = newEntry(now());
      }
      if (current.doc.attempts.length >= ATTEMPTS_PER_SESSION_DOC) {
        current.doc.endedAt = now();
        current.rev++;
        void persist(current);
        current = newEntry(now());
      }
      current.doc.attempts.push(a);
      current.rev++;
      void persist(current);
      refresh();
      schedule(debounceMs);
    },
    flush,
    async end() {
      if (current && current.doc.attempts.length > 0 && current.doc.endedAt === undefined) {
        current.doc.endedAt = now();
        current.rev++;
        await persist(current);
        const ended = current;
        current = null;
        try { await flush(); } finally {
          if (!needsSave(ended) && !inflight.has(ended.id) && entries.has(ended.id)) forget(ended);
        }
      } else {
        await flush();
      }
    },
    unconfirmed() {
      return [...entries.values()].flatMap(e => e.doc.attempts.slice(e.confirmed));
    },
    localSessions() {
      return [...entries.values()].filter(e => e.doc.attempts.length > 0).map(e => ({ id: e.id, doc: JSON.parse(JSON.stringify(e.doc)) as SessionDoc }));
    },
    saveState: () => state,
    onSaveState(listener): Unsubscribe { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      if (retry) clearTimeout(retry);
      if (heartbeat) clearInterval(heartbeat);
      for (const id of [...releasers.keys()]) release(id);
      options.events?.removeEventListener('online', onOnline);
      options.events?.removeEventListener('visibilitychange', onHide);
      options.events?.removeEventListener('pagehide', onHide);
    },
  };
  return writer;
}
