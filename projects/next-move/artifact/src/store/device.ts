/** Per-browser device id, kept in localStorage (port plan section 2). Safe as a db path segment. */
export const DEVICE_KEY = 'nextmove.deviceId';
const VALID = /^d[a-z0-9]{6,24}$/;

type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function randomId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.every(b => b === 0)) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return 'd' + [...bytes].map(b => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-2);
}

let memoryId: string | null = null;
/** The stored id, or a new one (stored when storage works; otherwise kept for this page load only). */
export function getDeviceId(storage: StorageLike | null = safeLocalStorage()): string {
  try {
    const stored = storage?.getItem(DEVICE_KEY);
    if (stored && VALID.test(stored)) return stored;
  } catch { /* storage blocked */ }
  const id = memoryId ?? randomId();
  memoryId = id;
  try { storage?.setItem(DEVICE_KEY, id); } catch { /* storage blocked: id lives for this load */ }
  return id;
}

export function safeLocalStorage(): StorageLike | null {
  try { return (globalThis as { localStorage?: StorageLike }).localStorage ?? null; } catch { return null; }
}
