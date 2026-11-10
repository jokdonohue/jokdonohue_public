/**
 * Page entry: resolves the platform capabilities, builds the Store, the session writer and the
 * coach, then mounts the Trainer (B2) with `TrainerProps`. Nothing here calls `sample` or
 * prompts for a permission; the coach asks only on the learner's click.
 */
import { createRoot } from 'react-dom/client';
import { Component, type ReactNode } from 'react';
import Trainer from '@/components/Trainer';
import { createCoach } from '@/src/coach';
import { paths, SCHEMA_VERSION } from '@/src/contract/docs';
import { createFakeStore, type SaveFile, type Store, type TrainerProps } from '@/src/contract/store';
import type { CoachClient, PermissionsApi, SampleFn } from '@/src/contract/coach';
import { createDbStore } from '@/src/store/dbStore';
import { getDeviceId, safeLocalStorage } from '@/src/store/device';
import { openIdbKv } from '@/src/store/idbKv';
import { createSessionWriter } from '@/src/store/sessionWriter';
import { useCapability, type PlatformDb, type PlatformDownloads, type PlatformUser } from '@/src/store/runtime';
import { SelfTestPanel, type SelfTestEnv } from '@/src/store/selftest';

const bootStart = performance.now();
const selfTest = typeof location !== 'undefined' && location.hash === '#selftest';

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boot-message" role="alert">
        <h1>Next Move stopped</h1>
        <p>Something in the page failed: {this.state.error.message}</p>
        <p>Your answers saved so far are kept. Reload the page to continue.</p>
      </div>
    );
  }
}

/** First run: write `meta/schema` once. Best effort; a read-only viewer simply skips it. */
async function ensureSchema(store: Store): Promise<void> {
  try {
    if (!(await store.get(paths.schema()))) await store.set(paths.schema(), { schemaVersion: SCHEMA_VERSION, createdAt: Date.now() });
  } catch { /* not writable or offline: the next load tries again */ }
}

let selfTestEnv: SelfTestEnv | null = null;

async function boot(): Promise<TrainerProps> {
  const deviceId = getDeviceId();
  const [db, user, sample, permissions, downloads] = await Promise.all([
    useCapability<PlatformDb>('db'),
    useCapability<PlatformUser>('user'),
    useCapability<SampleFn>('sample'),
    useCapability<PermissionsApi>('permissions'),
    useCapability<PlatformDownloads>('downloads'),
  ]);
  const store: Store = db ? createDbStore(db) : createFakeStore({ connection: 'local-only' });
  const connectionLog: SelfTestEnv['connectionLog'] = [{ state: store.connection(), atMs: Math.round(performance.now() - bootStart) }];
  store.onConnection(state => connectionLog.push({ state, atMs: Math.round(performance.now() - bootStart) }));
  const kv = await openIdbKv();
  const sessions = await createSessionWriter({
    store, kv, deviceId,
    events: typeof window === 'undefined' ? null : window,
  });
  // Local-only: the writer's first flush copies this device's queued sessions into the memory store
  // for display, without treating them as saved; the next load with the database uploads them.
  if (db) void ensureSchema(store);
  let coach: CoachClient | null = null;
  if (sample) {
    try { coach = createCoach({ sample, permissions, store, deviceId, storage: safeLocalStorage() ?? undefined }); } catch { coach = null; }
  }
  const saveFile: SaveFile | null = downloads ? file => downloads.save(file) : null;
  const isOwner = user ? await user.isOwner().catch(() => null) : null;
  if (selfTest) {
    const sampleState = permissions ? await permissions.state('sample').catch(() => null) : null;
    selfTestEnv = {
      store, deviceId, isOwner, sampleState, connectionLog, bootMs: Math.round(performance.now() - bootStart),
      capabilities: { db: !!db, user: !!user, sample: !!sample, permissions: !!permissions, downloads: !!downloads },
    };
  }
  return { store, deviceId, sessions, coach, saveFile, isOwner };
}

const host = document.getElementById('root');
if (host) {
  const root = createRoot(host);
  boot().then(
    props => root.render(selfTestEnv ? <SelfTestPanel env={selfTestEnv} /> : <Boundary><Trainer {...props} /></Boundary>),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      root.render(<div className="boot-message" role="alert"><h1>Next Move could not start</h1><p>{message}</p><p>Reload the page to try again.</p></div>);
    },
  );
}
