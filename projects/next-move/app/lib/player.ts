/** Identify the requested account only when exactly one PGN player matches. */
export function identifyPlayerColor(headers:Record<string,string>,username:string):'w'|'b'|undefined{
  const name=username.trim().toLowerCase();
  if(!name)return undefined;
  const white=headers.White?.trim().toLowerCase()===name;
  const black=headers.Black?.trim().toLowerCase()===name;
  return white!==black?(white?'w':'b'):undefined;
}
