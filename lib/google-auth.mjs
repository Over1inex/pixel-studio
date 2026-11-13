import {createRemoteJWKSet, jwtVerify} from 'jose';
import {AppError} from './project-validation.mjs';
const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export async function verifyGoogleToken(token, audience, nonce, resolver = keys) {
  if (typeof token !== 'string' || token.length > 16000 || !audience || typeof nonce !== 'string' || nonce.length < 32) throw new AppError('Некорректный ответ Google.',401);
  let payload;
  try { ({payload}=await jwtVerify(token,resolver,{audience,issuer:['https://accounts.google.com','accounts.google.com'],algorithms:['RS256'],requiredClaims:['sub','exp','iat','email','nonce'],maxTokenAge:'1h',clockTolerance:30})); }
  catch { throw new AppError('Не удалось подтвердить вход Google. Войдите ещё раз.',401); }
  if(payload.nonce!==nonce || payload.email_verified!==true || typeof payload.email!=='string' || typeof payload.sub!=='string' || (payload.azp&&payload.azp!==audience)) throw new AppError('Не удалось подтвердить аккаунт Google.',401);
  return {userId:`google:${payload.sub}`,email:payload.email,displayName:typeof payload.name==='string'?payload.name.slice(0,150):payload.email,fullName:null};
}
export async function readAuthBody(request) {
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))throw new AppError('Ожидается JSON.',415);
  const reader=request.body?.getReader();if(!reader)throw new AppError('Пустой запрос.');
  let length=0;const parts=[];
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>16384){await reader.cancel();throw new AppError('Запрос слишком большой.',413);}parts.push(value);}
  const data=new Uint8Array(length);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.length;}
  try{return JSON.parse(new TextDecoder().decode(data));}catch{throw new AppError('Некорректный JSON.');}
}
export function validateCodeRequest(body) {
  if(!body || typeof body.code!=='string'||body.code.length<8||body.code.length>4096||typeof body.codeVerifier!=='string'||!/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier)||typeof body.nonce!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(body.nonce))throw new AppError('Некорректные параметры входа.');
  let redirect;try{redirect=new URL(body.redirectUri);}catch{throw new AppError('Некорректный адрес возврата.');}
  if(redirect.protocol!=='http:'||redirect.hostname!=='127.0.0.1'||!redirect.port||Number(redirect.port)<1024||redirect.pathname!=='/'||redirect.search||redirect.hash||redirect.username||redirect.password)throw new AppError('Некорректный адрес возврата.');
  return {code:body.code,codeVerifier:body.codeVerifier,nonce:body.nonce,redirectUri:redirect.href};
}
export async function hashSession(token) {return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');}
export function randomSession(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');}
