'use client';
import { useState } from 'react';
import { Chess, type Square } from 'chess.js';
const glyphs:Record<string,string>={k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'};
const names:Record<string,string>={k:'king',q:'queen',r:'rook',b:'bishop',n:'knight',p:'pawn'};
/** a1 is dark and h1 light, as on a real board: a light square on each player's right (QA P1-1). */
export const isDarkSquare=(square:string)=>(square.charCodeAt(0)-97+Number(square[1]))%2===1;
export default function Chessboard({fen,orientation='w',onMove,onIllegal,disabled=false,lastMove,hintSquare}:{fen:string;orientation?:'w'|'b';onMove?:(uci:string)=>void;onIllegal?:(uci:string)=>void;disabled?:boolean;lastMove?:string;hintSquare?:string}){
  const [selected,setSelected]=useState<Square|null>(null);
  const [promotion,setPromotion]=useState<{from:Square,to:Square}|null>(null);
  const board=new Chess(fen);
  const files=orientation==='w'?'abcdefgh':'hgfedcba';
  const ranks=orientation==='w'?'87654321':'12345678';
  const targets=selected?board.moves({square:selected,verbose:true}).map(m=>m.to):[];
  function click(square:Square){
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
    <div className="chessboard" role="group" aria-label={`${board.turn()==='w'?'White':'Black'} to move chessboard`}>
      {[...ranks].flatMap((rank,row)=>[...files].map((file,col)=>{
        const square=(file+rank) as Square,piece=board.get(square);
        const dark=isDarkSquare(square);
        const last=lastMove&&(lastMove.slice(0,2)===square||lastMove.slice(2,4)===square);
        return <button key={square} type="button" data-square={square} className={`square ${dark?'dark':'light'} ${selected===square?'selected':''} ${last?'last':''} ${hintSquare===square?'hint-square':''}`} onClick={()=>click(square)} aria-label={`${square}${piece?` ${piece.color==='w'?'white':'black'} ${names[piece.type]}`:' empty'}`} aria-pressed={selected===square} disabled={disabled||!onMove}>
          {col===0&&<span className="rank">{rank}</span>}{row===7&&<span className="file">{file}</span>}
          {piece&&<svg viewBox="0 0 100 100" className={`piece ${piece.color}`} aria-hidden="true"><text x="50" y="80" textAnchor="middle" fontSize="86" fontFamily="Arial Unicode MS, DejaVu Sans, serif">{glyphs[piece.type]}</text></svg>}
          {targets.includes(square)&&<span className={piece?'capture-target':'move-target'}/>}
        </button>;
      }))}
    </div>
    {promotion&&<div className="promotion-dialog" role="dialog" aria-label="Choose promotion piece"><p>Promote to</p>{['q','r','b','n'].map(p=><button key={p} onClick={()=>{onMove?.(promotion.from+promotion.to+p);setPromotion(null);setSelected(null);}}>{names[p]}</button>)}<button onClick={()=>setPromotion(null)}>Cancel</button></div>}
  </div>;
}
