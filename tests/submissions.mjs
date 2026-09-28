import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHandler, validateSubmission } from '../supabase/functions/submit-impact/handler.mjs';
const id = '20000000-0000-0000-0000-000000000001';
const user = '10000000-0000-0000-0000-000000000001';
const record = { title: 'Benefit', description: 'People benefited.', occurred_by: '2026/09/26', sources: ['https://example.org/evidence', 'https://example.org/second-source'], submitter_is_contributor: false };
const payload = () => ({ submission_id: id, record: structuredClone(record) });
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only', GITHUB_SUBMISSIONS_TOKEN: 'github-only', ALLOWED_ORIGINS: 'http://localhost:8000' };
function harness(options = {}) {
  const calls = [];
  let receipt, createdPR;
  const fetcher = async (url, init) => {
    calls.push({url,init});
    if (url.endsWith('/auth/v1/user')) return Response.json({id:user,email_confirmed_at:'today',is_anonymous:false,...options.user}, {status:options.authStatus || 200});
    if (url.endsWith('/reserve_submission')) {
      const body = JSON.parse(init.body); assert.equal(body.p_user,user);
      if (receipt) return Response.json({...receipt,fresh:false});
      receipt = {id,user_id:user,status:'pending',fresh:true}; return Response.json(receipt);
    }
    if (url.endsWith('/finish_pr_submission')) { const body=JSON.parse(init.body);receipt={...receipt,status:body.p_pr?'submitted':'failed',pr_number:body.p_pr};return new Response(null,{status:204}); }
    if (url.endsWith('/submission_receipt')) return Response.json(options.missing ? null : receipt);
    if (url.includes('/pulls?state=all')) return Response.json(createdPR ? [createdPR] : []);
    if (url.includes('/git/ref/heads/codex/')) return new Response(null,{status:404});
    if (url.endsWith('/git/ref/heads/main')) return Response.json({object:{sha:'base-sha'}});
    if (url.includes('/contents/data/impacts/')) return options.collision ? Response.json({content:'exists'}) : new Response(null,{status:404});
    if (url.endsWith('/git/commits/base-sha')) return Response.json({tree:{sha:'base-tree'}});
    if (url.endsWith('/git/trees')) return Response.json({sha:'proposed-tree'});
    if (url.endsWith('/git/commits')) return Response.json({sha:'proposed-commit'});
    if (url.endsWith('/git/refs')) return Response.json({ref:'refs/heads/codex/submission-'+id});
    if (url.includes('/contents/.github/pull_request_template.md')) return Response.json({content:Buffer.from('## Moderator review\n\n- [ ] Required question').toString('base64')});
    if (url.endsWith('/pulls')) {
      if (options.timeout) {
        if(options.acceptedTimeout) createdPR={number:42,head:{ref:'codex/submission-'+id,repo:{full_name:'aiflourishing/aiimproveslives'}}};
        throw Error('network timeout');
      }
      createdPR={number:42,head:{ref:'codex/submission-'+id,repo:{full_name:'aiflourishing/aiimproveslives'}}};
      return Response.json(createdPR, {status:options.githubStatus || 201});
    }
    if (url.includes('/comments?')) return Response.json(options.comments || []);
    throw Error('Unexpected URL: '+url);
  };
  return {handler:createHandler(env,fetcher),calls};
}
function request(body=payload(), options={}) {
  return new Request('https://project.supabase.co/functions/v1/submit-impact'+(options.get?'?id='+id:''), {
    method:options.get?'GET':'POST',headers:{Origin:options.origin || 'http://localhost:8000',Authorization:'Bearer user-token','Content-Type':'application/json'},body:options.get?undefined:JSON.stringify(body)
  });
}
test('validates schema, real dates, sources, image URLs and bounded text', () => {
  assert.deepEqual(validateSubmission(payload()),record);
  for (const change of [{occurred_by:'2026/02/30'},{occurred_by:'0000/01/01'},{sources:['javascript:alert(1)']},{sources:[]},{submitter_is_contributor:'false'},{title:' '},{description:'x'.repeat(10001)},{image:'http://example.org/photo.jpg'},{id}]) {
    assert.throws(()=>validateSubmission({...payload(),record:{...record,...change}}));
  }
  assert.equal(validateSubmission({...payload(),record:{...record,image:'https://example.org/photo.jpg'}}).image,'https://example.org/photo.jpg');
});
test('rejects unauthenticated, unverified and foreign-origin calls before GitHub', async () => {
  for (const options of [{authStatus:401},{user:{is_anonymous:true}},{user:{email_confirmed_at:null}}]) {
    const h=harness(options);const response=await h.handler(request());assert.ok([401,403].includes(response.status));assert.equal(h.calls.length,1);
  }
  const h=harness();assert.equal((await h.handler(request(payload(),{origin:'https://evil.example'}))).status,403);assert.equal(h.calls.length,0);
});
test('creates a PR directly with only a valid record and returns the same PR on retries',async()=>{
  const h=harness();
  const response=await h.handler(request());assert.equal(response.status,201);
  assert.equal((await response.json()).pr_url,'https://github.com/aiflourishing/aiimproveslives/pull/42');
  assert.equal((await (await h.handler(request())).json()).pr_url,'https://github.com/aiflourishing/aiimproveslives/pull/42');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/pulls') && c.init.method==='POST').length,1);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/issues')).length,0);
  const tree=JSON.parse(h.calls.find(c=>c.url.endsWith('/git/trees')).init.body);
  assert.equal(tree.tree.length,1);assert.equal(tree.tree[0].path,`data/impacts/${id}.json`);
  const input=tree.tree[0].content;
  const parsed=JSON.parse(execFileSync('python3',['-c','import sys,json,tempfile; from pathlib import Path; from scripts.catalog import load_catalog;\nwith tempfile.TemporaryDirectory() as d:\n p=Path(d); (p/"impacts").mkdir(); record=json.load(sys.stdin); (p/"impacts"/(record["id"]+".json")).write_text(json.dumps(record)); print(json.dumps(load_catalog(p)["impacts"][record["id"]]))'],{input,encoding:'utf8'}));
  assert.equal(parsed.id,id);assert.deepEqual(parsed.sources,record.sources);
  const pr=JSON.parse(h.calls.find(c=>c.url.endsWith('/pulls')).init.body);
  assert.ok(pr.body.includes('## Moderator review'));assert.ok(!pr.body.includes('Related Issue'));
});
test('uncertain GitHub timeout never causes another creation attempt',async()=>{
  const h=harness({timeout:true});assert.equal((await h.handler(request())).status,202);
  assert.equal((await (await h.handler(request())).json()).status,'pending');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/pulls') && c.init.method==='POST').length,1);
});
test('marks definite GitHub rejections failed',async()=>{
  const rejected=harness({githubStatus:403});assert.equal((await rejected.handler(request())).status,502);
  assert.ok(rejected.calls.some(c=>c.url.endsWith('/finish_pr_submission') && JSON.parse(c.init.body).p_pr===null));
});

test('recovers a PR accepted before a timeout without another content creation',async()=>{
  const h=harness({timeout:true,acceptedTimeout:true});
  assert.equal((await h.handler(request())).status,202);
  const result=await (await h.handler(request(null,{get:true}))).json();
  assert.equal(result.pr_url,'https://github.com/aiflourishing/aiimproveslives/pull/42');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/pulls') && c.init.method==='POST').length,1);
});
test('a supplied ID cannot overwrite an existing accepted entry',async()=>{
  const h=harness({collision:true});assert.equal((await h.handler(request())).status,502);
  assert.ok(!h.calls.some(c=>c.url.endsWith('/git/trees')));
});
