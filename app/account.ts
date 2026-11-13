import {headers} from 'next/headers';
import {env} from 'cloudflare:workers';
import {getChatGPTUser} from './chatgpt-auth';
import {hashSession} from '../lib/google-auth.mjs';
import {googleSessionAllowed} from '../lib/session-policy.mjs';
export async function currentAccount(){
 const requestHeaders=await headers();
 const token=(requestHeaders.get('cookie')||'').match(/(?:^|;\s*)pixel_session=([a-f0-9]{64})(?:;|$)/)?.[1];
 if(token&&env.DB&&env.GOOGLE_DESKTOP_CLIENT_ID){
  const row=await env.DB.prepare('SELECT user_id,email,name FROM auth_sessions WHERE token_hash=? AND expires_at>?').bind(await hashSession(token),Date.now()).first<{user_id:string;email:string;name:string}>();
  if(row&&googleSessionAllowed(row,env.GOOGLE_DESKTOP_CLIENT_ID,env.GOOGLE_ALLOWED_EMAIL))return {userId:row.user_id,email:row.email,displayName:row.name,fullName:null};
 }
 // Sites authentication remains available until Google is configured by the owner.
 return env.GOOGLE_DESKTOP_CLIENT_ID?null:getChatGPTUser();
}
