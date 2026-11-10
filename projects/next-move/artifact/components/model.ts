/**
 * React-free trainer model: subscribes to the artifact database through the Store contract and keeps
 * one immutable view for the UI (`useArtifactState` wraps it with useSyncExternalStore).
 *
 * The page writes only page-owned documents (settings, feedback) and the pinned fields of agent-owned
 * ones (`notes.readAt`, `drills.rejected`), always with `update` so passthrough fields survive.
 * Attempts go through the SessionWriter; this model only reads them back.
 */
import { Chess } from 'chess.js';
import {
  attemptKey, DEFAULT_SETTINGS, noteDoc, packChunkIds, paths, prepareWrite, readDoc, sessionAttemptSchema, settingsDoc,
  type AttemptSource, type DrillCard, type DrillsDoc, type FeedbackDoc, type PackCardDoc, type PackChunkDoc, type PackMetaDoc,
  type PersonalDoc, type PlanDoc, type PuzzleDoc, type SummaryDoc, drillsDoc,
  type SessionAttempt, type SessionDoc, type SettingsDoc,
  MAX_DOC_ERRORS, schemaForPath, type OpeningsDoc, type TransferDoc, type SafeCardDoc, type SafeChunkDoc, type SafeMetaDoc,
} from '@/src/contract/docs';
import { toStoreError, type ConnectionState, type SaveState, type SessionWriter, type Store, type StoreDoc, type Unsubscribe } from '@/src/contract/store';
import { DEFAULT_NEW_CAP, DEFAULT_REVIEW_CAP } from './daily';
import { isPutBack } from './leech';

export interface ModelSettings {
  rating: number;
  sessionLength: number;
  dailyReviewCap: number;
  dailyNewCap: number;
  chesscomUser?: string;
  /** M2 (R-PGN-1): the names he plays under, for the PGN import's side detection. */
  myNames?: string[];
  updatedAt: number;
}
export interface LoadedPack {
  version: string;
  meta: PackMetaDoc;
  /** `cards` and `special` chunk cards, deduplicated by id. */
  cards: PackCardDoc[];
  /** Item a: "punish it" cards (opponent to move after his game move). */
  punish: PackCardDoc[];
  /** Stalemate study items (`set: "stalemate"`, special chunks). Never scheduled or graded. */
  study: Array<Record<string, unknown> & { id: string; fen: string }>;
  /** Ungraded "punish it" worked examples (`set: "punish"`, punish chunks). Never scheduled, graded or recorded. */
  punishStudy: Array<Record<string, unknown> & { id: string; fen: string }>;
}
/** M2 (D1): the "Safe or not?" cards, from `safe/meta` and its chunks. Absent on a database without them (D2). */
export interface LoadedSafe {
  version: string;
  cards: SafeCardDoc[];
}
/** M2 (D10): an agent document the page could not read. */
export interface DocError { path: string; issue: string; at: number }
export interface NoteView { id: string; text: string; createdAt: number; read: boolean }
export interface DrillSetView { id: string; title: string; reason: string; cards: DrillCard[]; rejected: Array<{ id: string; reason: string }> }
export interface TrainerView {
  ready: boolean;
  /**
   * True once settings and history have arrived from the store itself (not a cached copy, not the load timer).
   * Writes that recompute from history (`derived/snapshot`) or rewrite settings wait for this (review P2-3).
   */
  synced: boolean;
  connection: ConnectionState;
  saveState: SaveState;
  /** Answers on this device that the account database has not positively confirmed (`sessions.unconfirmed()`). */
  unconfirmed: number;
  settings: ModelSettings;
  /** Every attempt this view knows of, deduplicated by `puzzleId:at`, oldest first. "Put it back" markers are not in here. */
  attempts: SessionAttempt[];
  /** M2 (D7): "Put it back" markers (`putback:<cardId>`), oldest first. */
  putBacks: SessionAttempt[];
  pack: LoadedPack | null;
  /** The plan document as stored; use `activePlan` to respect `expires`. */
  plan: PlanDoc | null;
  notes: NoteView[];
  openFeedback: Array<{ id: string; doc: FeedbackDoc }>;
  /** Item ids with open "wrong" feedback (including ones sent from this page and not yet echoed back). */
  flaggedWrong: ReadonlySet<string>;
  drills: DrillSetView[];
  /** Positions from `personal/*` (Site-backup import). */
  personal: PuzzleDoc[];
  /** M2: "Safe or not?" cards, or null when the database has none (the feature is then absent). */
  safe: LoadedSafe | null;
  /** M2 (D8): `openings/accidents`, or null when absent or unreadable. */
  openings: OpeningsDoc | null;
  /** M2 (D9): `transfer/history`, or null when absent or unreadable. */
  transfer: TransferDoc | null;
  /** M2 (D10): agent documents that failed validation and were skipped (newest first, at most 20). */
  docErrors: DocError[];
  /** Plain-language problem to show, or ''. */
  error: string;
}

