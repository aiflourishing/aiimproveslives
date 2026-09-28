import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/review-checklist/handler.mjs';
import { requiredQuestions } from '../supabase/functions/_shared/review-checklist.mjs';
const env={GITHUB_WEBHOOK_SECRET:'test-secret',GITHUB_SUBMISSIONS_TOKEN:'test-token',GITHUB_REPOSITORY:'owner/repo'};
const payload={action:'edited',changes:{body:{from:'old'}},repository:{full_name:'owner/repo'},pull_request:{number:7}};
async function request(value=payload, event='pull_request', valid=true) {
  const body=JSON.stringify(value);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body));
  const signature='sha256='+Buffer.from(digest).toString('hex');
  return new Request('https://project.supabase.co/functions/v1/review-checklist',{method:'POST',body,headers:{'x-github-event':event,'x-hub-signature-256':valid?signature:'wrong'}});
}
test('signed edits post the required status directly without Actions startup',async()=>{
  for(const checked of [false,true]) {
    const calls=[];
    const handler=createHandler(env,async(url,init)=>{
      calls.push({url,init});
      if(url.includes('/files?'))return Response.json([{filename:'data/impacts/id.json',status:'added'}]);
      if(url.endsWith('/pulls/7'))return Response.json({state:'open',head:{sha:'commit'},body:'## Moderator review\n\n'+requiredQuestions.map(q=>`- [${checked?'x':' '}] ${q}`).join('\n')});
      if(url.endsWith('/statuses/commit'))return Response.json({});
      throw Error(url);
    });
    assert.equal((await handler(await request())).status,200);
    const status=JSON.parse(calls.find(c=>c.url.endsWith('/statuses/commit')).init.body);
    assert.equal(status.context,'Moderator review');assert.equal(status.state,checked?'success':'failure');
  }
});
test('rejects forged signatures and wrong repos; ignores unrelated events without GitHub requests',async()=>{
  let calls=0;
  const handler=createHandler(env,()=>{calls++;throw Error('must not call');});
  assert.equal((await handler(await request(payload,'pull_request',false))).status,401);
  assert.equal((await handler(await request({...payload,repository:{full_name:'other/repo'}}))).status,400);
  assert.equal((await handler(await request({...payload,action:'closed'}))).status,200);
  assert.equal((await handler(await request({...payload,changes:{title:{from:'old'}}}))).status,200);
  assert.equal((await handler(await request(payload,'ping'))).status,200);
  assert.equal(calls,0);
});
