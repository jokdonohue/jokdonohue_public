/**
 * Next Move trainer, artifact version. Ported from the Site app's `components/Trainer.tsx`
 * (source hash in the B2 build log): practice, hints, reveal and rehearsal are unchanged; storage is the
 * artifact database through `useArtifactState`; there is no Chess.com fetch, no server sync route and no
 * in-page game analysis (PGN import and analysis are M2).
 *
 * Opening the page lands on today's first position (item c): a daily set capped at 20 reviews and
 * 10 new positions, weighted by Claude's plan. Every position has feedback buttons (item d), the board
 * faces the side to move, and a clean answer moves on after 1.2 s (item f).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { ArrowRight, BookOpen, ChartNoAxesCombined, Check, Flag, GraduationCap, Lightbulb, RefreshCw, RotateCcw, Target, X } from 'lucide-react';
import Chessboard from './Chessboard';
import Learn from './Learn';
import PersonalPackSummary from './PersonalPackSummary';
import CoachPanel from './CoachPanel';
import FeedbackBar from './FeedbackBar';
import BackupPanel from './BackupPanel';
import PunishStudy, { usablePunishStudy } from './PunishStudy';
import { ConnectionBanner, DailyDone, DocErrorLine, PlanAndNotes, saveLabel, TodayStrip } from './HomePanels';
import { useArtifactState } from './useArtifactState';
import { activePlan, capState, dailyCounts, focusPriors, pickNext } from './daily';
import { buildPools, fallbackPool, isPunish, type TrainerItem } from './pools';
import { buildProgress, type Progress } from './progress';
import { packForSummary } from './packAdapter';
import { explainInput, sanLine as sanFrom, type WrongMove } from './coachInput';
import { backupFilename, buildBackup } from './backup';
import { computeSnapshot } from './snapshot';
import { SafeAnswerPanel, SafeQuestionPanel, SafeScoreLine } from './SafeCard';
import StudyList from './StudyList';
import PgnImport from './pgn/PgnImport';
import { OpeningAccidents, TransferCard } from './GameReadouts';
import { colorName, type OpeningRow } from './insights';
import { leechIds, leechState, putBackAttempt, putBackTimes, withPutBacks } from './leech';
import { chooseSafe, isSafeAttempt, pickWithSafe, safeAttempt, safePool, safeQuestion, safeSchedule, safeScore, type SafeChoice, type SafeQuestion } from './safe';
import { paths, type SafeCardDoc } from '@/src/contract/docs';
import { puzzles } from '@/lib/puzzles';
import { endgameDrills, isEndgameDrill } from '@/lib/endgames';
import { selectPuzzle, getSkillStats, trainingThemes, type Progress as SchedulerProgress } from '@/lib/scheduler.js';
import { withThemePriors, packDetailOf, sanMoves, fenAfter } from '@/lib/personal-pack';
import { setupMove } from '@/lib/puzzle-setup';
import { drillGoal, recentExclusion } from '@/lib/practice';
import type { TrainerProps } from '@/src/contract/store';
import { parseState, type PersonalPuzzle } from '@/lib/training-state';
import { applySiteImport, idMapFromPackChunks, planSiteImport } from '@/src/importers/siteBackup';

const move = (board: Chess, uci: string) => board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
const THEMES: Array<[string, string]> = [
  ['all', 'Mixed practice'], ['review', 'Due for review'], ['personal', 'From my games'], ['hangingPiece', 'Loose pieces'], ['fork', 'Forks'],
  ['pin', 'Pins'], ['discoveredAttack', 'Discovered attacks'], ['mateIn1', 'Mate in one'], ['mateIn2', 'Mate in two'],
  ['defensiveMove', 'Defensive resources'], ['equality', 'Get back into the game'], ['endgame', 'Endgames'], ['endgame-tech', 'Endgame technique'],
  ['planb', 'Hold the draw (Plan B)'], ['pawnEndgame', 'Pawn endings'], ['rookEndgame', 'Rook endings'], ['promotion', 'Promotion'],
];
// One name per theme in the focus menu, the tags and Progress (QA P2-5).
const LABELS: Record<string, string> = Object.fromEntries(THEMES.filter(([id]) => !['all', 'review', 'personal', 'equality'].includes(id)));
const pretty = (s: string) => LABELS[s] ?? s.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
// Shown only when the pack contains these sets.
const PACK_SETS = [['pack-stalemate', 'stalemate', 'Avoid stalemate (your games)'], ['pack-conversion', 'conversion', 'Convert the win (your games)']] as const;
const PUNISH = 'pack-punish';
/** M2 (item b): the "Safe or not?" focus; its cards never enter the ordinary pools. */
const SAFE = 'pack-safe';
/** M2 (D8): extra practice over one opening's positions; outside the daily caps. */
const EXTRA = 'extra-opening';
const POOL_FILTERS = ['all', 'personal', 'review', PUNISH, SAFE, EXTRA, ...PACK_SETS.map(([id]) => id)];
/** Item f: pause after a clean answer before the next position (judgement call). */
export const AUTO_ADVANCE_MS = 1200;
/** `derived/snapshot` is recomputed this long after the last attempt recorded on this page. */
const SNAPSHOT_DELAY_MS = 5000;
function clock(seconds: number) { const s = Math.max(0, Math.round(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
const solutionSan = (p: TrainerItem) => sanFrom(p.fen, p.moves).join('  ');
const toSchedulerProgress = (p: Progress) => p as unknown as SchedulerProgress;

export default function Trainer({ store, deviceId, sessions, coach, saveFile }: TrainerProps) {
  const { view, model } = useArtifactState(store, sessions, deviceId);
  const [tab, setTab] = useState('practice'), [theme, setTheme] = useState('all');
  /** `today`: the capped daily set; `free`: practice beyond it or with a chosen focus. */
  const [mode, setMode] = useState<'today' | 'free'>('today');
  const [dailyDone, setDailyDone] = useState(false);
  const [active, setActive] = useState<TrainerItem | null>(null), [fen, setFen] = useState(''), [index, setIndex] = useState(0), [lastMove, setLastMove] = useState('');
  const [feedback, setFeedback] = useState(''), [complete, setComplete] = useState(false), [hints, setHints] = useState(0), [errors, setErrors] = useState(0), [revealed, setRevealed] = useState(false);
  const [wrong, setWrong] = useState<WrongMove | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [recordCount, setRecordCount] = useState(0);
  const recorded = useRef(false), started = useRef(0), rehearsing = useRef(false), coached = useRef(false), firstWrong = useRef<string | undefined>(undefined);
  const recent = useRef<string[]>([]);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSources, setShowSources] = useState(false);
  /** M2 (D13): the PGN import is mounted only once he opens it (its engine starts only on an import). */
  const [pgnOpen, setPgnOpen] = useState(false);
  /** M2 "Safe or not?": the question shown (no answer key), then his choice with the card looked up at answer time. */
  const [safeQ, setSafeQ] = useState<{ q: SafeQuestion; startedAt: number } | null>(null);
  const [safeAns, setSafeAns] = useState<{ choice: SafeChoice; card: SafeCardDoc; saved: boolean } | null>(null);
  /** D8: the opening chosen for extra practice and its position ids. */
  const extra = useRef<{ label: string; ids: string[] } | null>(null);

  // "Safe or not?" answers train a habit, not recall: they stay out of the ordinary schedule and skills (D5).
  const practiceAttempts = useMemo(() => view.attempts.filter(a => !isSafeAttempt(a)), [view.attempts]);
  // D7: "Put it back" markers reset a card's lapse days and make it due tomorrow; leeches leave the queue.
  const putBacks = useMemo(() => putBackTimes(view.putBacks), [view.putBacks]);
  const progress = useMemo(() => {
    const built = buildProgress(practiceAttempts, view.settings, trainingThemes);
    return putBacks.size ? { ...built, cards: withPutBacks(built.cards, putBacks) } : built;
  }, [practiceAttempts, view.settings, putBacks]);
  const leechInfo = useMemo(() => leechState(practiceAttempts, putBacks), [practiceAttempts, putBacks]);
  const leeched = useMemo(() => leechIds(leechInfo), [leechInfo]);
  const safeQuestions = useMemo(() => (view.safe?.cards ?? []).map(safeQuestion).filter((q): q is SafeQuestion => !!q), [view.safe]);
  const safeKinds = useMemo(() => new Map((view.safe?.cards ?? []).map(c => [c.id, c.kind] as const)), [view.safe]);
  const safeSched = useMemo(() => safeSchedule(view.attempts), [view.attempts]);
  const safeNow = useMemo(() => (safeKinds.size ? safeScore(view.attempts, id => safeKinds.get(id)) : null), [view.attempts, safeKinds]);
  const pools = useMemo(() => buildPools({ bank: puzzles, endgames: endgameDrills, pack: view.pack, personal: view.personal, drills: view.drills }), [view.pack, view.personal, view.drills]);
  const summaryPack = useMemo(() => packForSummary(view.pack), [view.pack]);
  const punishStudy = useMemo(() => usablePunishStudy(view.pack?.punishStudy ?? []), [view.pack]);
  const nowMs = Date.now();
  const plan = activePlan(view.plan, nowMs);
  const caps = { reviewCap: view.settings.dailyReviewCap, newCap: view.settings.dailyNewCap };
  const counts = dailyCounts(view.attempts, nowMs);
  const capsNow = capState(counts, caps);
  const themeOptions = useMemo(() => [
    ...THEMES,
    ...(pools.own.some(isPunish) ? [[PUNISH, 'Punish it (your games)'] as [string, string]] : []),
    ...(safeQuestions.length ? [[SAFE, 'Safe or not? (your games)'] as [string, string]] : []),
    ...PACK_SETS.filter(([, set]) => pools.own.some(c => c.pack?.sets?.includes(set))).map(([id, , label]) => [id, label] as [string, string]),
  ], [pools, safeQuestions.length]);

  const latest = useRef({ view, progress, pools, mode, theme, active, errors, hints, complete, safeQuestions, safeSched, safeNow, leeched });
  latest.current = { view, progress, pools, mode, theme, active, errors, hints, complete, safeQuestions, safeSched, safeNow, leeched };

  const cancelAdvance = useCallback(() => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    advanceTimer.current = null; setAdvancing(false);
  }, []);
  useEffect(() => cancelAdvance, [cancelAdvance]);

  function finish(wasRevealed = false, wasClean = errors === 0) {
    if (!active || recorded.current) return;
    recorded.current = true; setComplete(true);
    // A rehearsal replays a line just seen; recording it would book a clean recall (audit A1 F1).
    if (rehearsing.current) return;
    const correct = !wasRevealed && wasClean;
    model.record({
      puzzleId: active.id, themes: [...new Set(active.themes)].slice(0, 30), correct, unassisted: correct && hints === 0 && !wasRevealed,
      hints, revealed: wasRevealed, durationMs: Math.max(0, Date.now() - started.current), at: Date.now(), source: active.source,
      ...(firstWrong.current ? { playedUci: firstWrong.current } : {}), ...(coached.current ? { coached: true } : {}),
    });
    setRecordCount(n => n + 1);
  }

  function startPuzzle(p: TrainerItem, rehearse = false) {
    cancelAdvance();
    if (active && !recorded.current && (errors > 0 || hints > 0)) finish(false, false);
    if (!rehearse) recent.current = [...recent.current.filter(id => id !== p.id), p.id].slice(-5);
    rehearsing.current = rehearse;
    setSafeQ(null); setSafeAns(null);
    setActive(p); setFen(p.fen); setIndex(0);
    setLastMove(setupMove(p.id) ?? (isPunish(p) && typeof p.pack?.playedUci === 'string' ? p.pack.playedUci : ''));
    setFeedback(''); setComplete(false); setHints(0); setErrors(0); setRevealed(false); setWrong(null); setDailyDone(false);
    recorded.current = false; coached.current = false; firstWrong.current = undefined; started.current = Date.now();
  }

  function startSafe(q: SafeQuestion) {
    cancelAdvance();
    if (active && !recorded.current && (errors > 0 || hints > 0)) finish(false, false);
    recent.current = [...recent.current.filter(id => id !== q.id), q.id].slice(-5);
    setActive(null); setFeedback(''); setDailyDone(false); setSafeAns(null);
    setSafeQ({ q, startedAt: Date.now() });
  }
  /** Record his verdict (D4). The answer key is looked up only now, from the loaded cards. */
  function answerSafe(choice: SafeChoice) {
    if (!safeQ || safeAns) return;
    const card = latest.current.view.safe?.cards.find(c => c.id === safeQ.q.id);
    if (!card) { setFeedback('This position is no longer available.'); setSafeQ(null); return; }
    // Fix pass P2-4: check the result, as `putBack` does; the panel says so when the answer was not saved.
    const saved = model.record(safeAttempt(safeQ.q, card.kind, choice, safeQ.startedAt, Date.now()));
    setSafeAns({ choice, card, saved });
    if (saved) setRecordCount(n => n + 1);
  }

  function choose(nextTheme = theme, nextMode = mode) {
    cancelAdvance();
    const { view: v, progress: prog, pools: pl, safeQuestions: sq, safeSched: sched, leeched: leechedNow } = latest.current;
    // Leaving a position after help or an incorrect move is still practice evidence.
    if (active && !recorded.current && (errors > 0 || hints > 0)) finish(false, false);
    const now = Date.now();
    const planNow = activePlan(v.plan, now);
    const priors = focusPriors(v.pack?.meta.priors, planNow);
    // Open "wrong" flags and leeches (D7) are both kept out of selection.
    const flagged = leechedNow.size ? new Set([...v.flaggedWrong, ...leechedNow]) : v.flaggedWrong;
    const filter = POOL_FILTERS.includes(nextTheme) ? 'all' : nextTheme;
    if (nextTheme === SAFE) {
      const q = chooseSafe(safePool(sq, sched, null, now, flagged), sched, recent.current);
      if (q) { startSafe(q); return; }
      setActive(null); setSafeQ(null); setSafeAns(null);
      setFeedback('No “Safe or not?” positions are waiting. Answered ones return later.');
      return;
    }
    if (nextTheme === 'all') {
      const capsHere = nextMode === 'today' ? capState(dailyCounts(v.attempts, now), { reviewCap: v.settings.dailyReviewCap, newCap: v.settings.dailyNewCap }) : null;
      // D3: a fifth pool with its own share; the other sources keep their proportions within the rest.
      const safeHere = capsHere?.done ? [] : safePool(sq, sched, capsHere, now, flagged);
      const both = pickWithSafe({
        safePool: safeHere, schedule: sched, recent: recent.current, mixSafe: planNow?.mix.safe, r: Math.random(),
        pickRest: () => pickNext<TrainerItem>({
          pools: pl.bySource, progress: prog, plan: v.plan, priors: v.pack?.meta.priors, flagged, caps: capsHere, excludeIds: recent.current, now,
          rand: Math.random, select: (pool, p, o) => selectPuzzle(pool, p as unknown as SchedulerProgress, o),
          withPriors: (p, pr) => withThemePriors(p, pr), fallback: (byS, p) => fallbackPool(byS, p.attempts.length),
        }),
      });
      if ('safe' in both) { startSafe(both.safe); return; }
      const pick = both.rest;
      if (pick.item) { startPuzzle(pick.item); return; }
      setActive(null); setSafeQ(null); setSafeAns(null);
      if (pick.reason === 'daily-done') { setDailyDone(true); return; }
      setFeedback('Nothing is available to practise right now.');
      return;
    }
    let pool = pl.all;
    if (nextTheme === EXTRA) pool = (extra.current?.ids ?? []).map(id => pl.byId.get(id)).filter((p): p is TrainerItem => !!p);
    if (nextTheme === 'personal') pool = pl.own;
    if (nextTheme === 'review') pool = pl.all.filter(p => (prog.cards[p.id]?.due ?? Infinity) <= now);
    if (nextTheme === PUNISH) pool = pl.own.filter(isPunish);
    const packSet = PACK_SETS.find(([id]) => id === nextTheme);
    if (packSet) pool = pl.own.filter(p => !isPunish(p) && p.pack?.sets?.includes(packSet[1]));
    pool = pool.filter(p => !flagged.has(p.id));
    const selected = selectPuzzle(pool, toSchedulerProgress(withThemePriors(prog, priors)), { theme: filter, now, excludeIds: recentExclusion(pool, filter, recent.current, active?.id) });
    if (selected) startPuzzle(selected);
    else {
      setActive(null); setSafeQ(null); setSafeAns(null);
      setFeedback(nextTheme === 'review' ? 'No reviews are due. Try mixed practice, or return after your next review is scheduled.'
        : nextTheme === 'personal' ? 'Positions from your games appear here once Claude adds them from your recent games.'
        : nextTheme === EXTRA ? 'No positions from this opening are available right now.'
        : 'No positions match this focus yet.');
    }
  }

  // Land on today's first position once the data is in, without resetting an attempt in progress.
  const landed = useRef(false);
  useEffect(() => {
    if (!view.ready || landed.current) return;
    landed.current = true;
    choose('all', 'today');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.ready]);

  // Recompute the agent read model after practice pauses (only after attempts made on this page).
  useEffect(() => {
    // Only from confirmed history on a live connection, so a slow start never overwrites the read model (review P2-3).
    if (!recordCount || !view.synced || view.connection !== 'live') return;
    const timer = setTimeout(() => {
      const { view: v, progress: prog, pools: pl, leeched: lc } = latest.current;
      try {
        const local = sessions.localSessions().find(x => x.id === sessions.sessionId);
        const body = computeSnapshot({
          attempts: v.attempts, progress: prog, themesOf: trainingThemes, priors: v.pack?.meta.priors, servableIds: pl.all.filter(p => !lc.has(p.id)).map(p => p.id),
          packIds: pl.own.filter(p => p.source === 'pack').map(p => p.id),
          session: local ? { id: local.id, attempts: local.doc.attempts, endedAt: local.doc.endedAt } : null, deviceId, now: Date.now(),
          safe: latest.current.safeNow, docErrors: v.docErrors, leeches: [...lc],
        });
        void store.set(paths.snapshot(), body).catch(() => undefined);
      } catch { /* a snapshot that fails validation is skipped; the attempts themselves are saved */ }
    }, SNAPSHOT_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordCount, view.synced, view.connection]);

  function scheduleAdvance() {
    cancelAdvance();
    setAdvancing(true);
    advanceTimer.current = setTimeout(() => { advanceTimer.current = null; setAdvancing(false); choose(); }, AUTO_ADVANCE_MS);
  }

  function play(uci: string) {
    if (!active || complete) return;
    cancelAdvance();
    const board = new Chess(fen);
    try { move(board, uci); } catch { setFeedback('That move is not legal in this position.'); return; }
    const alternateMate = board.isCheckmate();
    if (uci !== active.moves[index] && !alternateMate) {
      setErrors(n => n + 1);
      if (!firstWrong.current && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) firstWrong.current = uci;
      setWrong({ fen, uci, index });
      setFeedback(isPunish(active) ? 'That lets your opponent off the hook. Look for the move that takes advantage of what was just played.'
        : active.themes.includes('personal') ? 'That differs from the saved engine candidate. Try the recorded line, or reveal it to compare.'
        : isEndgameDrill(active) ? (board.isStalemate() ? 'That move gives stalemate, so the game would be drawn. Try again or reveal the line.' : 'Not the move this drill is practising. Try again or reveal the line.')
        : 'That is not the solution line. Check the opponent’s strongest reply, then try again.');
      return;
    }
    let next = index + 1, reply = ''; setLastMove(uci);
    if (!alternateMate && next < active.moves.length) { reply = move(board, active.moves[next]).san; setLastMove(active.moves[next]); next++; }
    setFen(board.fen()); setIndex(next);
    if (alternateMate || next >= active.moves.length) {
      const clean = errors === 0 && hints === 0;
      setFeedback(rehearsing.current ? 'Rehearsal complete. Rehearsals are not recorded as new attempts.'
        : alternateMate && uci !== active.moves[index] ? 'Checkmate — another valid finish. The source line below shows a different mating move.'
        : !clean ? 'Line completed. This position will return for another look.'
        : 'Well found. You followed the line all the way through.');
      const wasRehearsal = rehearsing.current;
      finish();
      if (clean && !wasRehearsal && tab === 'practice') scheduleAdvance();
    } else setFeedback(`Good. Your opponent replies ${reply}. Find your next move.`);
  }

  function reveal() {
    cancelAdvance();
    // Step the board through the rest of the line so the final position is visible (QA P2-10).
    if (active) {
      const board = new Chess(fen); let last = lastMove;
      for (const uci of active.moves.slice(index)) { try { move(board, uci); last = uci; } catch { break; } }
      setFen(board.fen()); setIndex(active.moves.length); setLastMove(last);
    }
    setRevealed(true);
    setFeedback(rehearsing.current ? 'Line shown. Rehearsals are not recorded.' : active?.themes.includes('personal') ? 'Engine candidate shown. This counts as supported practice and returns soon.' : 'Solution revealed. This counts as supported practice and returns soon.');
    finish(true);
  }

  function goTab(next: string) { cancelAdvance(); setTab(next); }
  function practiseTheme(t: string) { goTab('practice'); setMode('free'); setTheme(t); choose(t, 'free'); }
  function practiseOpening(row: OpeningRow, ids: string[]) {
    extra.current = { label: `${row.opening} as ${colorName(row.color)}`, ids };
    practiseTheme(EXTRA);
  }
  function sendFeedback(kind: Parameters<typeof model.sendFeedback>[0]['kind'], text?: string) {
    cancelAdvance();
    if (safeQ) return model.sendFeedback({ kind, item: { id: safeQ.q.id, source: 'pack', themes: safeQ.q.themes, fen: safeQ.q.fen }, text });
    if (!active) return Promise.resolve(false);
    return model.sendFeedback({ kind, item: { id: active.id, source: active.source, themes: active.themes, fen: active.fen }, playedUci: firstWrong.current, text });
  }
  function makeBackup() {
    const now = Date.now();
    const data = buildBackup({ attempts: view.attempts, progress, settings: view.settings, personal: view.personal, plan: view.plan, notes: view.notes, openFeedback: view.openFeedback, packVersion: view.pack?.version ?? null, exportedAt: now });
    return { filename: backupFilename(now), text: JSON.stringify(data) };
  }
  async function importBackup(text: string) {
    const chunks = view.pack ? [{ cards: view.pack.cards as Array<{ id: string; siteId?: unknown }>, study: view.pack.study as Array<{ id: string; siteId?: unknown }> }] : [];
    // Attempts already in this database are skipped, so re-importing an export adds no second copy (review P2-5).
    const plan = await planSiteImport(text, { parse: parseState, idMap: idMapFromPackChunks(chunks), skipKeys: new Set(view.attempts.map(a => `${a.puzzleId}:${a.at}`)) });
    await applySiteImport(store, plan, { deviceId });
    const c = plan.counts;
    const already = c.alreadyStored + c.duplicateAttempts;
    return `Imported ${c.attempts} attempt${c.attempts === 1 ? '' : 's'} and ${c.personalPuzzles} position${c.personalPuzzles === 1 ? '' : 's'} from your games${already ? `; ${already} attempt${already === 1 ? ' was' : 's were'} already here` : ''}.`;
  }

  // Use the pack detail only when the fields rendered below are present (a partial block must not break the page).
  const rawDetail = packDetailOf(active as PersonalPuzzle | null);
  const detail = rawDetail && Array.isArray(rawDetail.pvUci) && Array.isArray(rawDetail.occurrences) && typeof rawDetail.date === 'string' && typeof rawDetail.timeClass === 'string' ? rawDetail : undefined;
  const coachInput = active && wrong ? explainInput(active, wrong, active.source) : null;
  const skills = getSkillStats(toSchedulerProgress(progress), pools.all) as { theme: string; attempts: number; successes: number; accuracy: number | null; label: string; total: number }[];
  const practiced = skills.filter(s => s.attempts > 0).sort((a, b) => (a.accuracy ?? 1) - (b.accuracy ?? 1));
  const attempts = practiceAttempts, clean = attempts.filter(a => a.unassisted).length;
  // Count due cards whose position is still available (a removed pack must not leave reviews that cannot be served).
  const due = pools.all.reduce((n, p) => n + Number(!leeched.has(p.id) && (progress.cards[p.id]?.due ?? Infinity) <= nowMs), 0);
  const studyEntries = pools.all.filter(p => leeched.has(p.id)).map(item => ({ item, lapseDays: leechInfo.get(item.id)?.lapseDays ?? 0, windowDays: leechInfo.get(item.id)?.windowDays ?? 0 }));
  function putBack(item: TrainerItem) { if (model.record(putBackAttempt(item.id, item.source, Date.now()))) setRecordCount(n => n + 1); }
  const unread = view.notes.filter(n => !n.read).length;
  const status = saveLabel(view.connection, view.saveState, sessions.persistent, view.unconfirmed);
  const turn = active ? new Chess(active.fen).turn() : 'w';
  const punish = isPunish(active);

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); goTab('practice'); }}><span className="brand-piece">♞</span><span>Next Move<small>Your practice room</small></span></a>
      <nav aria-label="Main navigation">{[{ id: 'practice', label: 'Practice', Icon: Target }, { id: 'games', label: 'My games', Icon: Flag }, { id: 'learn', label: 'Learn', Icon: BookOpen }, { id: 'progress', label: 'Progress', Icon: ChartNoAxesCombined }].map(({ id, label, Icon }) =>
        <button key={id} className={tab === id ? 'nav active' : 'nav'} onClick={() => goTab(id)} aria-current={tab === id ? 'page' : undefined}><Icon size={20}/><span>{label}</span>{id === 'practice' && due > 0 && <b>{due}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="profile-dot">♔</div><p>A little, often.<small>Patterns grow with practice.</small></p></div>
    </aside>
    <main>
      <header className="topbar"><span>{tab === 'practice' ? 'Make the next move count.' : tab === 'games' ? 'Your games are your curriculum.' : tab === 'learn' ? 'Understand the idea. Then rehearse it.' : 'See what your practice is showing.'}</span><span className="save-status"><i/>{view.ready ? status : 'Loading…'}</span></header>
      <ConnectionBanner connection={view.connection} saveState={view.saveState} persistent={sessions.persistent}/>
      {view.error && <div className="notice error" role="alert"><span>{view.error}</span><button onClick={() => model.dismissError()} aria-label="Dismiss message"><X size={18}/></button></div>}
      {!view.ready ? <div className="empty-state">Loading your practice room…</div> : <>
        {tab === 'practice' && <section className="page practice-page">
          <TodayStrip counts={counts} caps={capsNow} cap={caps} plan={plan} unread={unread} pretty={pretty} status={status}
            onNotes={() => document.getElementById('from-claude')?.scrollIntoView({ block: 'start' })}/>
          <DocErrorLine count={view.docErrors.length}/>
          <div className="page-heading"><div><h1>{mode === 'today' && theme === 'all' ? 'Today’s set' : theme === EXTRA && extra.current ? `Extra practice: ${extra.current.label}` : 'Your next position'}</h1><p>Take your time. Find the idea, then calculate the reply.</p></div></div>
          {safeQ && !dailyDone ? (safeAns
            ? <SafeAnswerPanel key={`a-${safeQ.q.id}`} question={safeQ.q} card={safeAns.card} choice={safeAns.choice} saved={safeAns.saved} score={safeNow} onNext={() => choose()} nextLabel={mode === 'today' && theme === 'all' ? 'Next position' : 'Keep practising'}>
                <FeedbackBar itemId={safeQ.q.id} onSend={sendFeedback} onInteract={cancelAdvance}/></SafeAnswerPanel>
            : <SafeQuestionPanel key={`q-${safeQ.q.id}`} question={safeQ.q} onAnswer={answerSafe}>
                <FeedbackBar itemId={safeQ.q.id} onSend={sendFeedback} onInteract={cancelAdvance}/></SafeQuestionPanel>)
          : active && !dailyDone ? <div className="practice-layout">
            <div className="board-column">
              <div className="board-top"><span className={`turn-dot ${turn}`}/><strong>{punish ? `You play ${turn === 'w' ? 'White' : 'Black'}: punish it` : `${turn === 'w' ? 'White' : 'Black'} to move`}</strong>
                <span>{punish ? 'Your opponent’s side' : active.themes.includes('personal') || active.source === 'pack' ? 'From your game' : active.source === 'agent' ? (active.title ?? 'Set from Claude') : isEndgameDrill(active) ? `${drillGoal(active)} · Estimated difficulty ${active.rating}` : `Puzzle difficulty ${active.rating}`}</span></div>
              <Chessboard key={active.id} fen={fen} orientation={turn} onMove={play} onIllegal={() => { if (!complete) setFeedback('That move is not legal in this position.'); }} disabled={complete}
                lastMove={lastMove} hintSquare={hints >= 2 && !complete ? active.moves[index]?.slice(0, 2) : undefined}/>
              <div className="board-caption"><span>Tap a piece, then its destination.</span><span>{detail ? `From your ${detail.timeClass} game, ${detail.date}` : active.themes.includes('personal') ? (active.title ? `${active.title} · saved engine candidate` : 'Saved engine candidate') : isEndgameDrill(active) ? 'Tablebase-verified drill' : active.source === 'bank' ? `Lichess ${active.id}` : ''}</span></div>
              {advancing && <div className="advance-note" role="status"><span>Next position in a moment.</span><button type="button" className="text-button" onClick={cancelAdvance}>Stay here</button></div>}
            </div>
            <aside className="coach-panel">
              <div className="coach-heading"><GraduationCap size={24}/><h2>{complete ? 'Take the idea with you' : punish ? 'What does that allow?' : 'Find the continuation'}</h2></div>
              {/* Punish-it framing: "what does that allow?" (evidence C1, B6). */}
              <p className="lead">{complete ? 'One position, one pattern. What made this work?' : punish ? 'This is the position after your move in one of your games. Play your opponent’s side and find the move that takes advantage of it.' : isEndgameDrill(active) ? `${drillGoal(active)}. The replies are fixed; find the move that keeps that result.` : 'Before moving, ask what changed and what your opponent is threatening.'}</p>
              <div className="thinking-steps"><p><span>1</span>Look for checks, captures, and threats.</p><p><span>2</span>Test your candidate against their best reply.</p><p><span>3</span>Check what you leave unprotected.</p></div>
              <div className={`feedback ${complete ? 'success' : ''}`} aria-live="polite">{feedback || 'The answer stays hidden until you play or ask for help.'}</div>
              {hints > 0 && !complete && <div className="hint-box"><Lightbulb size={18}/><p>{hints === 1 ? (isEndgameDrill(active) ? 'Start with the kings: which squares must yours reach or guard? Check that your move does not leave the opponent without a legal move.' : 'Look at forcing moves and loose pieces. Which move changes what the opponent can safely do?') : `Look closely at the piece on ${active.moves[index]?.slice(0, 2)}.`}</p></div>}
              {coachInput && <CoachPanel coach={coach} input={coachInput} revealsAnswer={!complete} onAsk={() => { cancelAdvance(); coached.current = true; if (!complete) reveal(); }}/>}
              {complete ? <>
                <div className="theme-tags">{trainingThemes(active.themes).map(t => <span key={t}>{pretty(t)}</span>)}</div>
                <div className="solution"><strong>{active.themes.includes('personal') ? 'Engine candidate' : revealed ? 'Solution line' : 'Recorded continuation'}</strong><p>{solutionSan(active)}</p></div>
                {detail && <div className="pack-lines">
                  {/* A punish card's own line is its solution above; its pvUci belongs to the position before his move. */}
                  {punish && detail.playedSan && <p><strong>In your game: </strong>you played {detail.playedSan}{detail.bestSan ? `; the engine preferred ${detail.bestSan}` : ''}.</p>}
                  {!punish && detail.pvUci.length > 1 && <p><strong>Engine line: </strong>{sanMoves(active.fen, detail.pvUci).join('  ')}</p>}
                  {detail.refutationPvUci && !punish && <p><strong>Engine line after your {detail.playedSan}: </strong>{sanMoves(fenAfter(active.fen, detail.playedUci) ?? active.fen, detail.refutationPvUci).join('  ')}</p>}
                  <p className="small">{`${detail.timeClass === 'rapid' ? 'Rapid' : 'Blitz'} · ${detail.date} · move ${detail.moveNumber}${detail.moveSeconds != null ? ` · ${Math.round(detail.moveSeconds)} s on this move` : ''}${detail.clockBefore != null ? ` · ${clock(detail.clockBefore)} on your clock` : ''}${detail.occurrences.length > 1 ? ` · you reached this position in ${detail.occurrences.length} games` : ''}`}</p>
                  {active.gameUrl && <a href={active.gameUrl} target="_blank" rel="noreferrer">Open the game on Chess.com</a>}
                </div>}
                {active.explanation && <p className="small">{active.explanation}</p>}
                <button className="primary wide" onClick={() => choose()}>{mode === 'today' && theme === 'all' ? 'Next position' : 'Keep practising'}<ArrowRight size={18}/></button>
                <button className="text-button" onClick={() => startPuzzle(active, true)}><RotateCcw size={16}/>Rehearse this line again</button>
              </> : <div className="coach-actions">
                <button className="secondary" onClick={() => { cancelAdvance(); setHints(n => n + 1); }}><Lightbulb size={17}/>{hints ? 'Another hint' : 'Show a hint'}</button>
                <button className="text-button" onClick={reveal}>{active.themes.includes('personal') ? 'Show engine candidate' : 'Reveal solution'}</button>
              </div>}
              <FeedbackBar itemId={active.id} onSend={sendFeedback} onInteract={cancelAdvance}/>
              <div className="coach-footnote">{detail ? 'From an offline engine pass over your games, not a live analysis of this position.' : active.themes.includes('personal') ? 'A short engine scan supplies a candidate, not proof that every alternative is worse.' : isEndgameDrill(active) ? 'Difficulty is an estimate, not a measured rating. The replies are fixed, tablebase-checked moves; they do not adapt to your play.' : active.source === 'agent' ? 'A practice line set by Claude and checked for legal moves on this page.' : 'Puzzle difficulty is from Lichess. It is not your Chess.com playing rating.'}</div>
            </aside>
          </div> : dailyDone ? <DailyDone counts={counts} onMore={() => { setMode('free'); setTheme('all'); choose('all', 'free'); }}/>
            : <div className="empty-state"><Target size={35}/><h2>{theme === 'personal' ? 'No positions from your games yet' : 'Nothing due right now'}</h2><p>{feedback}</p><button className="primary" onClick={() => { setTheme('all'); choose('all'); }}>Mixed practice</button></div>}
          <div className="practice-toolbar"><label htmlFor="theme">Practice focus</label>
            <select id="theme" value={mode === 'today' && theme === 'all' ? 'today' : theme} onChange={e => { const t = e.target.value; if (t === 'today') { setMode('today'); setTheme('all'); choose('all', 'today'); } else { setMode('free'); setTheme(t); choose(t, 'free'); } }}>
              <option value="today">Today’s set</option>
              {themeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              {theme === EXTRA && extra.current && <option value={EXTRA}>{`Extra practice: ${extra.current.label}`}</option>}
            </select>
            <button className="text-button" onClick={() => choose()}><RefreshCw size={16}/>Another position</button></div>
          <PlanAndNotes id="from-claude" plan={plan} notes={view.notes} pretty={pretty} onRead={id => void model.markNoteRead(id)}/>
          <div className="practice-footer"><div><strong>{(puzzles.length + endgameDrills.length).toLocaleString()} positions</strong><span>Tactics, defence, and endgames</span></div><div><strong>{due} due for review</strong><span>Missed or supported answers return sooner</span></div><div><strong>{pools.own.length} personal positions</strong><span>From games you have completed</span></div></div>
          {studyEntries.length > 0 && <p className="small study-pointer">{`${studyEntries.length} position${studyEntries.length === 1 ? ' is' : 's are'} set aside to study. `}<button type="button" className="link-button" onClick={() => goTab('progress')}>Study these</button></p>}
          {capsNow.done && mode === 'free' && <div className="notice success"><Check size={20}/><span>Today’s set is done. Extra practice still counts.</span><button onClick={() => goTab('progress')}>View progress</button></div>}
        </section>}
        {tab === 'games' && <section className="page"><div className="page-heading"><div><h1>Learn from your games</h1><p>Positions where your games turned, ready to practise.</p></div></div>
          {summaryPack ? <PersonalPackSummary pack={summaryPack} onPractise={() => practiseTheme('personal')}/> : <div className="surface"><h2>Your game positions</h2>
            <p>{pools.own.length ? `${pools.own.length} positions from your games are in your practice.` : 'Positions from your games arrive when Claude analyses your recent games.'}</p>
            {pools.own.length > 0 && <button className="primary" onClick={() => practiseTheme('personal')}>Practise them</button>}</div>}
          <OpeningAccidents doc={view.openings} isAvailable={id => pools.byId.has(id) && !leeched.has(id)} onPractise={practiseOpening}/>
          <PunishStudy items={punishStudy}/>
          <div className="surface"><h2>New games</h2><p className="small">Claude adds your newest games from your Chess.com archive in a coaching session. You can also add games here from a PGN file or a paste.</p>
            {!pgnOpen && <button type="button" className="secondary" onClick={() => setPgnOpen(true)}>Import games from a PGN</button>}
            {view.settings.chesscomUser && <a href={`https://www.chess.com/games/archive/${encodeURIComponent(view.settings.chesscomUser)}`} target="_blank" rel="noreferrer">Open your game archive on Chess.com</a>}
            <ChesscomUserForm current={view.settings.chesscomUser ?? ''} onSave={name => model.saveSettings({ chesscomUser: name })}/></div>

        </section>}
        {/* Kept mounted (hidden on other tabs) once opened: leaving My games must not stop a running check (it would save nothing). */}
        {pgnOpen && <div className="page pgn-mount" hidden={tab !== 'games'}><PgnImport store={store} myNames={view.settings.myNames ?? []} chesscomUser={view.settings.chesscomUser}
          saveMyNames={names => model.saveSettings({ myNames: names })} knownCards={pools.own.map(p => ({ id: p.id, fen: p.fen }))}/></div>}
        {tab === 'learn' && <Learn onTheme={practiseTheme} showSources={showSources} onSourcesShown={() => setShowSources(false)}/>}
        {tab === 'progress' && <section className="page"><div className="page-heading"><div><h1>Your practice, in focus</h1><p>These numbers describe practice. They do not estimate your playing Elo.</p></div></div>
          <div className="stats-row"><div><strong>{attempts.length}</strong><span>Completed attempts</span></div><div><strong>{attempts.length ? `${Math.round(clean / attempts.length * 100)}%` : '—'}</strong><span>Solved without help or errors</span></div><div><strong>{due}</strong><span>Reviews due</span></div><div><strong>{pools.own.length}</strong><span>Positions from your games</span></div></div>
          {safeNow && safeNow.caught.n + safeNow.trusted.n > 0 && <div className="surface safe-progress"><h2>Safe or not?</h2><SafeScoreLine score={safeNow}/>
            <p className="fine-print">Two numbers on purpose: answering “It loses something” every time would catch every blunder and trust no sound move. Over your last 50 answers.</p></div>}
          <TransferCard doc={view.transfer}/>
          <StudyList entries={studyEntries} onPutBack={putBack}/>
          <div className="progress-layout"><div className="surface"><h2>Themes practised</h2>{!practiced.length ? <p>Complete a few positions to start seeing your practice history here. New themes remain in the mix.</p> : <div className="skill-list">{practiced.map(s => <div key={s.theme} className="skill-row"><div><strong>{pretty(s.theme)}</strong><small>{s.attempts} attempt{s.attempts === 1 ? '' : 's'} · {s.label}</small></div><div className="skill-meter" style={s.attempts < 5 ? { visibility: 'hidden' } : undefined}><div style={{ width: `${(s.accuracy ?? 0) * 100}%` }}/></div><span>{s.attempts < 5 ? '—' : `${Math.round((s.accuracy ?? 0) * 100)}%`}</span></div>)}</div>}<p className="fine-print">A miss, reveal, or hint counts as supported practice. Repeating a known position can improve recall without proving transfer to real games.</p></div>
            <aside className="surface"><h2>Shape your practice</h2>
              <label htmlFor="difficulty">Starting puzzle difficulty</label>
              <select id="difficulty" value={view.settings.rating} onChange={e => void model.saveSettings({ rating: Number(e.target.value) })}>{[600, 800, 1000, 1200, 1400, 1600, 1800].map(n => <option key={n}>{n}</option>)}</select>
              <p className="fine-print">Use Lichess puzzle difficulty as a starting point. It is not mapped to Chess.com Elo.</p>
              <label htmlFor="new-cap">New positions a day</label>
              <select id="new-cap" value={view.settings.dailyNewCap} onChange={e => void model.saveSettings({ dailyNewCap: Number(e.target.value) })}>{[0, 5, 10, 15, 20].map(n => <option key={n}>{n}</option>)}</select>
              <label htmlFor="review-cap">Reviews a day</label>
              <select id="review-cap" value={view.settings.dailyReviewCap} onChange={e => void model.saveSettings({ dailyReviewCap: Number(e.target.value) })}>{[10, 20, 30, 50].map(n => <option key={n}>{n}</option>)}</select>
              <details><summary>How the practice mix works</summary>
                <p className="small">Each day’s set holds up to {caps.reviewCap} reviews and {caps.newCap} new positions; both numbers are a judgement call, not a validated prescription. When Claude has set a focus, those themes come up more often and positions are drawn from your games, puzzles and endgames in the proportions Claude chose.</p>
                <p className="small">Clean recalls return after 1, 3, 7, 14, 30, then 60 days. Supported answers return after 10 minutes. These intervals and weights are product heuristics, not a validated prescription.</p>
              </details></aside></div>
          <BackupPanel saveFile={saveFile} makeBackup={makeBackup} importBackup={importBackup}/>
        </section>}
      </>}
      <footer className="site-footer"><span>Next Move · Completed-game study and deliberate practice.</span><button onClick={() => { goTab('learn'); setShowSources(true); }}>Sources & approach</button><span>Includes Stockfish, free software under the GNU General Public License v3.</span><a href="COPYING-GPL-3.0.txt" target="_blank" rel="noreferrer">GPL-3.0 licence</a><a href="https://github.com/nmrugg/stockfish.js" target="_blank" rel="noreferrer">Engine source</a></footer>
    </main>
  </div>;
}

/** `settings.chesscomUser`: read by Claude's game import (scripts/ingest.md) and used for the archive link (review P2-8). */
export const CHESSCOM_USER_RE = /^[A-Za-z0-9_-]{3,25}$/;
function ChesscomUserForm({ current, onSave }: { current: string; onSave: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState(current), [message, setMessage] = useState('');
  useEffect(() => setName(current), [current]);
  return <form className="chesscom-form" onSubmit={async e => {
    e.preventDefault();
    const value = name.trim();
    if (!CHESSCOM_USER_RE.test(value)) { setMessage('Use 3 to 25 letters, digits, hyphens or underscores.'); return; }
    setMessage((await onSave(value)) ? 'Saved. Claude uses this name to add your new games.' : 'That did not save. Try again in a moment.');
  }}>
    <label htmlFor="chesscom-user">Chess.com username</label>
    <div className="input-row"><input id="chesscom-user" autoComplete="off" value={name} onChange={e => setName(e.target.value)}/><button type="submit" className="secondary">Save</button></div>
    {message && <p className="small" role="status">{message}</p>}
  </form>;
}
