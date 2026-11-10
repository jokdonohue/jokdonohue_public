'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { BookOpen, ChartNoAxesCombined, ChevronRight, Download, Flag, GraduationCap, Lightbulb, RefreshCw, RotateCcw, Upload, X, Check, ArrowRight, Target } from 'lucide-react';
import Chessboard from './Chessboard';
import { useTrainingState } from './useTrainingState';
import { puzzles, PUZZLE_SOURCE, type Puzzle } from '@/lib/puzzles';
import { parsePgn } from '@/lib/pgn';
import { identifyPlayerColor } from '@/lib/player';
import { analyzeGame, type GameAnalysis, type AnalysisMistake } from '@/lib/chess-engine';
import { selectPuzzle, recordAttempt, getSkillStats, trainingThemes } from '@/lib/scheduler.js';
import { principles, sources, openingDrills } from '@/lib/curriculum';
import { parseState, mergeStates, exportState, type PersonalPuzzle, type SavedGame } from '@/lib/training-state';
import { positionThemes } from '@/lib/game-phase';
import { loadPersonalPack, packDetailOf, practicePools, sanMoves, fenAfter, withThemePriors, type PersonalPack } from '@/lib/personal-pack';
import PersonalPackSummary from './PersonalPackSummary';
import { endgameDrills, isEndgameDrill } from '@/lib/endgames';
import { sessionStartAt, sessionCount } from '@/lib/session';
import { setupMove } from '@/lib/puzzle-setup';
import { drillGoal, recentExclusion, NEW_PROFILE_ATTEMPTS } from '@/lib/practice';

