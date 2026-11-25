/**
 * Agent-written seed documents besides the pack: `plan/current`, one `notes/*` document and `ingest/state`
 * (port plan sections 3 and 10 item h). Pure and deterministic: every timestamp derives from `at`.
 */
import { paths } from '../contract/docs';
import { cmp, validateDoc } from './packDocs';

const DAY_MS = 86_400_000;
/** Plan lifetime: the refresh is weekly, so a plan lasts two refresh cycles before the page stops applying it (judgement call). */
export const PLAN_DAYS = 14;

/** Bank themes a plan may focus (trainable themes the producer weights). */
const FOCUS_THEMES = ['hangingPiece', 'fork', 'pin', 'discoveredAttack', 'skewer', 'defensiveMove', 'backRankMate', 'exposedKing'] as const;
/** Producer motif tags that feed each focus theme (producer README, motif -> theme table). */
const MOTIFS_FOR: Record<string, string[]> = {
  hangingPiece: ['missed-material', 'allowed-capture', 'hanging-piece'],
  fork: ['allowed-fork', 'missed-tactic'],
  pin: ['allowed-pin-skewer', 'missed-tactic'],
  discoveredAttack: ['missed-tactic', 'allowed-tactic'],
  skewer: ['allowed-pin-skewer'],
  defensiveMove: ['threat-ignored', 'allowed-mate'],
  backRankMate: ['allowed-mate', 'missed-mate'],
  exposedKing: ['king-safety'],
};

const PRETTY: Record<string, string> = {
  hangingPiece: 'hanging pieces', fork: 'forks', pin: 'pins', discoveredAttack: 'discovered attacks', skewer: 'skewers',
  defensiveMove: 'defensive moves', backRankMate: 'back-rank mates', exposedKing: 'exposed kings',
};

type Profile = Record<string, unknown>;
const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * `plan/current` from the producer's priors.
 * - focus: themes whose prior is above 1 (the producer moves a weight off 1 only when its interval supports it),
 *   strongest first, at most 4. Focus weight = 1 + (prior - 1) / 3, so prior 2.5 -> 1.5: a nudge on top of the
 *   priors the page already applies, not a second full multiplication (judgement call).
 * - mix: bank 0.45, pack 0.35, endgame 0.1, agent 0.1. Mixing his own positions with bank puzzles follows A3
 *   (interleaving) and B10 (puzzle-to-game transfer is thin, so his own games carry weight); the exact fractions
 *   are a judgement call. Drill-set share, decided by the lead (review 2 P1-1): when at least one drill set
 *   is active, its share is `mix.agent` as written if greater than 0, otherwise 0.10;
 *   with no active set the share is redistributed to the other sources.
 */
export function buildPlan(profile: Profile, at: string): Record<string, unknown> {
  const priors = rec(profile.themePriors), motifs = rec(profile.motifs);
  const focus = FOCUS_THEMES
    .map(theme => ({ theme, prior: n(priors[theme]) ?? 1 }))
    .filter(f => f.prior > 1)
    .sort((a, b) => b.prior - a.prior || cmp(a.theme, b.theme))
    .slice(0, 4)
    .map(({ theme, prior }) => {
      const tagCounts = (MOTIFS_FOR[theme] ?? []).map(tag => [tag, n(rec(motifs[tag]).count)] as const).filter(([, c]) => c !== null);
      const evidence = tagCounts.map(([tag, c]) => `${tag} ${c}`).join(', ');
      return {
        theme,
        weight: Math.round((1 + (prior - 1) / 3) * 100) / 100,
        reason: `Engine pass prior ${prior}${evidence ? `; errors in his games tagged ${evidence}` : ''}.`.slice(0, 300),
      };
    });
  const atMs = Date.parse(at);
  const overall = rec(profile.overall);
  const bp100 = n(overall.blundersPer100);
  return {
    updatedAt: at,
    author: 'claude (seed from the engine pass)',
    expires: new Date(atMs + PLAN_DAYS * DAY_MS).toISOString(),
    focus,
    mix: { bank: 0.45, pack: 0.35, endgame: 0.1, agent: 0.1 },
    mixNote: 'mix = share of positions drawn from each source until expires: bank puzzles, pack (his games), endgame drills, agent (active drills/* sets). When at least one drill set is active, its share is mix.agent as written if greater than 0, otherwise 0.10. With no active set, that share is redistributed to the other sources. All four keys are required and must sum to 1, or the page ignores the whole plan. To stop a set, set drills/<id>.active to false.',
    // Judgement call: about 15 minutes is roughly one 10-position session plus review; not from the evidence base.
    sessionMinutes: 15,
    noteToLearner: `This week leans on ${focus.map(f => PRETTY[f.theme] ?? f.theme).join(', ') || 'mixed practice'}${bp100 !== null ? `: your games show ${bp100} blunders per 100 moves` : ''}. About four positions in ten come from your own games.`.slice(0, 600),
  };
}

