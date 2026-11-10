/**
 * Platform smoke test, run only when the page is opened with `#selftest`. It never calls `sample`,
 * never prompts and touches only `selftest/*` documents, which it deletes again except the final
 * result document `selftest/result-<deviceId>` (evidence for Claude to read with ArtifactData,
 * then delete).
 */
import { useEffect, useState } from 'react';
import { createMemoryKv, StoreError, toStoreError, type DocData, type Store } from '../contract/store';
import { createDbStore } from './dbStore';
import { openIdbKv } from './idbKv';
import { createSessionWriter } from './sessionWriter';
import type { PlatformDb } from './runtime';

export interface CheckResult { name: string; ok: boolean; detail: string; ms: number }
export interface SelfTestEnv {
  store: Store;
  deviceId: string;
  capabilities: Record<string, boolean>;
  sampleState: string | null;
  isOwner: boolean | null;
  connectionLog: Array<{ state: string; atMs: number }>;
  bootMs: number;
}

/** CSP violations seen since this module loaded (it is imported by main.tsx before boot). */
export const cspViolations: string[] = [];
if (typeof document !== 'undefined') {
  document.addEventListener('securitypolicyviolation', e => {
    cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`.slice(0, 200));
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function timed(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  const t = performance.now();
  try { return { name, ok: true, detail: await fn(), ms: Math.round(performance.now() - t) }; } catch (e) {
    const err = toStoreError(e);
    return { name, ok: false, detail: e instanceof Error && !(e instanceof StoreError) ? e.message : `${err.code}: ${err.message}`, ms: Math.round(performance.now() - t) };
  }
}
function assert(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }

function engineCheck(): Promise<string> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let readyAt = 0;
    const worker = new Worker('stockfish-19-lite-single.js');
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('no readyok/bestmove within 15 s')); }, 15_000);
    worker.onerror = e => { clearTimeout(timer); worker.terminate(); reject(new Error(`worker error: ${e.message}`)); };
    worker.onmessage = ev => {
      const line = String(ev.data);
      if (line === 'readyok' && !readyAt) {
        readyAt = performance.now();
        worker.postMessage('position startpos');
        worker.postMessage('go depth 10');
      } else if (line.startsWith('bestmove')) {
        clearTimeout(timer);
        worker.terminate();
        resolve(`readyok after ${Math.round(readyAt - t0)} ms; depth 10 ${line} after ${Math.round(performance.now() - readyAt)} ms`);
      }
    };
    worker.postMessage('uci');
    worker.postMessage('isready');
  });
}

export async function runSelfTest(env: SelfTestEnv, onUpdate: (r: CheckResult[]) => void): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const push = (r: CheckResult) => { results.push(r); onUpdate([...results]); };
  const { store, deviceId } = env;
  const stamp = Date.now();

  push(await timed('script mode', async () => {
    const file = document.querySelector('script[src$="app.js"]');
    return file ? `module file (${file.getAttribute('src')})` : 'classic inline script';
  }));
  push(await timed('capabilities', async () => {
    assert(env.capabilities.db, 'db namespace is null');
    return `${Object.entries(env.capabilities).map(([k, v]) => `${k}:${v ? 'yes' : 'null'}`).join(' ')}; sample permission ${env.sampleState ?? 'n/a'}; isOwner ${env.isOwner}`;
  }));
  push(await timed('store connection', async () => {
    assert(store.kind === 'db', `store kind is ${store.kind}`);
    return `now ${store.connection()}; log ${env.connectionLog.map(c => `${c.state}@${c.atMs}ms`).join(', ') || 'none'}; boot ${env.bootMs} ms`;
  }));
  push(await timed('db round trip', async () => {
    const path = `selftest/rt-${deviceId}-${stamp}`;
    await store.set(path, { kind: 'next-move-selftest', at: stamp, nested: { a: 1 } });
    const back = await store.get<DocData>(path);
    assert(back?.data.at === stamp, 'read-back mismatch');
    await store.update(path, { nested: { b: 2 } });
    const merged = await store.get<{ nested: DocData }>(path);
    assert(merged?.data.nested.a === 1 && merged.data.nested.b === 2, 'update did not merge');
    await store.delete(path);
    assert((await store.get(path)) === null, 'still present after delete');
    return `${path}: set, get, update (merged), delete, get=null`;
  }));
  push(await timed('size guard', async () => {
    const path = `selftest/big-${deviceId}-${stamp}`;
    try { await store.set(path, { s: 'x'.repeat(190 * 1024) }); } catch (e) {
      const err = toStoreError(e);
      assert(err.code === 'doc_too_large', `unexpected ${err.code}`);
      assert((await store.get(path)) === null, 'oversized doc was stored');
      return 'a 190 KiB body is refused locally with doc_too_large';
    }
    await store.delete(path);
    throw new Error('oversized write was accepted');
  }));
  push(await timed('offline queue', async () => {
    const written: string[] = [];
    let failures = 1;
    // Route the writer's sessions/<id> to selftest/q-<id> so no real session is created.
    const route = (path: string) => path.replace(/^sessions\//, 'selftest/q-');
    const routed: Store = {
      ...store,
      get: path => store.get(route(path)),
      async set(path, data) {
        const target = route(path);
        if (failures > 0) { failures--; throw new StoreError('unavailable', 'simulated failed write'); }
        await store.set(target, data);
        written.push(target);
      },
    };
    const writer = await createSessionWriter({ store: routed, kv: createMemoryKv(), deviceId, debounceMs: 60_000, retryMs: 60_000 });
    try {
      const attempt = { puzzleId: 'selftest-1', themes: ['selftest'], correct: true, unassisted: true, hints: 0, revealed: false, durationMs: 1, at: stamp, source: 'bank' as const };
      writer.record(attempt);
      writer.record(attempt);
      let firstFailed = false;
      try { await writer.flush(); } catch { firstFailed = true; }
      assert(firstFailed && writer.saveState() === 'retrying', `first write did not fail as simulated (state ${writer.saveState()})`);
      assert(writer.unconfirmed().length === 1, `queue holds ${writer.unconfirmed().length}`);
      await writer.flush();
      await writer.flush();
      assert(written.length === 1, `${written.length} successful writes`);
      assert(writer.saveState() === 'saved' && writer.unconfirmed().length === 0, `after the retry: ${writer.saveState()}, ${writer.unconfirmed().length} unconfirmed`);
      const doc = await store.get<{ attempts: unknown[] }>(written[0]);
      assert(doc?.data.attempts.length === 1, 'stored attempts != 1');
      await store.delete(written[0]);
      return `simulated failure kept 1 queued attempt (duplicate dropped, state retrying); retry wrote ${written[0]} once, read-back confirmed it (state saved); deleted`;
    } finally { writer.dispose(); }
  }));
  push(await timed('Web Locks', async () => {
    const locks = (navigator as Navigator & { locks?: unknown }).locks;
    return locks ? 'navigator.locks available: one tab owns each queued session' : 'navigator.locks missing: heartbeat fallback in use';
  }));
  push(await timed('IndexedDB queue storage', async () => {
    const kv = await openIdbKv('next-move-selftest');
    assert(kv.persistent, 'IndexedDB unavailable, memory fallback');
    await kv.set('probe', { at: stamp });
    const back = await kv.get<{ at: number }>('probe');
    assert(back?.at === stamp, 'IndexedDB read-back mismatch');
    await kv.delete('probe');
    return 'set, get, delete';
  }));
  push(await timed('engine worker', engineCheck));
  push(await timed('10 s load timer', async () => {
    const hanging = { doc: () => ({ get: () => new Promise(() => {}) }), collection: () => { throw new Error('unused'); } } as unknown as PlatformDb;
    const probe = createDbStore(hanging, { timeoutMs: 10_000 });
    const t = performance.now();
    void probe.get('selftest/never');
    while (probe.connection() === 'connecting' && performance.now() - t < 13_000) await sleep(250);
    assert(probe.connection() === 'stale', `state ${probe.connection()} after 13 s`);
    return `a store with no answer went connecting -> stale after ${Math.round(performance.now() - t)} ms`;
  }));
  await sleep(500);
  push(await timed('CSP violations', async () => {
    assert(cspViolations.length === 0, cspViolations.join(' | '));
    return 'none since the bundle loaded';
  }));

  try {
    await store.set(`selftest/result-${deviceId}`, { at: stamp, userAgent: navigator.userAgent.slice(0, 200), results: results.map(r => ({ ...r })) });
  } catch { /* evidence stays on screen */ }
  return results;
}

export function SelfTestPanel({ env }: { env: SelfTestEnv }) {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let live = true;
    runSelfTest(env, r => { if (live) setResults(r); }).finally(() => { if (live) setDone(true); });
    return () => { live = false; };
    // Runs once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="boot-message selftest" aria-live="polite">
      <h1>Platform self-test</h1>
      <p>{done ? `Finished: ${results.filter(r => r.ok).length} of ${results.length} passed.` : 'Running; the load-timer check takes about 10 seconds.'}</p>
      <ol>
        {results.map(r => <li key={r.name}><strong>{r.ok ? 'PASS' : 'FAIL'}</strong> {r.name} ({r.ms} ms): {r.detail}</li>)}
      </ol>
    </section>
  );
}
