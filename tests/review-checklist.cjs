const test = require('node:test');
const assert = require('node:assert/strict');
let requiredQuestions, updateQuestion, missingReview, run;
const ready = import('../supabase/functions/_shared/review-checklist.mjs').then(module => ({ requiredQuestions, updateQuestion, missingReview, run } = module));
const { before } = require('node:test');
before(() => ready);
const body = (checked = true, questions = requiredQuestions) => '## Moderator review\n\n' + questions.map(q => `- [${checked ? 'x' : ' '}] ${q}`).join('\n');

test('requires all review boxes, including when the section or individual rows are removed', () => {
  assert.deepEqual(missingReview(body()), []);
  assert.equal(missingReview(body(false)).length, 4);
  assert.equal(missingReview('').length, 4);
  assert.equal(missingReview(body(true, requiredQuestions.slice(1))).length, 1);
  assert.equal(missingReview(body() + '\n- [ ] ' + requiredQuestions[0]).length, 1);
  assert.equal(missingReview('<!--\n' + body() + '\n-->').length, 4);
  assert.equal(missingReview('```markdown\n' + body() + '\n```').length, 4);
  assert.deepEqual(missingReview(body().replace('existing entry', 'existing Impact')), []);
  assert.deepEqual(missingReview(body().replaceAll('[x]', '[X]')), []);
});

test('updates require the additional preservation review', () => {
  assert.deepEqual(missingReview(body(), true), [updateQuestion]);
  assert.deepEqual(missingReview(body(true, [...requiredQuestions, updateQuestion]), true), []);
});

test('posts a failing status to the PR head for unchecked entries and succeeds for checked entries or code-only PRs', async () => {
  for (const scenario of [
    { body: body(false), files: [{ filename: 'data/impacts/id.json', status: 'added' }], expected: 'failure' },
    { body: body(), files: [{ filename: 'data/impacts/id.json', status: 'added' }], expected: 'success' },
    { body: body(), files: [{ filename: 'data/impacts/id.json', status: 'modified' }], expected: 'failure' },
    { body: '', files: [{ filename: 'src/site.js', status: 'modified' }], expected: 'success' },
  ]) {
    const statuses = [];
    const github = {
      rest: {
        pulls: { get: async () => ({ data: { state: 'open', body: scenario.body, head: { sha: 'latest-head' } } }), listFiles() {} },
        repos: { createCommitStatus: async status => statuses.push(status) }
      },
      paginate: async () => scenario.files
    };
    let failed = false;
    await run({ github, context: { repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 1 } } }, core: { setFailed() { failed = true; } } });
    assert.equal(statuses.length, 1); // No late pending status can hide a fast webhook result.
    assert.equal(statuses.at(-1).state, scenario.expected);
    assert.equal(statuses.at(-1).sha, 'latest-head');
    assert.equal(failed, scenario.expected === 'failure');
  }
});

test('rapid edits re-read the current body before publishing a status',async()=>{
  const statuses=[];
  let reads=0;
  const github={rest:{pulls:{get:async()=>({data:{state:'open',head:{sha:'head'},body:++reads===1?body(false):body()}}),listFiles(){}},repos:{createCommitStatus:async s=>statuses.push(s)}},paginate:async()=>[{filename:'data/impacts/id.json',status:'added'}]};
  await run({github,context:{repo:{owner:'owner',repo:'repo'},payload:{pull_request:{number:1}}},core:{setFailed(){throw Error('stale body must not fail');}}});
  assert.equal(statuses.length,1);assert.equal(statuses[0].state,'success');assert.ok(reads>=4);
});
