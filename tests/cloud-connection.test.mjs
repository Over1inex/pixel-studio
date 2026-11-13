import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudError, readCloudJson, requestCloudJson} from '../lib/cloud-connection.mjs';
test('account reads recover after a transient connection failure', async () => {
  let calls = 0;
  const result = await readCloudJson('/api/me', {wait: async () => {}, fetchImpl: async () => {
    if (++calls === 1) throw new TypeError('network unavailable');
    return Response.json({user: {id: 'owner'}});
  }});
  assert.equal(result.user.id, 'owner'); assert.equal(calls, 2);
});
test('temporary service failure retries, forbidden access does not', async () => {
  let calls = 0;
  await readCloudJson('/api/me', {wait: async () => {}, fetchImpl: async () => ++calls === 1 ? new Response('', {status: 503}) : Response.json({user: null})});
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(readCloudJson('/api/me', {fetchImpl: async () => {calls++; return new Response('', {status: 403});}}), /Нет доступа/);
  assert.equal(calls, 1);
});
test('continued failure stops after two attempts', async () => {
  let calls = 0;
  await assert.rejects(readCloudJson('/api/me', {wait: async () => {}, fetchImpl: async () => {calls++; throw new Error('timeout');}}), /автоматически/);
  assert.equal(calls, 2);
});

test('native access error keeps its explanation and does not retry', async () => {
  let calls=0;
  await assert.rejects(readCloudJson('/api/me', {fetchImpl:async()=>{calls++;return Response.json({code:'CLOUD_ACCESS_MISSING',error:'Нужно восстановить доступ этого ПК.'},{status:403});}}), error => {
    assert.equal(error.code,'CLOUD_ACCESS_MISSING');assert.equal(error.status,403);assert.match(error.message,/восстановить/);return true;
  });
  assert.equal(calls,1);
});

test('a gateway HTML response recovers on the second read without displaying HTML', async () => {
  let calls=0;
  const result=await readCloudJson('/api/me',{wait:async()=>{},fetchImpl:async()=>++calls===1?new Response('<html>gateway secret</html>',{status:502}):Response.json({user:null})});
  assert.equal(result.user,null);assert.equal(calls,2);
});

test('HTML with HTTP 200 is not treated as a working cloud service', async () => {
  await assert.rejects(readCloudJson('/api/me',{wait:async()=>{},fetchImpl:async()=>new Response('<html>login page</html>')}), error=>error.code==='CLOUD_RESPONSE'&&!error.message.includes('<html>'));
});

test('saving is never automatically repeated after a timeout or service failure', async () => {
  for(const status of [0,503]){
    let calls=0;
    await assert.rejects(requestCloudJson('/api/projects',{method:'POST',body:'project'},{fetchImpl:async(_path,options)=>{
      calls++;assert.equal(options.body,'project');if(!status)throw new DOMException('timeout','TimeoutError');return Response.json({error:'Temporary error'},{status});
    }}),error=>error instanceof CloudError&&(status?error.status===503:error.code==='CLOUD_TIMEOUT'));
    assert.equal(calls,1);
  }
});

test('project load retries a transient response; validation failure does not retry', async () => {
  let calls=0;
  const data=await requestCloudJson('/api/projects/one',{}, {wait:async()=>{},fetchImpl:async()=>++calls===1?new Response('',{status:503}):Response.json({name:'Restored'})});
  assert.equal(data.name,'Restored');assert.equal(calls,2);calls=0;
  await assert.rejects(requestCloudJson('/api/projects',{method:'PUT'},{fetchImpl:async()=>{calls++;return Response.json({error:'Размер проекта превышен'},{status:400});}}),/Размер проекта/);
  assert.equal(calls,1);
});

test('expired account session remains distinct from unavailable cloud service', async () => {
  await assert.rejects(readCloudJson('/api/me',{fetchImpl:async()=>Response.json({},{status:401})}),error=>error.status===401&&error.code==='HTTP_401'&&/Google/.test(error.message));
});
