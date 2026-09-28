import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('public Top rankings load while the sign-in SDK is still waiting',async()=>{
  const requests=[], events=[];
  const node={querySelectorAll(){return [];},querySelector(){return node;},addEventListener(){},classList:{toggle(){}}};
  const document={body:{dataset:{base:'./'}},head:{append(script){requests.push(script.src);}},createElement(){return {};},addEventListener(){},querySelectorAll(){return [];},querySelector(selector){return selector==='[data-reaction]'||selector==='#impacts'||selector==='#signin'||selector==='#auth-status'||selector==='#signout'||selector==='#vote-status'?node:null;}};
  const window={dispatchEvent(event){events.push(event);}};
  class CustomEvent {constructor(type,{detail}){this.type=type;this.detail=detail;}}
  const fetch=async url=>{
    requests.push(String(url));
    if(String(url).endsWith('/voting-config.json'))return Response.json({url:'https://project.supabase.co',publishableKey:'public'});
    return Response.json([{impact_id:'top-entry',score:7}]);
  };
  vm.runInNewContext(readFileSync('src/voting.js','utf8'),{document,window,location:{href:'https://example.org/'},URL,fetch,Response,AbortSignal,CustomEvent,setInterval(){},setTimeout(){},clearTimeout(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(requests.includes('https://project.supabase.co/rest/v1/rpc/impact_scores'));
  assert.ok(requests.includes('https://example.org/vendor/supabase.js'));
  assert.equal(events.length,1);
  assert.equal(events[0].type,'impact-ranking');
  assert.deepEqual(Array.from(events[0].detail.ids),['top-entry']);
});
