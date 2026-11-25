import { getChatGPTUser } from '../../chatgpt-auth';
import { getDb } from '@/db';
import { trainingStates } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { readState } from '@/lib/training-state';

export async function GET(){
  const user=await getChatGPTUser();
  if(!user) return Response.json({error:'Sign in to save progress across devices.'},{status:401});
  const [row]=await getDb().select().from(trainingStates).where(eq(trainingStates.userId,user.userId));
  return Response.json({state:row?JSON.parse(row.state):null,revision:row?.revision??0},{headers:{'Cache-Control':'no-store'}});
}

export async function PUT(request:Request){
  const user=await getChatGPTUser();
  if(!user) return Response.json({error:'Sign in to save progress across devices.'},{status:401});
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin) return Response.json({error:'Invalid request origin.'},{status:403});
  const raw=await request.text();
  if(new TextEncoder().encode(raw).length>4_000_000) return Response.json({error:'Profile exceeds 4 MB. Export a backup.'},{status:413});
  let data;
  // The browser validates PGN and puzzle legality at import/load. The sync API
  // validates shape, size and ownership without replaying every saved game on
  // every attempt, which would exceed small Worker CPU budgets as history grows.
  try {data=JSON.parse(raw); data.state=readState(data.state,{verifyChess:false}); if(!Number.isSafeInteger(data.revision)||data.revision<0) throw new Error();}
  catch {return Response.json({error:'Invalid training profile.'},{status:400});}
  const db=getDb();
  const state=JSON.stringify(data.state), updatedAt=Date.now();
  if(data.revision===0){
    const rows=await db.insert(trainingStates).values({userId:user.userId,state,updatedAt,revision:1}).onConflictDoNothing().returning({revision:trainingStates.revision});
    if(rows.length) return Response.json(rows[0]);
  } else {
    const rows=await db.update(trainingStates).set({state,updatedAt,revision:sql`${trainingStates.revision} + 1`}).where(and(eq(trainingStates.userId,user.userId),eq(trainingStates.revision,data.revision))).returning({revision:trainingStates.revision});
    if(rows.length) return Response.json(rows[0]);
  }
  return Response.json({error:'Another device saved progress. Merge and retry.'},{status:409});
}
