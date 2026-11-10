import test from 'node:test';
import assert from 'node:assert/strict';
import {newState,mergeStates,readState,parseState} from '../lib/training-state';
import {recordAttempt} from '../lib/scheduler.js';
import {parsePgn} from '../lib/pgn';

const puzzle={id:'example',fen:'4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',moves:['e2e4'],rating:1000,themes:['endgame'],gameUrl:''};
test('concurrent device histories merge without dropping or double-counting attempts',()=>{
  const a=newState(),b=newState();
  a.progress=recordAttempt(a.progress,puzzle,{correct:true,now:1000});
  b.progress=recordAttempt(b.progress,puzzle,{correct:false,hints:1,now:2000});
  const merged=mergeStates(a,b);
  assert.equal(merged.progress.attempts.length,2);
  assert.equal(merged.progress.cards.example.successes,1);
  assert.equal(merged.progress.cards.example.streak,0);
  assert.equal(merged.progress.cards.example.due,602000);
  assert.deepEqual(mergeStates(merged,a).progress.attempts,merged.progress.attempts);
});
test('backup replay rebuilds cached statistics from actual attempts',()=>{
  const state=newState();state.progress=recordAttempt(state.progress,puzzle,{correct:true,now:10});
  state.progress.cards.example.successes=500;
  assert.equal(readState(state).progress.cards.example.successes,1);
});
test('backup rejects malformed, illegal and duplicate records',()=>{
  assert.throws(()=>parseState('{"__proto__":{}}'));
  const state=newState();state.personalPuzzles=[{...puzzle,moves:['e2e6']}];assert.throws(()=>readState(state));
  state.personalPuzzles=[puzzle,puzzle];assert.throws(()=>readState(state),/duplicate/);
  assert.throws(()=>readState({...newState(),version:2}));
});
test('saved game metadata and moves must match completed PGN',()=>{
  const state=newState();state.games=[{...parsePgn('1.e4 e5 2.Nf3 Nc6 1/2-1/2')[0],importedAt:1}];
  assert.equal(readState(state).games.length,1);
  state.games[0].headers.White='Injected name';assert.throws(()=>readState(state),/match/);
});
test('empty remote histories do not lose local exercises or settings',()=>{
  const state=newState();state.personalPuzzles=[puzzle];state.progress.settings.rating=1400;state.progress.settingsUpdatedAt=10;
  const merged=mergeStates(newState(),state);assert.equal(merged.personalPuzzles.length,1);assert.equal(merged.progress.settings.rating,1400);
  assert.deepEqual(parseState(JSON.stringify(merged)),merged);
});

test('newer settings survive startup on an older device',()=>{
  const remote=newState(),local=newState();remote.progress.settings.rating=1600;remote.progress.settingsUpdatedAt=200;
  local.progress.settings.rating=800;local.progress.settingsUpdatedAt=100;
  assert.equal(mergeStates(remote,local).progress.settings.rating,1600);
  assert.equal(mergeStates(local,remote).progress.settings.rating,1600);
});
test('over-limit conflict merge fails before either valid copy can be overwritten',()=>{
  const remote=newState(),local=newState();
  remote.personalPuzzles=Array.from({length:1000},(_,i)=>({...puzzle,id:`p${i}`}));
  local.personalPuzzles=[...remote.personalPuzzles.slice(0,999),{...puzzle,id:'different'}];
  assert.throws(()=>mergeStates(remote,local),/too large/);
  assert.equal(remote.personalPuzzles.length,1000);assert.equal(local.personalPuzzles.length,1000);
});
