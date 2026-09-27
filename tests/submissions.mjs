import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHandler, validateSubmission, issueBody } from '../supabase/functions/submit-impact/handler.mjs';
const id = '20000000-0000-0000-0000-000000000001';
const user = '10000000-0000-0000-0000-000000000001';
const record = { title: 'Benefit', description: 'People benefited.', occurred_by: '2026/09/26', sources: ['https://example.org/evidence', 'https://example.org/second-source'], submitter_is_contributor: false };
const payload = () => ({ submission_id: id, record: structuredClone(record) });
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only', GITHUB_ISSUES_TOKEN: 'github-only', ALLOWED_ORIGINS: 'http://localhost:8000' };
function harness(options = {}) {
  const calls = [];
  let receipt;
  const fetcher = async (url, init) => {
    calls.push({url,init});
    if (url.endsWith('/auth/v1/user')) return Response.json({id:user,email_confirmed_at:'today',is_anonymous:false,...options.user}, {status:options.authStatus || 200});
    if (url.endsWith('/reserve_submission')) {
      const body = JSON.parse(init.body); assert.equal(body.p_user,user);
      if (options.rateLimit) return Response.json({message:'Submission limit reached'}, {status:400});
      if (receipt) return Response.json({...receipt,fresh:false});
      receipt = {id,user_id:user,status:'pending',fresh:true}; return Response.json(receipt);
    }
    if (url.endsWith('/finish_submission')) { const body=JSON.parse(init.body);receipt={...receipt,status:body.p_issue?'submitted':'failed',issue_number:body.p_issue};return new Response(null,{status:204}); }
    if (url.endsWith('/submission_receipt')) return Response.json(options.missing ? null : receipt);
    if (url.endsWith('/issues')) {
      if (options.timeout) throw Error('network timeout');
      return Response.json({number:42}, {status:options.githubStatus || 201});
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
test('generated issue is accepted by the real Python intake parser', () => {
  const input = {...record,description:'Markdown ```json\n{}\n``` and ### Impact JSON stays data.'};
  const body=issueBody(input,id);
  const parsed=JSON.parse(execFileSync('python3',['-c','import sys,json,tempfile; from pathlib import Path; from scripts.intake import parse_submission;\nwith tempfile.TemporaryDirectory() as d:\n p=Path(d); (p/"impacts").mkdir(); result=parse_submission({"issue":{"number":42,"html_url":"https://github.com/aiflourishing/aiimproveslives/issues/42","body":sys.stdin.read()}},p); print(json.dumps(result[1]))'],{input:body,encoding:'utf8'}));
  assert.equal(parsed.description,input.description);assert.equal(parsed.submitter_is_contributor,false);assert.deepEqual(parsed.sources,input.sources);
});
test('rejects unauthenticated, unverified and foreign-origin calls before GitHub', async () => {
  for (const options of [{authStatus:401},{user:{is_anonymous:true}},{user:{email_confirmed_at:null}}]) {
    const h=harness(options);const response=await h.handler(request());assert.ok([401,403].includes(response.status));assert.equal(h.calls.length,1);
  }
  const h=harness();assert.equal((await h.handler(request(payload(),{origin:'https://evil.example'}))).status,403);assert.equal(h.calls.length,0);
});
test('creates one issue, returns receipt on retries, and exposes only trusted PR links',async()=>{
  const h=harness({comments:[{user:{login:'someone'},body:'https://github.com/aiflourishing/aiimproveslives/pull/999'},{user:{login:'github-actions[bot]'},body:'Ready for moderator review: https://github.com/aiflourishing/aiimproveslives/pull/123\n\nRecord:'}]});
  assert.equal((await h.handler(request())).status,201);
  assert.equal((await (await h.handler(request())).json()).issue_url,'https://github.com/aiflourishing/aiimproveslives/issues/42');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/issues')).length,1);
  const response=await h.handler(request(null,{get:true}));assert.equal((await response.json()).pr_url,'https://github.com/aiflourishing/aiimproveslives/pull/123');
});
test('uncertain GitHub timeout never causes another creation attempt',async()=>{
  const h=harness({timeout:true});assert.equal((await h.handler(request())).status,202);
  assert.equal((await (await h.handler(request())).json()).status,'pending');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/issues')).length,1);
});
test('returns useful rate-limit errors and marks definite GitHub rejections failed',async()=>{
  const h=harness({rateLimit:true});assert.equal((await h.handler(request())).status,429);
  const rejected=harness({githubStatus:403});assert.equal((await rejected.handler(request())).status,502);
  assert.ok(rejected.calls.some(c=>c.url.endsWith('/finish_submission') && JSON.parse(c.init.body).p_issue===null));
});
