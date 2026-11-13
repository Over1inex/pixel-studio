import {env} from 'cloudflare:workers';
import {safely,json,storage} from '../../_shared';
import {checkSameOrigin,AppError} from '../../../../lib/project-validation.mjs';
import {readAuthBody,validateCodeRequest,verifyGoogleToken,randomSession,hashSession} from '../../../../lib/google-auth.mjs';
export const dynamic='force-dynamic';
export function POST(request:Request){return safely(async()=>{
 checkSameOrigin(request);
 if(!env.GOOGLE_DESKTOP_CLIENT_ID)throw new AppError('Вход Google ещё не настроен владельцем приложения.',503);
 const input=validateCodeRequest(await readAuthBody(request));
 const values:Record<string,string>={client_id:env.GOOGLE_DESKTOP_CLIENT_ID,code:input.code,code_verifier:input.codeVerifier,redirect_uri:input.redirectUri,grant_type:'authorization_code'};
 if(env.GOOGLE_DESKTOP_CLIENT_SECRET)values.client_secret=env.GOOGLE_DESKTOP_CLIENT_SECRET;
 const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams(values),signal:AbortSignal.timeout(15000)});
 if(!tokenResponse.ok)throw new AppError('Google отклонил вход. Повторите попытку; если ошибка повторится, проверьте настройки OAuth приложения.',401);
 const tokenData=await tokenResponse.json() as {id_token?:string};
 const user=await verifyGoogleToken(tokenData.id_token,env.GOOGLE_DESKTOP_CLIENT_ID,input.nonce);
 if(env.GOOGLE_ALLOWED_EMAIL&&user.email.toLowerCase()!==env.GOOGLE_ALLOWED_EMAIL.trim().toLowerCase())throw new AppError('У этого аккаунта нет доступа к приложению.',403);
 const {db}=storage(), token=randomSession(),now=Date.now(),expires=now+30*24*60*60*1000;
 await db.batch([
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(now),
  db.prepare('INSERT INTO auth_sessions(token_hash,user_id,email,name,expires_at,created_at) VALUES(?,?,?,?,?,?)').bind(await hashSession(token),user.userId,user.email,user.displayName,expires,now),
  db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM auth_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 10)').bind(user.userId,user.userId),
 ]);
 const response=json({user:{id:user.userId,email:user.email,name:user.displayName}});
 const secure=new URL(request.url).protocol==='https:'?'; Secure':'';
 response.headers.set('Set-Cookie',`pixel_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
 return response;
});}
