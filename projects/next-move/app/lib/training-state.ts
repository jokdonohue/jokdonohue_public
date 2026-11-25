import { z } from 'zod';
import { Chess } from 'chess.js';
import { parsePgn, type ParsedGame } from './pgn';
import type { Puzzle } from './puzzles';
import { trainingThemes } from './scheduler.js';

export type Attempt = { puzzleId: string; themes: string[]; correct: boolean; unassisted: boolean; hints: number; revealed: boolean; durationMs: number; at: number };
export type Card = { attempts: number; successes: number; lapses: number; streak: number; intervalDays: number; lastAttempt: number; due: number };
export type Skill = { attempts: number; successes: number; lastAttempt: number };
export type Progress = { attempts: Attempt[]; cards: Record<string, Card>; skills: Record<string, Skill>; settings: { rating: number; sessionLength: number }; settingsUpdatedAt: number };
export type PersonalPuzzle = Puzzle & { title?: string; explanation?: string };
export type SavedGame = ParsedGame & { userColor?: 'w'|'b'; importedAt: number };
export type TrainingState = { version: 1; progress: Progress; games: SavedGame[]; personalPuzzles: PersonalPuzzle[] };
export const newState = (): TrainingState => ({ version: 1, progress: {attempts: [], cards: {}, skills: {}, settings: {rating: 1000, sessionLength: 10}, settingsUpdatedAt: 0}, games: [], personalPuzzles: [] });

