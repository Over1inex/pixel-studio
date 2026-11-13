// Real local Worker + isolated D1/R2. Synthetic sessions stand in for Google
// identities already verified by the signed-token tests. Never touches production.
import assert from 'node:assert/strict';
import '../scripts/sites-env.mjs';
import fs from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const workerRoot=resolve(root,'dist/server'),paths=(await fs.readdir(workerRoot,{recursive:true})).filter(p=>/\.(m?js)$/.test(p)&&p!=='index.js');
const modules=['index.js',...paths].map(path=>({type:'ESModule',path:resolve(workerRoot,path)}));
const mf=new Miniflare({modules,modulesRoot:workerRoot,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],bindings:{GOOGLE_DESKTOP_CLIENT_ID:'fixture.apps.googleusercontent.com'},d1Databases:['DB'],r2Buckets:['BUCKET']});
const db=await mf.getD1Database('DB');
for(const file of ['0000_great_paper_doll.sql','0001_flashy_wendell_vaughn.sql']){const sql=(await fs.readFile(resolve(root,'drizzle',file),'utf8')).replace(/-->[^\n]*/g,'');for(const statement of sql.split(';').filter(s=>s.trim()))await db.prepare(statement).run();}
const tokens=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)],now=Date.now();
for(const [i,token] of tokens.entries())await db.prepare('INSERT INTO auth_sessions(token_hash,user_id,email,name,expires_at,created_at) VALUES(?,?,?,?,?,?)').bind(createHash('sha256').update(token).digest('hex'),'google:fixture_'+i,`fixture${i}@example.test`,'Fixture '+i,now+(i===2?-1000:600000),now).run();
const origin='http://127.0.0.1';let checks=0;
async function call(path,{who=null,method='GET',body,headers={}}={}){const response=await mf.dispatchFetch(origin+path,{method,headers:{...(who===null?{}:{Cookie:`pixel_session=${tokens[who]}`}),...(body?{'Content-Type':'application/json',Origin:origin}:{}),...headers},body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()};}
function status(value,code,label){assert.equal(value.status,code,label+': '+JSON.stringify(value.data));checks++;console.log('PASS '+label+' '+code);}
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=';
const body={name:'Isolated fixture',document:{version:1,width:1,height:1,activeId:'layer',layers:[{id:'layer',name:'Image',visible:true,opacity:1,image}]}};
try{
 const settings=await call('/api/auth/config');assert.equal(settings.data.googleClientId,'fixture.apps.googleusercontent.com');
 status(await call('/api/projects',{headers:{'oai-authenticated-user-id':'google:fixture_0','oai-authenticated-user-email':'fixture0@example.test'}}),401,'Forged platform identity');
 status(await call('/api/projects'),401,'Anonymous list');status(await call('/api/projects',{method:'POST',body}),401,'Anonymous save');
 status(await call('/api/projects',{who:2}),401,'Expired Google session');
 for(const who of [0,1]){const me=await call('/api/me',{who});status(me,200,'Google identity');assert.equal(me.data.user.id,'google:fixture_'+who);}
 const a=await call('/api/projects',{who:0,method:'POST',body}),b=await call('/api/projects',{who:1,method:'POST',body});status(a,201,'A saves');status(b,201,'B saves');
 for(const [owner,other,id] of [[0,1,a.data.id],[1,0,b.data.id]]){
  status(await call('/api/projects/'+id,{who:owner}),200,'Owner reads');status(await call('/api/projects/'+id,{who:other}),404,'Other account cannot read');
  status(await call('/api/projects/'+id,{who:other,method:'PUT',body}),404,'Other account cannot overwrite');
  status(await call('/api/projects/'+id,{who:other,method:'DELETE',headers:{Origin:origin}}),404,'Other account cannot delete');
  const list=await call('/api/projects',{who:owner});status(list,200,'Own list');assert.deepEqual(list.data.projects.map(p=>p.id),[id]);
 }
 status(await call('/api/projects/'+a.data.id,{who:0,method:'DELETE',headers:{Origin:origin}}),200,'Owner removes own project');
 status(await call('/api/auth/logout',{who:0,method:'POST',headers:{Origin:origin}}),200,'A logs out');
 status(await call('/api/projects',{who:0}),401,'Revoked session denied');status(await call('/api/projects/'+b.data.id,{who:1}),200,'B stays signed in');
 console.log(`Google project isolation: ${checks} HTTP checks passed; separate accounts cannot access each other's data.`);
}finally{await mf.dispose();}
