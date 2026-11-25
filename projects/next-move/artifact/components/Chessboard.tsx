'use client';
import { useId, useRef, useState } from 'react';
import { Chess, type Square } from 'chess.js';
import { canDragFrom, isDrag, resolveDrop, squareAt, swallowClick } from './dragMove';
const glyphs:Record<string,string>={k:'♚',q:'♛',r:'♜',b:'♝',n:'♞'};
/** The pawn is a drawn shape, not a font character: phones draw the pawn character as a colour emoji, which ignores the white and black fills, so both sides' pawns looked the same. One closed outline in the piece's 100-unit box. */
export const PAWN_PATH='M50 22A12 12 0 0 1 57.9 43L61.5 44a2.5 2.5 0 0 1 0 5L56.5 49C55.5 58 67 62 69 72L71 72a4 4 0 0 1 4 4V80H25V76a4 4 0 0 1 4-4L31 72C33 62 44.5 58 43.5 49L38.5 49a2.5 2.5 0 0 1 0-5L42.1 43A12 12 0 0 1 50 22Z';
/** The inside of a piece's <svg>, shared by a square and the drag ghost so the two cannot differ. */
const pieceArt=(type:string)=>type==='p'?<path d={PAWN_PATH}/>:<text x="50" y="80" textAnchor="middle" fontSize="86" fontFamily="Arial Unicode MS, DejaVu Sans, serif">{glyphs[type]}</text>;
const names:Record<string,string>={k:'king',q:'queen',r:'rook',b:'bishop',n:'knight',p:'pawn'};
/** a1 is dark and h1 light, as on a real board: a light square on each player's right (QA P1-1). */
export const isDarkSquare=(square:string)=>(square.charCodeAt(0)-97+Number(square[1]))%2===1;
/** Centre of a square in board units (0-8), as seen from `orientation`. */
export function squareCentre(square:string,orientation:'w'|'b'){const col=orientation==='w'?square.charCodeAt(0)-97:104-square.charCodeAt(0);const row=orientation==='w'?8-Number(square[1]):Number(square[1])-1;return{x:col+.5,y:row+.5};}
/** The id of a board's arrowhead marker: React's useId, cut to letters, digits, "_" and "-" so it is a plain fragment in `url(#…)`.
 *  One id per board, so two boards with arrows on one page never share a marker (M3 F3; A5's request). */
