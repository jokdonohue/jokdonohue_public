import Trainer from '@/components/Trainer';
import { getChatGPTUser } from './chatgpt-auth';
export const dynamic='force-dynamic';
export default async function Home(){
  const user=await getChatGPTUser();
  return <Trainer userId={user?.userId??null}/>;
}