const key = z.string().min(1).max(200).refine(s => !['__proto__','constructor','prototype'].includes(s));
const number = z.number().finite().nonnegative();
const themes = z.array(key).min(1).max(30);
const uci = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
const attempt = z.object({puzzleId:key,themes,correct:z.boolean(),unassisted:z.boolean(),hints:number.int(),revealed:z.boolean(),durationMs:number,at:number}).refine(a=>a.unassisted === (a.correct && a.hints===0 && !a.revealed));
const card = z.object({attempts:number.int(),successes:number.int(),lapses:number.int(),streak:number.int(),intervalDays:number,lastAttempt:number,due:number});
const skill = z.object({attempts:number.int(),successes:number.int(),lastAttempt:number});
const game = z.object({id:key,headers:z.record(z.string().max(5000)),moves:z.array(z.object({san:z.string().max(20),uci,before:z.string().max(200),after:z.string().max(200),color:z.enum(['w','b']),ply:number.int()})).max(600),pgn:z.string().max(2_000_000),result:z.enum(['1-0','0-1','1/2-1/2']),userColor:z.enum(['w','b']).optional(),importedAt:number});
const puzzle = z.object({id:key,fen:z.string().max(200),moves:z.array(uci).min(1).max(100),rating:number.max(4000),themes,gameUrl:z.string().max(2000).refine(s=>s===''||/^https?:\/\//.test(s)),title:z.string().max(200).optional(),explanation:z.string().max(2000).optional()});
const schema = z.object({version:z.literal(1),progress:z.object({attempts:z.array(attempt).max(20_000),cards:z.record(key,card),skills:z.record(key,skill),settings:z.object({rating:z.number().int().min(600).max(1800),sessionLength:z.number().int().min(3).max(30)}),settingsUpdatedAt:number.default(0)}),games:z.array(game).max(100),personalPuzzles:z.array(puzzle).max(1000)});

export function assertStateLimits(state:TrainingState){
  if(state.progress.attempts.length>20_000||state.games.length>100||state.personalPuzzles.length>1000||new TextEncoder().encode(JSON.stringify(state)).length>3_950_000) throw new Error('The combined profile is too large to save. Both existing copies are preserved. Export a backup before adding more records.');
}

export function readState(input: unknown, options:{verifyChess?:boolean}={}): TrainingState {
  const state = schema.parse(input);
  if(Object.keys(state.progress.cards).length>20_000||Object.keys(state.progress.skills).length>500) throw new Error('Progress exceeds the supported profile size.');
  if(new Set(state.games.map(g=>g.id)).size!==state.games.length||new Set(state.personalPuzzles.map(p=>p.id)).size!==state.personalPuzzles.length) throw new Error('Backup contains duplicate record IDs.');
  if(options.verifyChess!==false){
    for(const item of state.games){const [replayed] = parsePgn(item.pgn); if(!replayed||replayed.id!==item.id||JSON.stringify(replayed.moves)!==JSON.stringify(item.moves)||JSON.stringify(replayed.headers)!==JSON.stringify(item.headers)||replayed.result!==item.result) throw new Error('Saved game does not match its PGN.');}
    for(const item of state.personalPuzzles){const board=new Chess(item.fen); for(const move of item.moves) board.move({from:move.slice(0,2),to:move.slice(2,4),promotion:move[4]});}
  }
  // Attempt history is the source of truth; never trust imported cached totals.
  const normalized=mergeStates(newState(),state);
  normalized.progress.settings=state.progress.settings;
  normalized.progress.settingsUpdatedAt=state.progress.settingsUpdatedAt;
  return normalized;
}

/** Backup text. Compact JSON, the form the size limits measure: an indented export passed the 4 MB import limit long before the live cap. */
export function exportState(state: TrainingState): string { return JSON.stringify(state); }

/** Raw-text bound for a backup file. Indented exports made before 2026-11-09 can exceed 4 MB as text (review R7). */
export const MAX_BACKUP_TEXT_BYTES = 16_000_000;
/** Bound on the compact (re-serialised) backup, the form the live limits measure. */
export const MAX_BACKUP_BYTES = 4_000_000;
export const NOT_A_BACKUP = 'This file is not a Next Move backup, or it is damaged. Your saved progress is unchanged.';

export function parseState(text: string): TrainingState {
  const bytes=(s:string)=>new TextEncoder().encode(s).length;
  if(bytes(text)>MAX_BACKUP_TEXT_BYTES) throw new Error('Backup exceeds 16 MB.');
  let parsed:unknown;
  try{parsed=JSON.parse(text,(k,v)=>{if(['__proto__','constructor','prototype'].includes(k)) throw new Error('Invalid backup key.');return v;});}
  catch(cause){throw new Error(cause instanceof Error&&cause.message==='Invalid backup key.'?cause.message:NOT_A_BACKUP);}
  if(bytes(JSON.stringify(parsed))>MAX_BACKUP_BYTES) throw new Error('Backup exceeds 4 MB.');
  // Validation detail is for developers; the person restoring a file needs one plain sentence (QA P2-3).
  try{return readState(parsed);}catch(cause){if(cause instanceof z.ZodError)throw new Error(NOT_A_BACKUP);throw cause;}
}

/** Merge append-only attempts and records after another device has saved. */
export function mergeStates(remote: TrainingState, local: TrainingState): TrainingState {
  const attempts = [...new Map([...remote.progress.attempts,...local.progress.attempts].map(a=>[`${a.puzzleId}:${a.at}`,a])).values()].sort((a,b)=>a.at-b.at);
  const cards: Record<string,Card> = {};
  const skills: Record<string,Skill> = {};
  for(const a of attempts){
    const previous=cards[a.puzzleId]??{attempts:0,successes:0,lapses:0,streak:0,intervalDays:0,lastAttempt:0,due:0};
    const streak=a.unassisted?previous.streak+1:0;
    const intervalDays=a.unassisted?[0,1,3,7,14,30,60][Math.min(streak,6)]:10/1440;
    cards[a.puzzleId]={attempts:previous.attempts+1,successes:previous.successes+Number(a.unassisted),lapses:previous.lapses+Number(!a.unassisted),streak,intervalDays,lastAttempt:a.at,due:a.at+intervalDays*86_400_000};
    for(const t of trainingThemes(a.themes)){const old=skills[t]??{attempts:0,successes:0,lastAttempt:0};skills[t]={attempts:old.attempts+1,successes:old.successes+Number(a.unassisted),lastAttempt:a.at};}
  }
  const settingsOwner=remote.progress.settingsUpdatedAt>=local.progress.settingsUpdatedAt?remote.progress:local.progress;
  const merged:TrainingState={version:1,progress:{attempts,cards,skills,settings:settingsOwner.settings,settingsUpdatedAt:settingsOwner.settingsUpdatedAt},games:[...new Map([...remote.games,...local.games].map(g=>[g.id,g])).values()],personalPuzzles:[...new Map([...remote.personalPuzzles,...local.personalPuzzles].map(p=>[p.id,p])).values()]};
  assertStateLimits(merged);
  return merged;
}
