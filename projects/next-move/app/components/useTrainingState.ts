'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { newState, parseState, mergeStates, assertStateLimits, type TrainingState } from '@/lib/training-state';

type RemoteState={revision:number;state:unknown};
const memoryWarning='This session is only in memory. Export a backup before closing the page.';

export function useTrainingState(userId:string|null){
  const [state,setState]=useState<TrainingState>(newState);
  const [ready,setReady]=useState(false);
  const [status,setStatus]=useState('Loading progress…');
  const [error,setError]=useState('');
  const canPersist=useRef(true),localSaved=useRef(false);
  const current=useRef(state),revision=useRef(0),loaded=useRef(false),saving=useRef(false),pending=useRef(false);
  const storageKey=`next-move-v1:${userId??'local'}`;

  const persist=useCallback((next:TrainingState)=>{
    if(!canPersist.current){localSaved.current=false;setStatus('Unsaved — export a backup');return false;}
    try{localStorage.setItem(storageKey,JSON.stringify(next));localSaved.current=true;return true;}
    catch{localSaved.current=false;setStatus('Unsaved — export a backup');setError(`Browser storage is full or unavailable. ${memoryWarning}`);return false;}
  },[storageKey]);

  useEffect(()=>{
    let canceled=false;
    async function load(){
      let local=newState(),hadLocal=false;
      try{
        const existing=localStorage.getItem(storageKey);
        // On first sign-in, carry this browser's guest practice into the account.
        // Keep the guest copy intact as a recovery source.
        const raw=existing??(userId?localStorage.getItem('next-move-v1:local'):null);
        hadLocal=!!raw;
        if(raw){
          try{local=parseState(raw);localSaved.current=true;}
          catch{
            try{localStorage.setItem(`${storageKey}.corrupt.${Date.now()}`,raw);}
            catch{canPersist.current=false;}
            setError('Unreadable browser progress was preserved. Do not clear browser storage before recovering the original.');
          }
        }
      }catch{canPersist.current=false;setError(`Browser storage is unavailable. ${memoryWarning}`);}
      if(canceled)return;
      current.current=local;setState(local);
      if(userId){
        try{
          const response=await fetch('/api/state');if(!response.ok)throw new Error('Cloud sync unavailable.');
          const remote=await response.json() as RemoteState;
          const merged=remote.state?(hadLocal?mergeStates(parseState(JSON.stringify(remote.state)),local):parseState(JSON.stringify(remote.state))):local;
          local=merged;revision.current=remote.revision;
          persist(local);setStatus('Syncing account progress…');
        }catch(cause){
          setStatus(localSaved.current?'Saved in this browser':'Unsaved — export a backup');
          setError(cause instanceof Error&&cause.message.includes('too large')?cause.message:localSaved.current?'Cloud sync is unavailable. The existing browser copy is preserved.':`Cloud sync is unavailable. ${memoryWarning}`);
        }
      }else setStatus(canPersist.current?'Saved in this browser':'Unsaved — export a backup');
      if(!canceled){current.current=local;setState(local);loaded.current=true;setReady(true);}
    }
    void load();return()=>{canceled=true;};
  },[userId,storageKey,persist]);

  const sync=useCallback(async()=>{
    if(!userId||!loaded.current||saving.current)return;
    saving.current=true;setStatus('Saving…');
    try{
      for(let retry=0;retry<4;retry++){
        pending.current=false;
        const response=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:current.current,revision:revision.current})});
        if(response.status===409){
          const get=await fetch('/api/state');if(!get.ok)throw new Error('Cloud sync unavailable.');
          const remote=await get.json() as RemoteState;
          // Complete a valid merge before changing either the revision or local copy.
          const merged=mergeStates(parseState(JSON.stringify(remote.state)),current.current);
          revision.current=remote.revision;current.current=merged;setState(merged);persist(merged);pending.current=true;continue;
        }
        if(!response.ok)throw new Error('Cloud save failed.');
        revision.current=(await response.json() as {revision:number}).revision;
        if(!pending.current){setStatus('Saved across devices');if(localSaved.current)setError('');return;}
      }
      setStatus(localSaved.current?'Saved in this browser':'Unsaved — export a backup');
      setError(`Sync is still changing on another device. Retry sync. ${localSaved.current?'The browser copy is preserved.':memoryWarning}`);
    }catch(cause){
      setStatus(localSaved.current?'Saved in this browser':'Unsaved — export a backup');
      setError(cause instanceof Error&&cause.message.includes('too large')?cause.message:localSaved.current?'Cloud sync failed. Your browser copy is preserved. Retry sync or export a backup.':`Cloud sync failed. ${memoryWarning}`);
    }finally{saving.current=false;}
  },[userId,persist]);

  const update=useCallback((next:TrainingState|((old:TrainingState)=>TrainingState))=>{
    let value:TrainingState;
    try{value=typeof next==='function'?next(current.current):next;assertStateLimits(value);}
    catch(cause){setError(cause instanceof Error?cause.message:'This change could not be saved. Export a backup.');return false;}
    current.current=value;setState(value);persist(value);pending.current=true;void sync();return true;
  },[persist,sync]);
  useEffect(()=>{if(ready&&userId)void sync();},[ready,userId,sync]);
  return {state,update,ready,status,error,setError,sync};
}
