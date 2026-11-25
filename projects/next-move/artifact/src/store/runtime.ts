/**
 * Minimal local types for the platform capabilities the page uses (runtime contract 0.2.96:
 * claude.d.ts, db.d.ts, user.d.ts, permissions.d.ts, downloads.d.ts), and a safe `use()`.
 * Only the members this page calls are typed.
 */

export interface PlatformSnapshotMetadata { fromCache: boolean; hasPendingWrites: boolean }
export interface PlatformDocSnapshot { id: string; exists: boolean; data(): Record<string, unknown> | undefined; metadata: PlatformSnapshotMetadata }
export interface PlatformQuerySnapshot { docs: PlatformDocSnapshot[]; size: number; empty: boolean; metadata: PlatformSnapshotMetadata }
export interface PlatformDbError { code: string; message: string }
export interface PlatformQuery {
  where(field: string, op: string, value: unknown): PlatformQuery;
  orderBy(field: string, dir?: 'asc' | 'desc'): PlatformQuery;
  limit(n: number): PlatformQuery;
  get(): Promise<PlatformQuerySnapshot>;
  onSnapshot(next: (snap: PlatformQuerySnapshot) => void, error?: (e: PlatformDbError) => void): () => void;
}
export interface PlatformDocRef {
  id: string;
  path: string;
  get(): Promise<PlatformDocSnapshot>;
  set(data: Record<string, unknown>): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  onSnapshot(next: (snap: PlatformDocSnapshot) => void, error?: (e: PlatformDbError) => void): () => void;
}
export type PlatformCollectionRef = PlatformQuery & { path: string; doc(id?: string): PlatformDocRef };
export interface PlatformDb {
  doc(path: string): PlatformDocRef;
  collection(path: string): PlatformCollectionRef;
}
export interface PlatformUser {
  isOwner(): Promise<boolean>;
  can(capability: string): Promise<boolean | null>;
}
export interface PlatformPermissions {
  state(name: string): Promise<'granted' | 'prompt' | 'denied' | 'unavailable'>;
}
export interface PlatformDownloads {
  save(request: { filename: string; data: string | Blob | ArrayBuffer | ArrayBufferView }): Promise<{ status: 'saved' | 'delivered' }>;
}

interface ClaudeGlobal { use(name: string): Promise<unknown> }

/** `claude.use(name)`, or null when there is no `window.claude` (a saved copy, tests) or the call fails. Never throws. */
export async function useCapability<T>(name: string, scope: { claude?: unknown } = globalThis as { claude?: unknown }): Promise<T | null> {
  const claude = scope.claude as ClaudeGlobal | undefined;
  if (!claude || typeof claude.use !== 'function') return null;
  try {
    return ((await claude.use(name)) ?? null) as T | null;
  } catch {
    return null;
  }
}