/**
 * One note for the home screen. Content: the profile's headline numbers and what is new.
 * Wording grounds: "what does your move allow?" is C1 (Heisman's safety check); measuring games rather than
 * trusting the feeling of progress is B10 and A4; the rest is a judgement call.
 */
export function buildNote(profile: Profile, counts: Record<string, number>): { id: string; data: Record<string, unknown> } {
  const overall = rec(profile.overall), motifs = rec(profile.motifs), conv = rec(profile.conversion), sample = rec(profile.sample);
  const missed = n(rec(motifs['missed-material']).count);
  const notWon = n(conv.notWonShare);
  const parts = [
    `Your engine-checked pack is in: ${counts.cards ?? 0} positions from your last ${n(sample.games) ?? '?'} games, plus ${counts.punish ?? 0} "Punish it" positions where you play your opponent's best reply to your own mistake.`,
    n(overall.blundersPer100) !== null ? `In those games you made ${n(overall.blundersPer100)} blunders per 100 moves${missed !== null ? ` and missed free material ${missed} times` : ''}.` : '',
    notWon !== null ? `${Math.round(notWon * 100)}% of games where you stood clearly winning were not won.` : '',
    'Before each move, ask what it allows.',
  ];
  let text = parts.filter(Boolean).join(' ');
  if (text.length > 600) text = text.slice(0, 597) + '...';
  const day = String(profile.generatedAt ?? '').slice(0, 10).replace(/-/g, '') || '00000000';
  return { id: `n-${day}-pack`, data: { text, createdAt: String(profile.generatedAt ?? '') } };
}

/** `ingest/state` after the seeded engine pass (item h). `lastArchive` is the chess.com archive month `YYYY/MM`. */
export function buildIngestState(profile: Profile, packVersion: string, at: string): Record<string, unknown> {
  const sample = rec(profile.sample);
  const to = typeof sample.to === 'string' ? sample.to : String(at).slice(0, 10);
  return {
    lastArchive: `${to.slice(0, 4)}/${to.slice(5, 7)}`,
    lastGameEnd: `${to}T23:59:59.000Z`,
    gamesProcessed: n(sample.games) ?? 0,
    packVersion,
    at,
    sampleFrom: sample.from ?? null,
    sampleTo: to,
    note: 'lastGameEnd is the end of the UTC day of the newest sampled game; the next ingest fetches games ending after it.',
  };
}

export const SAMPLE_DRILL_SET = 'sample-free-material';
export const SAMPLE_DRILL_SIZE = 6;
/**
 * One small agent drill set so the drills path works from day one (review 2 P1-1, P2-10). Built only from
 * positions already in the pack: the newest graded pack cards (kind "mistake") whose motifs include
 * `missed-material`, his most common costly error in the profile. One move each (the pack card's answer),
 * with the pack card's explanation; `fromCard` names the source pack card. The stored refutation is left out:
 * it answers his GAME move, and a drill page could show it as the reply to a different move.
 * The same positions also appear as pack cards; that repetition is accepted for a sample (judgement call).
 */
export function buildSampleDrills(packCards: Array<Record<string, unknown>>, at: string): { id: string; data: Record<string, unknown> } | null {
  const pick = packCards
    .filter(c => c.kind === 'mistake' && ((c.pack as { motifs?: string[] } | undefined)?.motifs ?? []).includes('missed-material'))
    .sort((a, b) => { const da = String((a.pack as { date: string }).date), db = String((b.pack as { date: string }).date); return da < db ? 1 : da > db ? -1 : cmp(String(a.id), String(b.id)); })
    .slice(0, SAMPLE_DRILL_SIZE);
  if (!pick.length) return null;
  const cards = pick.map((c, n) => {
    const d = c.pack as { phase: string };
    return {
      id: `agent-${SAMPLE_DRILL_SET}-${n}`, fen: c.fen, moves: c.moves, themes: ['hangingPiece', d.phase], rating: c.rating,
      explanation: String(c.explanation ?? '').slice(0, 400), fromCard: c.id,
    };
  });
  return {
    id: SAMPLE_DRILL_SET,
    data: {
      title: 'Free material you missed',
      reason: 'Sample set from your own games: positions where you missed winning material, the most common costly error in your games. Each is already in your pack; here they come as one short set.',
      createdAt: at, active: true, cards,
    },
  };
}

/** All non-pack seed docs, validated against the contract. */
export function buildSeedDocs(profile: Profile, counts: Record<string, number>, packVersion: string, at: string, packCards: Array<Record<string, unknown>> = []) {
  const note = buildNote(profile, counts);
  const drills = buildSampleDrills(packCards, at);
  const docs = [
    { path: paths.plan(), data: buildPlan(profile, at) },
    { path: paths.note(note.id), data: note.data },
    { path: paths.ingestState(), data: buildIngestState(profile, packVersion, at) },
    ...(drills ? [{ path: paths.drills(drills.id), data: drills.data }] : []),
  ];
  for (const d of docs) validateDoc(d.path, d.data);
  return docs;
}