const move=(board:Chess,uci:string)=>board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]});
const THEMES=[['all','Mixed practice'],['review','Due for review'],['personal','From my games'],['hangingPiece','Loose pieces'],['fork','Forks'],['pin','Pins'],['discoveredAttack','Discovered attacks'],['mateIn1','Mate in one'],['mateIn2','Mate in two'],['defensiveMove','Defensive resources'],['equality','Get back into the game'],['endgame','Endgames'],['endgame-tech','Endgame technique'],['planb','Hold the draw (Plan B)'],['pawnEndgame','Pawn endings'],['rookEndgame','Rook endings'],['promotion','Promotion']];
// One name per theme in the focus menu, the tags and Progress (QA P2-5).
const LABELS:Record<string,string>=Object.fromEntries(THEMES.filter(([id])=>!['all','review','personal','equality'].includes(id)));
const pretty=(s:string)=>LABELS[s]??s.replace(/([a-z])([A-Z0-9])/g,'$1 $2').replace(/^./,c=>c.toUpperCase());
// The Lichess sample plus the tablebase-verified technique drills.
const BANK=[...puzzles,...endgameDrills];
// Shown only when an installed personal pack contains these sets.
const PACK_SETS=[['pack-stalemate','stalemate','Avoid stalemate (your games)'],['pack-conversion','conversion','Convert the win (your games)']] as const;
const POOL_FILTERS=['all','personal','review',...PACK_SETS.map(([id])=>id)];
function clock(seconds:number){const s=Math.max(0,Math.round(seconds));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
const SESSION_KEY='next-move-session-start';
const DEMO='[Event "Example completed game"]\n[White "White"]\n[Black "Black"]\n[Result "1-0"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';
function sourceLinks(ids:string[]){return ids.map(id=>sources.find(s=>s.id===id)).filter(Boolean).map(s=><a key={s!.id} href={s!.url} target="_blank" rel="noreferrer">{s!.author}: {s!.title}</a>);}
function download(filename:string,text:string){const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function sanLine(p:Puzzle){const board=new Chess(p.fen);return p.moves.map(uci=>move(board,uci).san).join('  ');}
function personalFrom(m:AnalysisMistake,game:SavedGame,rating:number):PersonalPuzzle{
  const board=new Chess(m.fen);
  const themes=['personal',...positionThemes(m.fen,m.ply)];
  if(m.before.cp!==null&&m.before.cp*(m.color==='w'?1:-1)<-150)themes.push('defensiveMove');
  if(m.before.mate!==null)themes.push('mate');
  const best=move(board,m.bestUci).san;
  return {id:`personal-${m.id}`,fen:m.fen,moves:[m.bestUci],rating,themes,gameUrl:/^https:\/\/(www\.)?chess\.com\//.test(game.headers.Link??'')?game.headers.Link:'',title:`Move ${Math.ceil(m.ply/2)} against ${game.headers[m.color==='w'?'Black':'White']??'your opponent'}`,explanation:`You played ${m.playedSan}. The saved engine candidate is ${best}, at depth ${m.depth}. This short search is a practice prompt; other moves may also be reasonable.`};
}

export default function Trainer({userId}:{userId:string|null}){
  const {state,update,ready,status,error,setError,sync}=useTrainingState(userId);
  const [tab,setTab]=useState('practice'),[theme,setTheme]=useState('all');
  const [active,setActive]=useState<PersonalPuzzle|null>(null),[fen,setFen]=useState(''),[index,setIndex]=useState(0),[lastMove,setLastMove]=useState('');
  const [feedback,setFeedback]=useState(''),[complete,setComplete]=useState(false),[hints,setHints]=useState(0),[errors,setErrors]=useState(0),[revealed,setRevealed]=useState(false);
  const recorded=useRef(false),started=useRef(0),rehearsing=useRef(false);
  // "This session" = attempts recorded since this tab's session began, so a reload keeps the count.
  const [sessionStart,setSessionStart]=useState(()=>{try{const saved=Number(sessionStorage.getItem(SESSION_KEY));if(saved>0)return saved;const now=Date.now();sessionStorage.setItem(SESSION_KEY,String(now));return now;}catch{return Date.now();}});
  const sessionDone=sessionCount(state.progress.attempts,sessionStart);
  // A new session starts after an idle gap, checked whenever a position starts or an attempt is recorded.
  function keepSession(){const next=sessionStartAt(sessionStart,state.progress.attempts.at(-1)?.at,Date.now());if(next===sessionStart)return;setSessionStart(next);try{sessionStorage.setItem(SESSION_KEY,String(next));}catch{}}
  // Positions served in this tab, so "Another position" does not alternate between two (QA P1-3, audit A1 F3).
  const recent=useRef<string[]>([]);
  // Installed personal pack (static, never stored in progress). No pack: the pools below equal the previous ones.
  const [pack,setPack]=useState<PersonalPack|null>(null);
  useEffect(()=>{let live=true;void loadPersonalPack().then(p=>{if(live)setPack(p);});return()=>{live=false;};},[]);
  const pools=useMemo(()=>practicePools<PersonalPuzzle>(state.personalPuzzles,pack?pack.cards:[],BANK),[state.personalPuzzles,pack]);
  const allPuzzles=pools.all;
  const themeOptions=useMemo(()=>[...THEMES,...PACK_SETS.filter(([,set])=>pack?.cards.some(c=>c.pack.sets.includes(set))).map(([id,,label])=>[id,label])],[pack]);
  const [pgnText,setPgnText]=useState(''),[username,setUsername]=useState(''),[fetching,setFetching]=useState(false),[gameMessage,setGameMessage]=useState('');
  const [selectedGame,setSelectedGame]=useState<string|null>(null),[color,setColor]=useState<''|'w'|'b'>(''),[analysis,setAnalysis]=useState<GameAnalysis|null>(null),[analyzing,setAnalyzing]=useState(false),[analysisProgress,setAnalysisProgress]=useState({completed:0,total:0}),[replayPly,setReplayPly]=useState(0);
  const abort=useRef<AbortController|null>(null);
  const [showSources,setShowSources]=useState(false);
  const game=state.games.find(g=>g.id===selectedGame);
  useEffect(()=>()=>abort.current?.abort(),[]);

  function startPuzzle(p:PersonalPuzzle,rehearse=false){keepSession();if(active&&!recorded.current&&(errors>0||hints>0))finish(false,false);if(!rehearse)recent.current=[...recent.current.filter(id=>id!==p.id),p.id].slice(-5);rehearsing.current=rehearse;setActive(p);setFen(p.fen);setIndex(0);setLastMove(setupMove(p.id)??'');setFeedback('');setComplete(false);setHints(0);setErrors(0);setRevealed(false);recorded.current=false;started.current=Date.now();}
  function choose(nextTheme=theme){
    // Leaving a position after help or an incorrect move is still practice evidence.
    if(active&&!recorded.current&&(errors>0||hints>0))finish(false,false);
    let pool=pools.mixed;
    if(nextTheme==='personal')pool=pools.own;
    if(nextTheme==='review')pool=allPuzzles.filter(p=>(state.progress.cards[p.id]?.due??Infinity)<=Date.now());
    const packSet=PACK_SETS.find(([id])=>id===nextTheme);
    if(packSet)pool=pools.own.filter(p=>packDetailOf(p)?.sets.includes(packSet[1]));
    // Reserve a regular place for personal positions; the cadence is a transparent heuristic.
    if(nextTheme==='all'&&pools.own.length&&state.progress.attempts.length%4===3)pool=pools.own;
    // A new profile starts on tactics, not on an endgame drill (QA P1-3; the threshold is a judgement call).
    if(nextTheme==='all'&&state.progress.attempts.length<NEW_PROFILE_ATTEMPTS&&pool.some(p=>!isEndgameDrill(p)))pool=pool.filter(p=>!isEndgameDrill(p));
    // Pack motif priors nudge new-material order only (spec §3); stored progress is unchanged.
    const selected=selectPuzzle(pool,withThemePriors(state.progress,pack?.priors),{theme:POOL_FILTERS.includes(nextTheme)?'all':nextTheme,excludeIds:recentExclusion(pool,POOL_FILTERS.includes(nextTheme)?'all':nextTheme,recent.current,active?.id)}) as PersonalPuzzle|null;
    if(selected)startPuzzle(selected);else{setActive(null);setFeedback(nextTheme==='review'?'No reviews are due. Try mixed practice, or return after your next review is scheduled.':nextTheme==='personal'?'Import and analyse a completed game to create personal practice positions.':'No positions match this filter. Choose another theme.');}
  }
  useEffect(()=>{if(ready&&!active&&theme==='all')choose();},[ready]); // Load a first position once, without resetting an in-progress attempt.
  function finish(wasRevealed=false,wasClean=errors===0){
    if(!active||recorded.current)return;recorded.current=true;setComplete(true);
    // A rehearsal replays a line just seen; recording it would book a clean recall (audit A1 F1).
    if(rehearsing.current)return;
    keepSession();
    update(old=>({...old,progress:recordAttempt(old.progress,active,{correct:!wasRevealed&&wasClean,hints,revealed:wasRevealed,durationMs:Date.now()-started.current})}));
  }
  function play(uci:string){
    if(!active||complete)return;
    const board=new Chess(fen);let played;
    try{played=move(board,uci);}catch{setFeedback('That move is not legal in this position.');return;}
    const alternateMate=board.isCheckmate();
    if(uci!==active.moves[index]&&!alternateMate){setErrors(n=>n+1);setFeedback(active.themes.includes('personal')?'That differs from the saved engine candidate. Try the recorded line, or reveal it to compare.':isEndgameDrill(active)?(board.isStalemate()?'That move gives stalemate, so the game would be drawn. Try again or reveal the line.':'Not the move this drill is practising. Try again or reveal the line.'):'That is not the solution line. Check the opponent’s strongest reply, then try again.');return;}
    let next=index+1,reply='';setLastMove(uci);
    if(!alternateMate&&next<active.moves.length){reply=move(board,active.moves[next]).san;setLastMove(active.moves[next]);next++;}
    setFen(board.fen());setIndex(next);
    if(alternateMate||next>=active.moves.length){setFeedback(rehearsing.current?'Rehearsal complete. Rehearsals are not recorded as new attempts.':alternateMate&&uci!==active.moves[index]?'Checkmate — another valid finish. The source line below shows a different mating move.':errors||hints?'Line completed. This position will return for another look.':'Well found. You followed the line all the way through.');finish();}
    else setFeedback(`Good. Your opponent replies ${reply}. Find your next move.`);
  }
  function reveal(){
    // Step the board through the rest of the line so the final position is visible (QA P2-10).
    if(active){const board=new Chess(fen);let last=lastMove;for(const uci of active.moves.slice(index)){try{move(board,uci);last=uci;}catch{break;}}setFen(board.fen());setIndex(active.moves.length);setLastMove(last);}
    setRevealed(true);setFeedback(rehearsing.current?'Line shown. Rehearsals are not recorded.':active?.themes.includes('personal')?'Engine candidate shown. This counts as supported practice and returns soon.':'Solution revealed. This counts as supported practice and returns soon.');finish(true);}
  function importPgn(text:string,account=username){
    try{
      const parsed=parsePgn(text).map(g=>({...g,importedAt:Date.now(),userColor:identifyPlayerColor(g.headers,account)}));
      let firstColor:''|'w'|'b'='';
      const saved=update(old=>{
        const games=new Map(old.games.map(g=>[g.id,g]));
        for(const g of parsed)games.set(g.id,{...g,userColor:g.userColor??games.get(g.id)?.userColor});
        firstColor=games.get(parsed[0].id)?.userColor??'';
        return {...old,games:[...games.values()]};
      });
      if(!saved)return;
      setSelectedGame(parsed[0].id);setColor(firstColor);setReplayPly(0);setAnalysis(null);
      setGameMessage(`${parsed.length} completed game${parsed.length===1?'':'s'} read. Choose your side, then analyse.`);setError('');
    }catch(e){setError(e instanceof Error?e.message:'Could not read this PGN.');}
  }
  async function fetchGames(){
    const name=username.trim();if(!/^[a-zA-Z0-9_-]{3,25}$/.test(name)){setError('Enter a valid Chess.com username.');return;}
    setFetching(true);setGameMessage('Fetching public completed games…');
    try{
      const response=await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(name)}/games/archives`);if(!response.ok)throw new Error(response.status===404?'That username was not found.':'Chess.com did not return the archive. Try again later, or import a PGN.');
      const {archives}=await response.json() as {archives:unknown};if(!Array.isArray(archives)||!archives.length)throw new Error('No public completed-game archives were found.');
      let found:{pgn:string;end_time:number;rules:string}[]=[];
      for(const url of archives.slice(-2).reverse()){
        if(typeof url!=='string'||!/^https:\/\/api\.chess\.com\/pub\/player\/[a-zA-Z0-9_-]+\/games\/\d{4}\/\d{2}$/.test(url))throw new Error('Unexpected Chess.com archive address. Use a PGN export.');
        const res=await fetch(url);if(!res.ok)throw new Error('Chess.com could not load that month. Try again later, or use PGN import.');
        const data=await res.json() as {games?:{pgn:string;end_time:number;rules:string}[]};found.push(...(data.games??[]).filter((g:{pgn?:string;rules?:string})=>g.pgn&&g.rules==='chess'));if(found.length>=10)break;
      }
      const recent=found.sort((a,b)=>b.end_time-a.end_time).slice(0,10);if(!recent.length)throw new Error('No completed standard chess games found in the last two available months.');
      importPgn(recent.map(g=>g.pgn).join('\n\n'),name);
    }catch(e){setError(e instanceof Error?e.message:'Could not reach Chess.com. Paste or upload a PGN instead.');setGameMessage('PGN import remains available.');}finally{setFetching(false);}
  }
  async function runAnalysis(){
    if(!game||!color)return;setAnalyzing(true);setAnalysis(null);setError('');setAnalysisProgress({completed:0,total:game.moves.filter(m=>m.color===color).length});
    const controller=new AbortController();abort.current=controller;
    try{
      const result=await analyzeGame(game,color,p=>setAnalysisProgress(p),controller.signal);setAnalysis(result);
      const candidates=result.mistakes.slice(0,8).map(m=>personalFrom(m,game,state.progress.settings.rating));
      update(old=>({...old,personalPuzzles:[...new Map([...old.personalPuzzles,...candidates].map(p=>[p.id,p])).values()],games:old.games.map(g=>g.id===game.id?{...g,userColor:color}:g)}));
      setGameMessage(`${result.analyzedMoves} of ${result.totalMoves} moves analysed. ${candidates.length} practice position${candidates.length===1?'':'s'} added${result.partial?' from this partial scan':''}.`);
    }catch(e){setGameMessage(controller.signal.aborted?'Analysis stopped. Your game is still saved.':'');if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Analysis failed.');}finally{setAnalyzing(false);abort.current=null;}
  }
  const detail=packDetailOf(active);
  const skills=getSkillStats(state.progress,allPuzzles) as {theme:string;attempts:number;successes:number;accuracy:number|null;label:string;total:number}[];
  const practiced=skills.filter(s=>s.attempts>0).sort((a,b)=>(a.accuracy??1)-(b.accuracy??1));
  const attempts=state.progress.attempts,clean=attempts.filter(a=>a.unassisted).length;
  // Count due cards whose position is still available (a removed pack must not leave reviews that cannot be served).
  const nowMs=Date.now(),due=allPuzzles.reduce((n,p)=>n+Number((state.progress.cards[p.id]?.due??Infinity)<=nowMs),0);
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e=>{e.preventDefault();setTab('practice');}}><span className="brand-piece">♞</span><span>Next Move<small>Your practice room</small></span></a>
      <nav aria-label="Main navigation">{[{id:'practice',label:'Practice',Icon:Target},{id:'games',label:'My games',Icon:Flag},{id:'learn',label:'Learn',Icon:BookOpen},{id:'progress',label:'Progress',Icon:ChartNoAxesCombined}].map(({id,label,Icon})=><button key={id} className={tab===id?'nav active':'nav'} onClick={()=>setTab(id)} aria-current={tab===id?'page':undefined}><Icon size={20}/><span>{label}</span>{id==='practice'&&due>0&&<b>{due}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="profile-dot">♔</div><p>A little, often.<small>Patterns grow with practice.</small></p></div>
    </aside>
    <main>
      <header className="topbar"><span>{tab==='practice'?'Make the next move count.':tab==='games'?'Your games are your curriculum.':tab==='learn'?'Understand the idea. Then rehearse it.':'See what your practice is showing.'}</span><span className="save-status"><i/>{ready?status:'Loading…'}</span></header>
      {error&&<div className="notice error" role="alert"><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss message"><X size={18}/></button></div>}
      {!ready?<div className="empty-state">Loading your practice room…</div>:<>
      {tab==='practice'&&<section className="page practice-page">
        <div className="page-heading"><div><h1>Your next position</h1><p>Take your time. Find the idea, then calculate the reply.</p></div><div className="session-pill"><span>{sessionDone}</span> / {state.progress.settings.sessionLength}<small>this session</small></div></div>
        <div className="practice-toolbar"><label htmlFor="theme">Practice focus</label><select id="theme" value={theme} onChange={e=>{setTheme(e.target.value);choose(e.target.value);}}>{themeOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><button className="text-button" onClick={()=>choose()}><RefreshCw size={16}/>Another position</button></div>
        {active?<div className="practice-layout">
          <div className="board-column"><div className="board-top"><span className={`turn-dot ${new Chess(active.fen).turn()}`}/><strong>{new Chess(active.fen).turn()==='w'?'White':'Black'} to move</strong><span>{active.themes.includes('personal')?'From your game':isEndgameDrill(active)?`${drillGoal(active)} · Estimated difficulty ${active.rating}`:`Puzzle difficulty ${active.rating}`}</span></div><Chessboard key={active.id} fen={fen} orientation={new Chess(active.fen).turn()} onMove={play} onIllegal={()=>{if(!complete)setFeedback('That move is not legal in this position.');}}disabled={complete} lastMove={lastMove} hintSquare={hints>=2&&!complete?active.moves[index]?.slice(0,2):undefined}/><div className="board-caption"><span>Click a piece, then its destination.</span><span>{detail?`From your ${detail.timeClass} game, ${detail.date}`:active.themes.includes('personal')?(active.title?`${active.title} · saved engine candidate`:'Saved engine candidate'):isEndgameDrill(active)?'Tablebase-verified drill':`Lichess ${active.id}`}</span></div></div>
          <aside className="coach-panel"><div className="coach-heading"><GraduationCap size={24}/><h2>{complete?'Take the idea with you':'Find the continuation'}</h2></div><p className="lead">{complete?'One position, one pattern. What made this work?':isEndgameDrill(active)?`${drillGoal(active)}. The replies are fixed; find the move that keeps that result.`:'Before moving, ask what changed and what your opponent is threatening.'}</p>
            <div className="thinking-steps"><p><span>1</span>Look for checks, captures, and threats.</p><p><span>2</span>Test your candidate against their best reply.</p><p><span>3</span>Check what you leave unprotected.</p></div>
            <div className={`feedback ${complete?'success':''}`} aria-live="polite">{feedback||'The answer stays hidden until you play or ask for help.'}</div>
            {hints>0&&!complete&&<div className="hint-box"><Lightbulb size={18}/><p>{hints===1?(isEndgameDrill(active)?'Start with the kings: which squares must yours reach or guard? Check that your move does not leave the opponent without a legal move.':'Look at forcing moves and loose pieces. Which move changes what the opponent can safely do?'):`Look closely at the piece on ${active.moves[index]?.slice(0,2)}.`}</p></div>}
            {complete?<><div className="theme-tags">{trainingThemes(active.themes).map(t=><span key={t}>{pretty(t)}</span>)}</div><div className="solution"><strong>{active.themes.includes('personal')?'Engine candidate':revealed?'Solution line':'Recorded continuation'}</strong><p>{sanLine(active)}</p></div>{detail&&<div className="pack-lines">{detail.pvUci.length>1&&<p><strong>Engine line: </strong>{sanMoves(active.fen,detail.pvUci).join('  ')}</p>}{detail.refutationPvUci&&<p><strong>Engine line after your {detail.playedSan}: </strong>{sanMoves(fenAfter(active.fen,detail.playedUci)??active.fen,detail.refutationPvUci).join('  ')}</p>}<p className="small">{`${detail.timeClass==='rapid'?'Rapid':'Blitz'} · ${detail.date} · move ${detail.moveNumber}${detail.moveSeconds!=null?` · ${Math.round(detail.moveSeconds)} s on this move`:''}${detail.clockBefore!=null?` · ${clock(detail.clockBefore)} on your clock`:''}${detail.occurrences.length>1?` · you reached this position in ${detail.occurrences.length} games`:''}`}</p>{active.gameUrl&&<a href={active.gameUrl} target="_blank" rel="noreferrer">Open the game on Chess.com</a>}</div>}{active.explanation&&<p className="small">{active.explanation}</p>}<button className="primary wide" onClick={()=>choose()}>{sessionDone>=state.progress.settings.sessionLength?'Keep practising':'Next position'}<ArrowRight size={18}/></button><button className="text-button" onClick={()=>startPuzzle(active,true)}><RotateCcw size={16}/>Rehearse this line again</button></>:<div className="coach-actions"><button className="secondary" onClick={()=>setHints(n=>n+1)}><Lightbulb size={17}/>{hints?'Another hint':'Show a hint'}</button><button className="text-button" onClick={reveal}>{active.themes.includes('personal')?'Show engine candidate':'Reveal solution'}</button></div>}
            <div className="coach-footnote">{detail?'From an offline engine pass over your games, not a live analysis of this position.':active.themes.includes('personal')?'A short engine scan supplies a candidate, not proof that every alternative is worse.':isEndgameDrill(active)?'Difficulty is an estimate, not a measured rating. The replies are fixed, tablebase-checked moves; they do not adapt to your play.':'Puzzle difficulty is from Lichess. It is not your Chess.com playing rating.'}</div>
          </aside>
        </div>:<div className="empty-state"><Target size={35}/><h2>{theme==='personal'?'Start with one of your games':'Nothing due right now'}</h2><p>{feedback}</p><button className="primary" onClick={()=>theme==='personal'?setTab('games'):(setTheme('all'),choose('all'))}>{theme==='personal'?'Import a game':'Mixed practice'}</button></div>}
        <div className="practice-footer"><div><strong>{BANK.length.toLocaleString()} positions</strong><span>Tactics, defence, and endgames</span></div><div><strong>{due} due for review</strong><span>Missed or supported answers return sooner</span></div><div><strong>{pools.own.length} personal positions</strong><span>Learn from games you have completed</span></div></div>
        {sessionDone>=state.progress.settings.sessionLength&&<div className="notice success"><Check size={20}/><span>Session target reached. You can keep practising or look at your progress.</span><button onClick={()=>setTab('progress')}>View progress</button></div>}
      </section>}
      {tab==='games'&&<section className="page"><div className="page-heading"><div><h1>Learn from your games</h1><p>Bring a completed game. Turn its turning points into practice.</p></div></div>{pack&&<PersonalPackSummary pack={pack} onPractise={()=>{setTab('practice');setTheme('personal');choose('personal');}}/>}<div className="import-grid"><div className="surface"><h2>Import from Chess.com</h2><p className="small">Fetch up to 10 recent public standard chess games. No password needed.</p><label htmlFor="username">Chess.com username</label><div className="input-row"><input id="username" placeholder="Your username" value={username} onChange={e=>setUsername(e.target.value)}/><button className="primary" disabled={fetching||analyzing} onClick={fetchGames}>{fetching?'Fetching…':'Fetch games'}</button></div><p className="fine-print">Independent tool; not affiliated with Chess.com. If the archive is unavailable, use a PGN export.</p></div><div className="surface"><h2>Paste or upload PGN</h2><label className="sr-only" htmlFor="pgn">Completed-game PGN</label><textarea id="pgn" rows={4} placeholder={'[Event "My completed game"]\n1. e4 e5 2. Nf3 Nc6 …'} value={pgnText} onChange={e=>setPgnText(e.target.value)}/><div className="button-row"><button className="primary" disabled={analyzing||!pgnText.trim()} onClick={()=>importPgn(pgnText)}>Read PGN</button><label className={`button secondary ${analyzing?'disabled':''}`}><Upload size={16}/>Upload PGN<input className="sr-only" type="file" accept=".pgn,.txt" disabled={analyzing} onChange={async e=>{const f=e.target.files?.[0];if(f){if(f.size>2_000_000){setError('PGN exceeds 2 MB.');return;}const text=await f.text();setPgnText(text);importPgn(text);}e.target.value='';}}/></label><button className="text-button" disabled={analyzing} onClick={()=>{setPgnText(DEMO);importPgn(DEMO);}}>Try an example</button></div><p className="fine-print">Up to 20 games per import, 2 MB. Analysis runs in your browser while this page is open.</p></div></div>
        {gameMessage&&<div className="notice" role="status">{gameMessage}</div>}
        {state.games.length>0&&<div className="games-workspace"><aside className="game-list"><h2>Saved games <small>{state.games.length}</small></h2>{[...state.games].reverse().map(g=><button key={g.id} disabled={analyzing} className={`game-row ${g.id===selectedGame?'selected-game':''}`} onClick={()=>{setSelectedGame(g.id);setReplayPly(0);setAnalysis(null);setColor(g.userColor??'');}}><strong>{g.headers.White??'White'} <span>vs</span> {g.headers.Black??'Black'}</strong><small>{g.headers.Date??'Imported'} · {g.result}</small></button>)}</aside><div className="game-detail">{game?<><div className="analysis-bar"><label htmlFor="color">I played</label><select id="color" value={color} disabled={analyzing} onChange={e=>{const side=e.target.value as 'w'|'b';setColor(side);setAnalysis(null);update(old=>({...old,games:old.games.map(g=>g.id===game.id?{...g,userColor:side}:g)}));}}><option value="" disabled>Choose side</option><option value="w">White</option><option value="b">Black</option></select><button className="primary" disabled={analyzing||!color} onClick={runAnalysis}>{analyzing?'Analysing…':'Analyse my moves'}</button>{analyzing&&<button className="secondary" onClick={()=>abort.current?.abort()}>Stop analysis</button>}</div>{analyzing&&<div className="analysis-progress"><progress value={analysisProgress.completed} max={analysisProgress.total||1}/><span>{analysisProgress.completed} / {analysisProgress.total} moves</span></div>}
            <div className="replay-grid"><div><Chessboard fen={replayPly?game.moves[replayPly-1].after:game.moves[0].before} orientation={color||'w'} lastMove={replayPly?game.moves[replayPly-1].uci:undefined}/><div className="replay-controls"><button className="secondary" onClick={()=>setReplayPly(Math.max(0,replayPly-1))} disabled={replayPly===0}>Previous</button><span>{replayPly===0?'Starting position':`${Math.ceil(replayPly/2)}${game.moves[replayPly-1].color==='w'?'.':'…'} ${game.moves[replayPly-1].san}`}</span><button className="secondary" onClick={()=>setReplayPly(Math.min(game.moves.length,replayPly+1))} disabled={replayPly===game.moves.length}>Next</button></div></div><div><h3>{analysis?'Practice candidates':'A useful second look'}</h3><p className="small">The engine looks for moves that lost ground. A quick scan is an estimate, not an exhaustive verdict. Up to eight candidates become personal exercises.</p>{analysis&&<><p className="fine-print">{analysis.engine}. {analysis.analyzedMoves}/{analysis.totalMoves} moves checked{analysis.partial?' — partial scan':''}. Threshold: 0.8 pawns of estimated loss; this is a heuristic.</p>{analysis.mistakes.length===0?<div className="notice">No candidates met the threshold in the moves checked. This does not mean the game was error-free.</div>:analysis.mistakes.map(m=><div className="mistake" key={m.id}><button className="mistake-position" onClick={()=>setReplayPly(m.ply-1)}><strong>Move {Math.ceil(m.ply/2)}: {m.playedSan}</strong><span>{m.before.mate!==null||m.after.mate!==null?'Mate sequence changed':`Estimated loss ${(m.lossCp/100).toFixed(1)} pawns`} · depth {m.depth}</span></button><button className="text-button" onClick={()=>{const p=personalFrom(m,game,state.progress.settings.rating);update(old=>({...old,personalPuzzles:[...new Map([...old.personalPuzzles,p].map(x=>[x.id,x])).values()]}));setTab('practice');setTheme('personal');startPuzzle(p);}}>Practise position<ChevronRight size={16}/></button></div>)}</>}</div></div></>:<div className="empty-state">Choose a saved game.</div>}</div></div>}
      </section>}
      {tab==='learn'&&<Learn onTheme={t=>{setTab('practice');setTheme(t);choose(t);}} showSources={showSources} onSourcesShown={()=>setShowSources(false)}/>}
      {tab==='progress'&&<section className="page"><div className="page-heading"><div><h1>Your practice, in focus</h1><p>These numbers describe practice. They do not estimate your playing Elo.</p></div><button className="secondary" onClick={()=>download('next-move-backup.json',exportState(state))}><Download size={17}/>Export backup</button></div><div className="stats-row"><div><strong>{attempts.length}</strong><span>Completed attempts</span></div><div><strong>{attempts.length?`${Math.round(clean/attempts.length*100)}%`:'—'}</strong><span>Solved without help or errors</span></div><div><strong>{due}</strong><span>Reviews due</span></div><div><strong>{state.games.length}</strong><span>Games imported</span></div></div>
        <div className="progress-layout"><div className="surface"><h2>Themes practised</h2>{!practiced.length?<p>Complete a few positions to start seeing your practice history here. New themes remain in the mix.</p>:<div className="skill-list">{practiced.map(s=><div key={s.theme} className="skill-row"><div><strong>{pretty(s.theme)}</strong><small>{s.attempts} attempt{s.attempts===1?'':'s'} · {s.label}</small></div><div className="skill-meter" style={s.attempts<5?{visibility:'hidden'}:undefined}><div style={{width:`${(s.accuracy??0)*100}%`}}/></div><span>{s.attempts<5?'—':`${Math.round((s.accuracy??0)*100)}%`}</span></div>)}</div>}<p className="fine-print">A miss, reveal, or hint counts as supported practice. Repeating a known position can improve recall without proving transfer to real games.</p></div><aside className="surface"><h2>Shape your sessions</h2><label htmlFor="difficulty">Starting puzzle difficulty</label><select id="difficulty" value={state.progress.settings.rating} onChange={e=>update(old=>({...old,progress:{...old.progress,settings:{...old.progress.settings,rating:Number(e.target.value)},settingsUpdatedAt:Date.now()}}))}>{[600,800,1000,1200,1400,1600,1800].map(n=><option key={n}>{n}</option>)}</select><p className="fine-print">Use Lichess puzzle difficulty as a starting point. It is not mapped to Chess.com Elo.</p><label htmlFor="length">Positions per session</label><select id="length" value={state.progress.settings.sessionLength} onChange={e=>update(old=>({...old,progress:{...old.progress,settings:{...old.progress.settings,sessionLength:Number(e.target.value)},settingsUpdatedAt:Date.now()}}))}>{[5,10,15,20].map(n=><option key={n}>{n}</option>)}</select><details><summary>How the practice mix works</summary><p className="small">Due reviews come first, with new material regularly mixed in. Themes with more supported answers get higher priority near your chosen difficulty. One in four selections uses your own positions when available.</p><p className="small">Clean recalls return after 1, 3, 7, 14, 30, then 60 days. Supported answers return after 10 minutes. These intervals and weights are product heuristics, not a validated prescription.</p></details><hr/><h3>Keep your progress</h3><p className="small">{userId?'Signed-in progress syncs to this private site. Keep an exported backup too.':'This preview saves in this browser. Sign in to enable the site’s account storage; export before switching browsers.'}</p>{!userId?<a className="button secondary" href="/signin-with-chatgpt?return_to=/" target="_top">Sign in for sync</a>:<button className="secondary" onClick={()=>void sync()}>Retry sync</button>}<label className="button secondary"><Upload size={16}/>Merge a backup<input className="sr-only" type="file" accept=".json" onChange={async e=>{try{const f=e.target.files?.[0];if(f){const restored=parseState(await f.text());update(old=>mergeStates(restored,old));setError('');}}catch(err){setError(err instanceof Error?err.message:'Could not read backup.');}e.target.value='';}}/></label></aside></div>
      </section>}
      </>}
      <footer className="site-footer"><span>Next Move · Completed-game study and deliberate practice.</span><button onClick={()=>{setTab('learn');setShowSources(true);}}>Sources & approach</button><a href="/engine/README.txt" target="_blank" rel="noreferrer">Engine license</a></footer>
    </main>
  </div>;
}

function Learn({onTheme,showSources=false,onSourcesShown}:{onTheme:(t:string)=>void;showSources?:boolean;onSourcesShown?:()=>void}){
  const [category,setCategory]=useState('All'),[drillId,setDrillId]=useState(openingDrills[0]?.id??'');
  const sourcesPanel=useRef<HTMLDetailsElement>(null);
  // The footer link opens the evidence panel and brings it into view.
  useEffect(()=>{if(!showSources||!sourcesPanel.current)return;sourcesPanel.current.open=true;sourcesPanel.current.scrollIntoView({block:'start'});onSourcesShown?.();},[showSources,onSourcesShown]);
  const categories=['All',...new Set(principles.map(p=>p.category))];
  return <section className="page"><div className="page-heading"><div><h1>Ideas you can use</h1><p>Short principles, practical exceptions, and opening plans to rehearse.</p></div></div><div className="learn-banner"><BookOpen size={29}/><div><h2>Understand the position before remembering the move.</h2><p>These are prompts for thought. Concrete threats and calculation can override a rule of thumb.</p></div></div><div className="learn-section-heading"><h2>Opening rehearsal</h2><p>Learn the point of a short line, then return to the whole board.</p></div><label className="sr-only" htmlFor="opening">Choose opening</label><select id="opening" className="opening-select" value={drillId} onChange={e=>setDrillId(e.target.value)}>{openingDrills.map(d=><option key={d.id} value={d.id}>{d.name} — {d.side==='w'?'White':'Black'}</option>)}</select>{openingDrills.find(d=>d.id===drillId)&&<OpeningLab key={drillId} drill={openingDrills.find(d=>d.id===drillId)!}/>}
    <div className="learn-section-heading"><h2>Practical rules of thumb</h2><p>Keep one idea in mind for your next session.</p></div><div className="category-tabs" role="group" aria-label="Lesson categories">{categories.map(c=><button className={c===category?'selected':''} key={c} onClick={()=>setCategory(c)}>{c}</button>)}</div><div className="principle-grid">{principles.filter(p=>category==='All'||p.category===category).map(p=><article key={p.id} className="principle"><span className="lesson-category">{p.category}</span><h3>{p.title}</h3><p>{p.body}</p><blockquote>{p.cue}</blockquote><details><summary>Source & context</summary><div className="source-links">{sourceLinks(p.sourceIds)}</div></details></article>)}</div>
    <div className="learn-actions"><button className="secondary" onClick={()=>onTheme('defensiveMove')}>Practise defensive resources</button><button className="secondary" onClick={()=>onTheme('endgame')}>Practise endgames</button></div><details ref={sourcesPanel} id="sources" className="surface sources-panel"><summary>Evidence, puzzle data, and limitations</summary><p>Training design combines chess teaching sources with retrieval and distributed-practice research. That supports the broad approach; it does not validate this app’s precise schedule, theme weights, or Elo outcomes. Opening lines are illustrative branches, not a complete repertoire.</p><p>Puzzles: <a href={PUZZLE_SOURCE.url} target="_blank" rel="noreferrer">{PUZZLE_SOURCE.name}</a>, {PUZZLE_SOURCE.license}. This is a bounded, theme-balanced sample, not an unbiased rating study. No book exercises have been copied. Puzzle difficulty is from Lichess. It is not your Chess.com playing rating.</p><p>Endgame technique: {endgameDrills.length} short drills (half to win, half to hold the draw) composed for this app and checked against the Lichess Syzygy tablebase. Their difficulty values are estimates. Each drill follows one line. In some positions another move also keeps the result; the drill still asks for its own move, and that attempt counts as supported practice.</p><p>Engine: Stockfish 19 lite, single-threaded, running locally in a browser worker. <a href="/engine/README.txt" target="_blank" rel="noreferrer">License and corresponding source</a>. Feedback is based on source lines and short engine searches; it is not a paid generative-AI service.</p><ol>{sources.map(s=><li key={s.id}><a href={s.url} target="_blank" rel="noreferrer">{s.author}: {s.title}</a><p className="small">{s.note}</p></li>)}</ol></details>
  </section>;
}
function OpeningLab({drill}:{drill:typeof openingDrills[number]}){
  function beginning(){const b=new Chess();let cursor=0;if(drill.side==='b'&&drill.moves.length){b.move(drill.moves[0]);cursor=1;}return {fen:b.fen(),cursor};}
  const [position,setPosition]=useState(beginning),[message,setMessage]=useState('Play your move in this rehearsal line.'),[show,setShow]=useState(false);
  const done=position.cursor>=drill.moves.length;
  function play(uci:string){const b=new Chess(position.fen),played=move(b,uci);if(played.san!==drill.moves[position.cursor]){setMessage('That is a legal alternative, outside this rehearsal line. This is not a blunder judgment. Try the line or reveal it.');return;}let cursor=position.cursor+1,reply='';if(cursor<drill.moves.length){reply=b.move(drill.moves[cursor]).san;cursor++;}setPosition({fen:b.fen(),cursor});setMessage(cursor>=drill.moves.length?'Line complete. Say the plan in your own words before repeating.':`Your opponent plays ${reply}. Continue your plan.`);}
  return <div className="opening-lab"><Chessboard fen={position.fen} orientation={drill.side} onMove={play} disabled={done}/><div><h3>{drill.name}</h3><p className="small">You are {drill.side==='w'?'White':'Black'}. This line teaches a plan; other sensible moves exist.</p><div className="feedback" aria-live="polite">{message}</div><ul>{drill.notes.map((n,i)=><li key={i}>{n}</li>)}</ul><div className="button-row"><button className="secondary" onClick={()=>{setPosition(beginning());setShow(false);setMessage('Play your move in this rehearsal line.');}}><RotateCcw size={16}/>Restart line</button><button className="text-button" onClick={()=>setShow(!show)}>{show?'Hide line':'Reveal line'}</button></div>{show&&<p className="notation">{drill.moves.map((m,i)=>`${i%2===0?`${Math.floor(i/2)+1}. `:''}${m}`).join(' ')}</p>}<details><summary>Sources for the plan</summary><div className="source-links">{sourceLinks(drill.sourceIds)}</div></details></div></div>;
}