export interface FeedbackInput {
  kind: FeedbackDoc['kind'];
  item: { id: string; source: AttemptSource; themes: string[]; fen: string };
  playedUci?: string;
  text?: string;
}

export interface TrainerModel {
  get(): TrainerView;
  subscribe(listener: () => void): Unsubscribe;
  /** Persist one finished attempt (validated first). Returns false when it was invalid. */
  record(attempt: SessionAttempt): boolean;
  saveSettings(patch: Partial<Pick<SettingsDoc, 'rating' | 'sessionLength' | 'dailyReviewCap' | 'dailyNewCap' | 'chesscomUser' | 'myNames'>>): Promise<boolean>;
  markNoteRead(id: string): Promise<void>;
  sendFeedback(input: FeedbackInput): Promise<boolean>;
  dismissError(): void;
  dispose(): void;
}

export interface ModelOptions {
  store: Store;
  sessions: SessionWriter;
  deviceId: string;
  now?: () => number;
  /** Show the page with what has arrived after this long, even if some subscriptions are silent. */
  readyTimeoutMs?: number;
  /** First retry delay for a failed pack chunk read (then x3, three retries). */
  packRetryMs?: number;
  /**
   * Lazy: open the subscriptions on the first `subscribe` and close them when the last listener leaves
   * (the React hook uses this, so a render React throws away leaves nothing running). Default: eager.
   */
  lazy?: boolean;
}

const DEFAULT_VIEW_SETTINGS: ModelSettings = { ...DEFAULT_SETTINGS, dailyReviewCap: DEFAULT_REVIEW_CAP, dailyNewCap: DEFAULT_NEW_CAP, updatedAt: 0 };

export function settingsFrom(doc: unknown): ModelSettings {
  const parsed = settingsDoc.safeParse(doc);
  if (!parsed.success) return DEFAULT_VIEW_SETTINGS;
  const s = parsed.data;
  return {
    rating: s.rating, sessionLength: s.sessionLength, updatedAt: s.updatedAt,
    dailyReviewCap: s.dailyReviewCap ?? DEFAULT_REVIEW_CAP, dailyNewCap: s.dailyNewCap ?? DEFAULT_NEW_CAP,
    ...(s.chesscomUser ? { chesscomUser: s.chesscomUser } : {}),
    ...(s.myNames?.length ? { myNames: s.myNames } : {}),
  };
}

/** Attempts from session documents plus local ones not yet echoed back, deduplicated and sorted by time. */
export function collectAttempts(docs: readonly SessionDoc[], ...local: ReadonlyArray<readonly SessionAttempt[]>): SessionAttempt[] {
  const byKey = new Map<string, SessionAttempt>();
  for (const doc of docs) for (const a of doc.attempts) byKey.set(attemptKey(a), a);
  for (const list of local) for (const a of list) if (!byKey.has(attemptKey(a))) byKey.set(attemptKey(a), a);
  return [...byKey.values()].sort((a, b) => a.at - b.at || a.puzzleId.localeCompare(b.puzzleId));
}

/** Check an agent drill line with chess.js; returns the reason it fails, or null. */
export function drillProblem(card: Pick<DrillCard, 'fen' | 'moves'>): string | null {
  let board: Chess;
  try { board = new Chess(card.fen); } catch { return 'The position (FEN) is not valid.'; }
  for (const [i, uci] of card.moves.entries()) {
    try { board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); }
    catch { return `Move ${i + 1} (${uci}) is not legal in this line.`; }
  }
  return null;
}

