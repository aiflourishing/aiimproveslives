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

test('Top ties use newest impact dates for cached and refreshed scores', () => {
  const listeners = {};
  const empty = { hidden: true };
  const status = {};
  const clear = {};
  const search = { value: '', addEventListener() {}, closest: () => ({ querySelector: () => clear, addEventListener() {} }) };
  const cards = [
    { dataset: { impact: 'old', newOrder: '2', search: 'old' } },
    { dataset: { impact: 'new', newOrder: '0', search: 'new' } },
    { dataset: { impact: 'middle', newOrder: '1', search: 'middle' } }
  ];
  let displayed;
  const grid = { querySelectorAll: () => cards, append: (...ordered) => { displayed = ordered.map(card => card.dataset.impact); } };
  const sorts = ['top', 'new'].map(sort => ({ dataset: { sort }, addEventListener(type, callback) { this.click = callback; }, setAttribute() {} }));
  const nodes = { '#search': search, '#impacts .card-grid': grid, '#impacts .empty': empty, '#ranking-status': status, '#search-status': {} };
  const document = { body: { dataset: { base: './' } }, addEventListener() {}, querySelector: selector => nodes[selector] || null, querySelectorAll: selector => selector === '[data-sort]' ? sorts : [] };
  const rows = [{ impact_id: 'old', score: 2 }, { impact_id: 'middle', score: 2 }, { impact_id: 'new', score: 2 }];
  const localStorage = { getItem: () => JSON.stringify({ savedAt: Date.now(), rows }), setItem() {} };
  const window = { addEventListener: (type, callback) => { listeners[type] = callback; } };
  vm.runInNewContext(readFileSync('src/site.js', 'utf8'), { document, window, localStorage, location: { href: 'https://example.org/', search: '', hostname: 'example.org' }, URL, URLSearchParams, history: { replaceState() {} }, setTimeout, clearTimeout });
  assert.deepEqual(displayed, ['new', 'middle', 'old']);
  listeners['impact-ranking']({ detail: { ids: ['old', 'new', 'middle'], rows: [{ impact_id: 'old', score: 9 }, { impact_id: 'new', score: 4 }, { impact_id: 'middle', score: 4 }] } });
  assert.deepEqual(displayed, ['old', 'new', 'middle']);
  sorts[1].click();
  assert.deepEqual(displayed, ['new', 'middle', 'old']);
  sorts[0].click();
  assert.deepEqual(displayed, ['old', 'new', 'middle']);
});
