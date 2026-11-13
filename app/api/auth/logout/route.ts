import {env} from 'cloudflare:workers';
import {safely,json} from '../../_shared';
import {checkSameOrigin} from '../../../../lib/project-validation.mjs';
import {hashSession} from '../../../../lib/google-auth.mjs';
export const dynamic='force-dynamic';
export function POST(request:Request){return safely(async()=>{
 checkSameOrigin(request);const token=(request.headers.get('cookie')||'').match(/(?:^|;\s*)pixel_session=([a-f0-9]{64})(?:;|$)/)?.[1];
 if(token&&env.DB)await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await hashSession(token)).run();
 const response=json({ok:true});response.headers.set('Set-Cookie',`pixel_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${new URL(request.url).protocol==='https:'?'; Secure':''}`);return response;
});}
