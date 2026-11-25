/** React binding for the trainer model: one model per store, read with useSyncExternalStore. */
import { useMemo, useSyncExternalStore } from 'react';
import type { SessionWriter, Store } from '@/src/contract/store';
import { createTrainerModel, type TrainerModel, type TrainerView } from './model';

export function useArtifactState(store: Store, sessions: SessionWriter, deviceId: string): { view: TrainerView; model: TrainerModel } {
  // Lazy model: subscriptions open when React subscribes and close when it unsubscribes.
  const model = useMemo(() => createTrainerModel({ store, sessions, deviceId, lazy: true }), [store, sessions, deviceId]);
  const view = useSyncExternalStore(model.subscribe, model.get, model.get);
  return { view, model };
}