/** Split a drill set into valid cards and rejected ones. */
export function checkDrillSet(id: string, doc: { title: string; reason: string; cards: DrillCard[] }): DrillSetView {
  const cards: DrillCard[] = [], rejected: Array<{ id: string; reason: string }> = [];
  for (const card of doc.cards) {
    const problem = drillProblem(card);
    if (problem) rejected.push({ id: card.id, reason: problem }); else cards.push(card);
  }
  return { id, title: doc.title, reason: doc.reason, cards, rejected };
}

/** Assemble a pack from its meta and chunk documents; null when a listed chunk is missing or invalid. */
export function assemblePack(meta: PackMetaDoc, chunks: ReadonlyArray<{ id: string; data: unknown } | null>): LoadedPack | null {
  const cards = new Map<string, PackCardDoc>(), punish = new Map<string, PackCardDoc>();
  const study = new Map<string, Record<string, unknown> & { id: string; fen: string }>();
  const punishStudy = new Map<string, Record<string, unknown> & { id: string; fen: string }>();
  for (const chunk of chunks) {
    if (!chunk) return null;
    const doc = readDoc<PackChunkDoc>(`pack/${chunk.id}`, chunk.data);
    if (!doc) return null;
    const part = doc.part ?? /-(cards|special|punish|safe)-\d{2,}$/.exec(chunk.id)?.[1];
    if (part === 'safe') continue; // item b is M2
    const target = part === 'punish' ? punish : cards;
    for (const card of doc.cards) if (!target.has(card.id)) target.set(card.id, part === 'punish' && !card.kind ? { ...card, kind: 'punish' } : card);
    for (const item of doc.study ?? []) {
      const target = item.set === 'punish' || (part === 'punish' && item.set === undefined) ? punishStudy : study;
      if (!target.has(item.id)) target.set(item.id, item);
    }
  }
  return { version: meta.packVersion, meta, cards: [...cards.values()], punish: [...punish.values()], study: [...study.values()], punishStudy: [...punishStudy.values()] };
}

function noteFrom(id: string, data: unknown, readLocally: ReadonlySet<string>): NoteView | null {
  const doc = noteDoc.safeParse(data);
  if (!doc.success) return null;
  const created = typeof doc.data.createdAt === 'number' ? doc.data.createdAt : Date.parse(doc.data.createdAt);
  return { id, text: doc.data.text, createdAt: Number.isFinite(created) ? created : 0, read: doc.data.readAt !== undefined || readLocally.has(id) };
}

/** The first validation issues of a document at `path`, in at most 300 characters; '' when it is valid or unknown. */
export function docIssue(path: string, data: unknown): string {
  let schema;
  try { schema = schemaForPath(path); } catch { return 'not a valid document path'; }
  if (!schema) return '';
  const parsed = schema.safeParse(data);
  if (parsed.success) return '';
  return parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.') || 'document'}: ${i.message}`).join('; ').slice(0, 300);
}

/** Assemble the "Safe or not?" cards from the chunks that loaded (cards are independent, so a missing chunk only shrinks the set). */
export function assembleSafe(meta: SafeMetaDoc, chunks: ReadonlyArray<{ id: string; data: unknown } | null>): LoadedSafe {
  const cards = new Map<string, SafeCardDoc>();
  for (const chunk of chunks) {
    const doc = chunk ? readDoc<SafeChunkDoc>(`safe/${chunk.id}`, chunk.data) : null;
    for (const card of doc?.cards ?? []) if (!cards.has(card.id)) cards.set(card.id, card);
  }
  return { version: meta.packVersion, cards: [...cards.values()] };
}

const PLAIN_ERRORS: Partial<Record<string, string>> = {
  quota_exceeded: 'Storage for this page is full. Your answers stay on this device; Claude can tidy older history.',
  doc_too_large: 'That record is too large to save.',
  revoked: 'Access to your saved progress was withdrawn. Reload the page.',
  invalid_argument: 'This view cannot save changes.',
};
const PACK_ERROR = 'Part of your personal pack could not be loaded. Practice continues with the positions available.';
const plain = (e: unknown) => PLAIN_ERRORS[toStoreError(e).code] ?? 'Saving did not work just now. It will be tried again.';