export const arrowHeadId=(reactId:string)=>`board-arrow-head${reactId.replace(/[^A-Za-z0-9_-]/g,'')}`;
export default function Chessboard({fen,orientation='w',onMove,onIllegal,disabled=false,lastMove,hintSquare,arrow}:{fen:string;orientation?:'w'|'b';onMove?:(uci:string)=>void;onIllegal?:(uci:string)=>void;disabled?:boolean;lastMove?:string;hintSquare?:string;/** M2 ("Safe or not?"): a move drawn as an arrow, UCI. */arrow?:string}){
  const headId=arrowHeadId(useId());
  const [selected,setSelected]=useState<Square|null>(null);
  const [promotion,setPromotion]=useState<{from:Square,to:Square}|null>(null);
  // D11 drag: a press on his own piece becomes a drag after 6 px; tap-tap is unchanged (a press that never travels is a click).
  const boardRef=useRef<HTMLDivElement|null>(null);
  const press=useRef<{id:number,from:Square,x:number,y:number,dragging:boolean}|null>(null);
  const dragEndedAt=useRef<number|null>(null);
  const [drag,setDrag]=useState<{from:Square,x:number,y:number}|null>(null);
  const local=(e:{clientX:number,clientY:number})=>{const r=boardRef.current?.getBoundingClientRect();return r?{x:e.clientX-r.left,y:e.clientY-r.top,size:r.width}:null;};
  function pointerDown(e:React.PointerEvent<HTMLDivElement>){
    dragEndedAt.current=null;
    if(disabled||!onMove||promotion||(e.pointerType==='mouse'&&e.button!==0))return;
    const at=local(e);if(!at)return;
    const from=squareAt(at.x,at.y,at.size,orientation);
    if(!from||!canDragFrom(fen,from))return;
    press.current={id:e.pointerId,from,x:at.x,y:at.y,dragging:false};
  }
  function pointerMove(e:React.PointerEvent<HTMLDivElement>){
    const p=press.current;if(!p||p.id!==e.pointerId)return;
    const at=local(e);if(!at)return;
    if(!p.dragging){if(!isDrag(at.x-p.x,at.y-p.y))return;p.dragging=true;setSelected(p.from);try{boardRef.current?.setPointerCapture(e.pointerId);}catch{/* capture is optional */}}
    setDrag({from:p.from,x:at.x,y:at.y});
  }
  function pointerUp(e:React.PointerEvent<HTMLDivElement>){
    const p=press.current;if(!p||p.id!==e.pointerId)return;
    press.current=null;
    if(!p.dragging)return; // a tap: the square's click handler runs as before
    dragEndedAt.current=Date.now();setDrag(null);
    const at=local(e);
    const result=resolveDrop(fen,p.from,at?squareAt(at.x,at.y,at.size,orientation):null);
    if(result.kind==='move'){setSelected(null);onMove?.(result.uci);}
    else if(result.kind==='promote'){setPromotion({from:result.from,to:result.to});}
    else setSelected(null);
  }
  function pointerCancel(){press.current=null;setDrag(null);}
  const board=new Chess(fen);
  const files=orientation==='w'?'abcdefgh':'hgfedcba';
  const ranks=orientation==='w'?'87654321':'12345678';
  const targets=selected?board.moves({square:selected,verbose:true}).map(m=>m.to):[];
  function click(square:Square,detail=0){
    const echo=swallowClick(dragEndedAt.current,Date.now(),detail);dragEndedAt.current=null;
    if(echo)return;
    if(disabled||!onMove) return;
    if(selected&&targets.includes(square)){
      const choices=board.moves({square:selected,verbose:true}).filter(m=>m.to===square);
      if(choices.some(m=>m.promotion)){setPromotion({from:selected,to:square});return;}
      onMove(selected+square);setSelected(null);return;
    }
    const piece=board.get(square);
    const own=!!piece&&piece.color===board.turn();
    // A selected piece sent to a square it cannot reach: tell the learner instead of silently deselecting.
    if(selected&&square!==selected&&!own)onIllegal?.(selected+square);
    setSelected(own?square:null);
  }
  return <div className="board-wrap">
    <div ref={boardRef} className={`chessboard${!disabled&&onMove?' interactive':''}${drag?' dragging':''}`} role="group" aria-label={`${board.turn()==='w'?'White':'Black'} to move chessboard`}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={()=>{if(press.current?.dragging)pointerCancel();}}>
      {[...ranks].flatMap((rank,row)=>[...files].map((file,col)=>{
        const square=(file+rank) as Square,piece=board.get(square);
        const dark=isDarkSquare(square);
        const last=lastMove&&(lastMove.slice(0,2)===square||lastMove.slice(2,4)===square);
        return <button key={square} type="button" data-square={square} className={`square ${dark?'dark':'light'} ${selected===square?'selected':''} ${last?'last':''} ${hintSquare===square?'hint-square':''}`} onClick={e=>click(square,e.detail)} aria-label={`${square}${piece?` ${piece.color==='w'?'white':'black'} ${names[piece.type]}`:' empty'}`} aria-pressed={selected===square} disabled={disabled||!onMove}>
          {col===0&&<span className="rank">{rank}</span>}{row===7&&<span className="file">{file}</span>}
          {piece&&<svg viewBox="0 0 100 100" className={`piece ${piece.color}${drag?.from===square?' drag-origin':''}`} aria-hidden="true">{pieceArt(piece.type)}</svg>}
          {targets.includes(square)&&<span className={piece?'capture-target':'move-target'}/>}
        </button>;
      }))}
      {drag&&(()=>{const p=board.get(drag.from);return p?<svg className={`piece ${p.color} drag-ghost`} viewBox="0 0 100 100" aria-hidden="true" style={{left:`${drag.x}px`,top:`${drag.y}px`}}>{pieceArt(p.type)}</svg>:null;})()}
      {arrow&&/^[a-h][1-8][a-h][1-8]/.test(arrow)&&(()=>{const a=squareCentre(arrow.slice(0,2),orientation),b=squareCentre(arrow.slice(2,4),orientation);const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1;const ex=b.x-dx/len*.32,ey=b.y-dy/len*.32;
        return <svg className="board-arrow" viewBox="0 0 8 8" aria-hidden="true"><defs><marker id={headId} viewBox="0 0 4 4" refX="1.2" refY="2" markerWidth="3.2" markerHeight="3.2" orient="auto"><path d="M0,0 L4,2 L0,4 z"/></marker></defs><line x1={a.x} y1={a.y} x2={ex} y2={ey} markerEnd={`url(#${headId})`}/></svg>;})()}
    </div>
    {promotion&&<div className="promotion-dialog" role="dialog" aria-label="Choose promotion piece"><p>Promote to</p>{['q','r','b','n'].map(p=><button key={p} onClick={()=>{onMove?.(promotion.from+promotion.to+p);setPromotion(null);setSelected(null);}}>{names[p]}</button>)}<button onClick={()=>setPromotion(null)}>Cancel</button></div>}
  </div>;
}