export function createTrainerModel(options: ModelOptions): TrainerModel {
  const { store, sessions, deviceId } = options;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const unsubs: Unsubscribe[] = [];
  let disposed = false;

  let sessionDocs: SessionDoc[] = [];
  let settings = DEFAULT_VIEW_SETTINGS;
  /** The stored settings document as parsed, so a save keeps fields this page does not edit (e.g. `lastIngest`). */
  let storedSettings: SettingsDoc | null = null;
  let pack: LoadedPack | null = null;
  let plan: PlanDoc | null = null;
  let noteDocs: Array<StoreDoc> = [];
  let openFeedback: Array<{ id: string; doc: FeedbackDoc }> = [];
  let drills: DrillSetView[] = [];
  let personal: PuzzleDoc[] = [];
  let safe: LoadedSafe | null = null;
  let openings: OpeningsDoc | null = null;
  let transfer: TransferDoc | null = null;
  let safeToken = 0;
  let safeRetry: ReturnType<typeof setTimeout> | null = null;
  /** D10: unreadable agent documents by path; `at` is when this page first saw the current issue. */
  const docErrors = new Map<string, DocError>();
  /** Record (or clear, when `issue` is '') the validation problem of an agent document. */
  function noteDocError(path: string, issue: string) {
    if (!issue) { docErrors.delete(path); return; }
    const old = docErrors.get(path);
    if (old && old.issue === issue) return;
    docErrors.set(path, { path, issue, at: now() });
  }
  /** Clear every recorded problem under a path prefix that is not in `keep`. */
  function clearDocErrors(prefix: string, keep: ReadonlySet<string> = new Set()) {
    for (const p of [...docErrors.keys()]) if (p.startsWith(prefix) && !keep.has(p)) docErrors.delete(p);
  }
  let error = '';
  const recorded = new Map<string, SessionAttempt>();
  const localFlags = new Set<string>();
  const readLocally = new Set<string>();
  // First delivery (or error) of everything the first pick depends on; the load timer is the only escape.
  const arrived = { settings: false, sessions: false, pack: false, plan: false, feedback: false };
  let timedOut = false;
  let packToken = 0;
  const packRetryMs = options.packRetryMs ?? 5000;
  let lastFeedbackMs = 0;

  const isReady = () => timedOut || Object.values(arrived).every(Boolean);
  const confirmed = { settings: false, sessions: false };
  let summaryAttempts: SessionAttempt[] = [];
  let packRetry: ReturnType<typeof setTimeout> | null = null;

  let view: TrainerView = build();
  function build(): TrainerView {
    const all = collectAttempts(sessionDocs, summaryAttempts, sessions.unconfirmed(), [...recorded.values()]);
    const attempts = all.filter(a => !isPutBack(a)), putBacks = all.filter(isPutBack);
    const flagged = new Set(openFeedback.filter(f => f.doc.kind === 'wrong').map(f => f.doc.itemId));
    for (const id of localFlags) flagged.add(id);
    const notes = noteDocs.map(d => noteFrom(d.id, d.data, readLocally)).filter((n): n is NoteView => !!n).sort((a, b) => b.createdAt - a.createdAt);
    return {
      ready: isReady(), synced: confirmed.settings && confirmed.sessions, connection: store.connection(), saveState: sessions.saveState(), unconfirmed: sessions.unconfirmed().length, settings, attempts, putBacks, pack, plan, notes,
      // A flag on a set id sets the whole drill set aside; flags on card ids are applied by selection.
      openFeedback, flaggedWrong: flagged, drills: drills.filter(set => !flagged.has(set.id)), personal, safe, openings, transfer,
      docErrors: [...docErrors.values()].sort((a, b) => b.at - a.at || (a.path < b.path ? -1 : 1)).slice(0, MAX_DOC_ERRORS), error,
    };
  }
  function emit() {
    if (disposed) return;
    // Drop local copies once the store has echoed them back.
    if (recorded.size) {
      const stored = new Set(sessionDocs.flatMap(d => d.attempts.map(attemptKey)));
      for (const k of [...recorded.keys()]) if (stored.has(k)) recorded.delete(k);
    }
    view = build();
    for (const l of [...listeners]) l();
  }
  const onError = (what: string, key?: keyof typeof arrived) => (e: unknown) => {
    if (key) arrived[key] = true;
    const code = toStoreError(e).code;
    if (code === 'revoked' || code === 'not_granted') error = PLAIN_ERRORS.revoked!;
    else if (!error) error = `Could not load ${what}. Showing what this device has.`;
    emit();
  };

  let started = false;
  function start() {
  if (started || disposed) return;
  started = true;
  unsubs.push(store.subscribe(paths.settings(), (doc, meta) => {
    const parsed = settingsDoc.safeParse(doc?.data);
    storedSettings = parsed.success ? parsed.data : null;
    if (!meta?.fromCache) confirmed.settings = true;
    settings = settingsFrom(doc?.data); arrived.settings = true; emit();
  }, onError('your settings', 'settings')));
  // Newest 1000 sessions (review P2-1): the query is ordered by start time, newest first.
  unsubs.push(store.subscribeQuery({ collection: 'sessions', orderBy: { field: 'startedAt', dir: 'desc' }, limit: 1000 }, (docs, meta) => {
    sessionDocs = docs.map(d => readDoc<SessionDoc>(d.path, d.data)).filter((d): d is SessionDoc => !!d);
    if (!meta?.fromCache) confirmed.sessions = true;
    arrived.sessions = true; emit();
  }, onError('your history', 'sessions')));
  // Rolled-up history (plan sections 2 and 3, M3): read so that a roll-up never removes attempts from the schedule.
  unsubs.push(store.subscribeQuery({ collection: 'summaries', limit: 200 }, docs => {
    summaryAttempts = docs.flatMap(d => readDoc<SummaryDoc>(d.path, d.data)?.attempts ?? []);
    emit();
  }, onError('older history')));
  unsubs.push(store.subscribe(paths.packMeta(), doc => {
    const meta = doc ? readDoc<PackMetaDoc>(paths.packMeta(), doc.data) : null;
    noteDocError(paths.packMeta(), doc && !meta ? docIssue(paths.packMeta(), doc.data) : '');
    if (!meta) { packToken++; pack = null; clearDocErrors('pack/', new Set([paths.packMeta()])); arrived.pack = true; emit(); return; }
    if (pack && pack.version === meta.packVersion && JSON.stringify(pack.meta.chunks) === JSON.stringify(meta.chunks)) { pack = { ...pack, meta }; emit(); return; }
    const token = ++packToken;
    if (packRetry) { clearTimeout(packRetry); packRetry = null; }
    const ids = packChunkIds(meta);
    // A failed chunk read is retried after 5, 15 and 45 s while the meta is unchanged (review P2-4).
    const load = (attempt: number) => {
      void Promise.all(ids.map(id => store.get(paths.packChunkById(id)).then(d => (d ? { id, data: d.data } : null), () => null))).then(chunks => {
        if (disposed || token !== packToken) return; // meta changed meanwhile: that load wins
        clearDocErrors('pack/', new Set([paths.packMeta(), ...ids.map(id => paths.packChunkById(id))]));
        for (const c of chunks) if (c) noteDocError(paths.packChunkById(c.id), docIssue(paths.packChunkById(c.id), c.data));
        const next = assemblePack(meta, chunks);
        if (next) { pack = next; if (error === PACK_ERROR) error = ''; }
        else {
          if (!error) error = PACK_ERROR;
          if (attempt < 3) packRetry = setTimeout(() => { packRetry = null; if (started) load(attempt + 1); }, packRetryMs * 3 ** attempt);
        }
        arrived.pack = true; emit();
      });
    };
    load(0);
  }, onError('your personal pack', 'pack')));
  unsubs.push(store.subscribe(paths.plan(), doc => {
    plan = doc ? readDoc<PlanDoc>(paths.plan(), doc.data) : null;
    noteDocError(paths.plan(), doc && !plan ? docIssue(paths.plan(), doc.data) : '');
    arrived.plan = true; emit();
  }, onError('your plan', 'plan')));
  unsubs.push(store.subscribeQuery({ collection: 'notes', limit: 200 }, docs => {
    noteDocs = [...docs];
    clearDocErrors('notes/', new Set(docs.map(d => d.path)));
    for (const d of docs) noteDocError(d.path, docIssue(d.path, d.data));
    emit();
  }, onError('notes')));
  unsubs.push(store.subscribeQuery({ collection: 'feedback', where: [['status', '==', 'open']], limit: 1000 }, docs => {
    openFeedback = docs.map(d => ({ id: d.id, doc: readDoc<FeedbackDoc>(d.path, d.data) })).filter((f): f is { id: string; doc: FeedbackDoc } => !!f.doc);
    // A local flag is kept until its document is visible; it lasts at most this page load.
    for (const id of [...localFlags]) if (openFeedback.some(f => f.doc.itemId === id && f.doc.kind === 'wrong')) localFlags.delete(id);
    arrived.feedback = true; emit();
  }, onError('feedback', 'feedback')));
  unsubs.push(store.subscribeQuery({ collection: 'drills', where: [['active', '==', true]], limit: 50 }, docs => {
    drills = [];
    clearDocErrors('drills/', new Set(docs.map(d => d.path)));
    for (const d of docs) {
      const doc = readDoc<DrillsDoc>(d.path, d.data);
      if (!doc) {
        noteDocError(d.path, docIssue(d.path, d.data) || 'unreadable');
        // The whole document fails the contract: tell the writing session through `rejected` (review P2-9).
        const problem = drillsDoc.safeParse(d.data);
        const reason = problem.success ? 'unreadable' : problem.error.issues.slice(0, 3).map(i => `${i.path.join('.') || 'document'}: ${i.message}`).join('; ').slice(0, 300);
        const rejected = [{ id: '*', reason: `Whole set ignored: ${reason}` }];
        const raw = (d.data as { rejected?: unknown }).rejected;
        if (JSON.stringify(raw ?? []) !== JSON.stringify(rejected)) void store.update(paths.drills(d.id), { rejected }).catch(() => undefined);
        continue;
      }
      const checked = checkDrillSet(d.id, doc);
      drills.push(checked);
      const stored = JSON.stringify(doc.rejected ?? []);
      if (checked.rejected.length && stored !== JSON.stringify(checked.rejected)) {
        void store.update(paths.drills(d.id), { rejected: checked.rejected }).catch(() => undefined);
      }
    }
    emit();
  }, onError('practice sets')));
  unsubs.push(store.subscribeQuery({ collection: 'personal', limit: 1000 }, docs => {
    const seen = new Map<string, PuzzleDoc>();
    for (const d of docs) for (const p of readDoc<PersonalDoc>(d.path, d.data)?.puzzles ?? []) if (!seen.has(p.id)) seen.set(p.id, p);
    personal = [...seen.values()]; emit();
  }, onError('your game positions')));
  // M2 (D1, D2): "Safe or not?" cards. Never part of `ready`; absent, refused or unreadable means no feature, no banner.
  unsubs.push(store.subscribe(paths.safeMeta(), doc => {
    const meta = doc ? readDoc<SafeMetaDoc>(paths.safeMeta(), doc.data) : null;
    noteDocError(paths.safeMeta(), doc && !meta ? docIssue(paths.safeMeta(), doc.data) : '');
    const token = ++safeToken;
    if (safeRetry) { clearTimeout(safeRetry); safeRetry = null; }
    if (!meta) { safe = null; clearDocErrors('safe/', new Set([paths.safeMeta()])); emit(); return; }
    const load = (attempt: number) => {
      void Promise.all(meta.chunks.map(id => store.get(paths.safeChunkById(id)).then(d => (d ? { id, data: d.data } : null), () => null))).then(chunks => {
        if (disposed || token !== safeToken) return;
        clearDocErrors('safe/', new Set([paths.safeMeta(), ...meta.chunks.map(id => paths.safeChunkById(id))]));
        for (const c of chunks) if (c) noteDocError(paths.safeChunkById(c.id), docIssue(paths.safeChunkById(c.id), c.data));
        safe = assembleSafe(meta, chunks);
        // A chunk that did not arrive is tried once more; its cards are simply absent meanwhile.
        if (attempt < 1 && chunks.some(c => !c)) safeRetry = setTimeout(() => { safeRetry = null; if (started) load(attempt + 1); }, packRetryMs);
        emit();
      });
    };
    load(0);
  }, () => { safe = null; emit(); }));
  // M2 (D8, D9): agent read-outs. Never part of `ready`; absent or unreadable means the section is not shown.
  unsubs.push(store.subscribe(paths.openingAccidents(), doc => {
    openings = doc ? readDoc<OpeningsDoc>(paths.openingAccidents(), doc.data) : null;
    noteDocError(paths.openingAccidents(), doc && !openings ? docIssue(paths.openingAccidents(), doc.data) : '');
    emit();
  }, () => { openings = null; emit(); }));
  unsubs.push(store.subscribe(paths.transferHistory(), doc => {
    transfer = doc ? readDoc<TransferDoc>(paths.transferHistory(), doc.data) : null;
    noteDocError(paths.transferHistory(), doc && !transfer ? docIssue(paths.transferHistory(), doc.data) : '');
    emit();
  }, () => { transfer = null; emit(); }));
  unsubs.push(store.onConnection(() => emit()));
  unsubs.push(sessions.onSaveState((_state, e) => { if (e && toStoreError(e).code === 'quota_exceeded') error = PLAIN_ERRORS.quota_exceeded!; emit(); }));
  const timer = setTimeout(() => { timedOut = true; emit(); }, options.readyTimeoutMs ?? 10_000);
  unsubs.push(() => clearTimeout(timer));
  unsubs.push(() => { if (packRetry) clearTimeout(packRetry); packRetry = null; });
  unsubs.push(() => { if (safeRetry) clearTimeout(safeRetry); safeRetry = null; });
  }
  function stop() { started = false; for (const u of unsubs.splice(0)) u(); }
  if (!options.lazy) start();

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      if (!started) start();
      return () => { listeners.delete(listener); if (options.lazy && !listeners.size) stop(); };
    },
    record(attempt) {
      const parsed = sessionAttemptSchema.safeParse(attempt);
      if (!parsed.success) { error = 'This answer could not be saved. Your earlier progress is unchanged.'; emit(); return false; }
      recorded.set(attemptKey(parsed.data), parsed.data);
      sessions.record(parsed.data);
      emit();
      return true;
    },
    async saveSettings(patch) {
      const path = paths.settings();
      // Before the stored settings have been seen, a save would drop fields such as `lastIngest` (review P2-3).
      if (!storedSettings && !confirmed.settings) { error = 'Settings can be changed once your saved settings have loaded.'; emit(); return false; }
      try {
        const base = storedSettings ?? { rating: DEFAULT_SETTINGS.rating, sessionLength: DEFAULT_SETTINGS.sessionLength };
        const body = prepareWrite(path, { ...base, ...patch, updatedAt: now(), device: deviceId });
        settings = settingsFrom(body); emit();
        await store.set(path, body);
        return true;
      } catch (e) { error = plain(e); emit(); return false; }
    },
    async markNoteRead(id) {
      readLocally.add(id); emit();
      try { await store.update(paths.note(id), { readAt: now() }); } catch { /* shown as read on this device; retried next time */ }
    },
    async sendFeedback(input) {
      let at = now();
      if (at <= lastFeedbackMs) at = lastFeedbackMs + 1;
      lastFeedbackMs = at;
      const path = paths.feedback(at, deviceId);
      let body: Record<string, unknown>;
      try {
        body = prepareWrite(path, {
          at, kind: input.kind, itemId: input.item.id, source: input.item.source, themes: input.item.themes.slice(0, 30), fen: input.item.fen,
          ...(input.playedUci ? { playedUci: input.playedUci } : {}), ...(input.text?.trim() ? { text: input.text.trim().slice(0, 500) } : {}),
          sessionId: sessions.sessionId, status: 'open', device: deviceId,
        });
      } catch { error = 'That feedback could not be saved.'; emit(); return false; }
      if (input.kind === 'wrong') { localFlags.add(input.item.id); emit(); }
      try { await store.set(path, body); return true; }
      catch (e) { error = plain(e); emit(); return false; }
    },
    dismissError() { error = ''; emit(); },
    dispose() { disposed = true; stop(); listeners.clear(); },
  };
}
