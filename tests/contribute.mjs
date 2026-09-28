import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../src/contribute.js', import.meta.url), 'utf8');
const key = 'impact-draft:v2:/';
let nextId = 0;
function storage(entries = []) {
  const values = new Map(entries);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    clone: () => storage(values),
  };
}
function element() {
  const handlers = new Map();
  return {
    value: '', hidden: true, classList: { remove() {}, toggle() {} },
    addEventListener: (type, callback) => handlers.set(type, callback),
    emit: (type, event = {}) => handlers.get(type)?.(event),
    setCustomValidity() {}, setAttribute() {}, removeAttribute() {}, focus() {},
  };
}
function tab({ local = storage(), session = storage(), request }) {
  const nodes = new Map();
  for (const id of ['contribute-form', 'source-list', 'add-source', 'contribute-fields',
    'submission-result', 'submission-success', 'review-pending', 'submission-message',
    'contribute-intro', 'submission-pr', 'image-preview', 'image-status']) nodes.set('#' + id, element());
  nodes.set('#contribution-copy', { textContent: JSON.stringify({
    'Submitting message': 'Submitting…', 'Pending submission message': 'Pending',
    'Invalid date message': 'Invalid date', 'Invalid link message': 'Invalid link',
  }) });
  const form = nodes.get('#contribute-form');
  const submitButton = element();
  submitButton.innerHTML = 'Submit <span>↗</span>';
  form.querySelector = () => submitButton;
  const inputs = {};
  for (const name of ['title', 'description', 'occurred_by', 'submitter_is_contributor', 'image', 'sources']) inputs[name] = element();
  inputs.namedItem = name => inputs[name];
  form.elements = inputs;
  form.reportValidity = () => true;
  form.reset = () => Object.values(inputs).forEach(input => { if (input && typeof input === 'object') input.value = ''; });
  const row = { querySelector: selector => selector === 'input' ? inputs.sources : element() };
  const sources = nodes.get('#source-list');
  sources.children = [row]; sources.firstElementChild = row;
  sources.querySelector = () => inputs.sources;
  sources.querySelectorAll = () => [inputs.sources];
  const auth = {
    session: { user: { id: 'user' } }, ready: Promise.resolve(),
    requireSession: async () => auth.session, requestSubmission: request,
  };
  runInNewContext(script, {
    window: { impactAuth: auth, addEventListener() {} },
    document: { body: { dataset: { base: '/' } }, querySelector: selector => nodes.get(selector), querySelectorAll: () => [] },
    location: { href: 'https://example.org/contribute/', pathname: '/contribute/' },
    localStorage: local, sessionStorage: session,
    crypto: { randomUUID: () => `submission-${++nextId}` }, URL,
    FormData: class {
      get(name) { return inputs[name].value; }
      getAll(name) { return [this.get(name)]; }
      *[Symbol.iterator]() { for (const [name, input] of Object.entries(inputs)) if (typeof input !== 'function') yield [name, input.value]; }
    },
    setTimeout: () => 1, clearTimeout() {},
  });
  return {
    session, inputs, nodes, submitButton,
    fill(title) {
      Object.assign(inputs.title, { value: title });
      inputs.description.value = 'People benefited.';
      inputs.occurred_by.value = '2026/07/23';
      inputs.submitter_is_contributor.value = 'false';
      inputs.sources.value = 'https://example.org/evidence';
      form.emit('input');
    },
    submit: () => form.emit('submit', { preventDefault() {} }),
  };
}

test('duplicated tabs can submit different impacts without sharing IDs or overwriting drafts', async () => {
  const sent = [];
  const local = storage();
  const request = async body => {
    sent.push(body);
    return { submission_id: body.submission_id, status: 'submitted', issue_url: 'https://example.org/issue' };
  };
  const original = tab({ local, request });
  original.fill('ChatGPT');
  const duplicate = tab({ local, session: original.session.clone(), request });
  duplicate.fill('John Deere');
  await duplicate.submit();
  assert.equal(JSON.parse(original.session.getItem(key)).values.title, 'ChatGPT');
  // Reloading the unsent original tab must keep its own draft.
  const reloaded = tab({ local, session: original.session, request });
  assert.equal(reloaded.inputs.title.value, 'ChatGPT');
  await reloaded.submit();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].submission_id, sent[1].submission_id);
  assert.deepEqual(sent.map(body => body.record.title), ['John Deere', 'ChatGPT']);
});

test('a failed connection keeps the same ID on retries, including after a reload', async () => {
  const sent = [];
  const request = async body => {
    sent.push(body);
    if (sent.length < 3) throw Error('Connection lost');
    return { submission_id: body.submission_id, status: 'submitted', issue_url: 'https://example.org/issue' };
  };
  const original = tab({ request });
  original.fill('ChatGPT');
  await original.submit();
  await original.submit();
  const reloaded = tab({ session: original.session, request });
  await reloaded.submit();
  assert.equal(new Set(sent.map(body => body.submission_id)).size, 1);
});

test('changing a previously attempted impact uses a new ID', async () => {
  const sent = [];
  const original = tab({ request: async body => { sent.push(body); throw Error('Connection lost'); } });
  original.fill('ChatGPT');
  await original.submit();
  const duplicate = tab({ session: original.session.clone(), request: async body => { sent.push(body); throw Error('Connection lost'); } });
  duplicate.fill('John Deere');
  await duplicate.submit();
  assert.notEqual(sent[0].submission_id, sent[1].submission_id);
});

test('an old shared-storage draft recovers a definite ID conflict once without clearing the form', async () => {
  const sent = [];
  const saved = { submission_id: 'old-conflicted-id' };
  const local = storage([[key, JSON.stringify(saved)]]);
  const original = tab({ local, request: async body => {
    sent.push(body);
    if (sent.length === 1) throw Object.assign(Error('ID already used'), { status: 409 });
    return { submission_id: body.submission_id, status: 'submitted', issue_url: 'https://example.org/issue' };
  } });
  original.fill('ChatGPT');
  // Model the old version having already attempted this exact payload with an inherited ID.
  const draft = JSON.parse(original.session.getItem(key));
  draft.lastPayload = JSON.stringify({ record: { title: 'ChatGPT', description: 'People benefited.',
    occurred_by: '2026/07/23', sources: ['https://example.org/evidence'], submitter_is_contributor: false } });
  original.session.setItem(key, JSON.stringify(draft));
  const reloaded = tab({ local, session: original.session, request: async body => {
    sent.push(body);
    if (sent.length === 1) throw Object.assign(Error('ID already used'), { status: 409 });
    return { submission_id: body.submission_id, status: 'submitted', issue_url: 'https://example.org/issue' };
  } });
  await reloaded.submit();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].submission_id, 'old-conflicted-id');
  assert.notEqual(sent[1].submission_id, sent[0].submission_id);
  assert.equal(sent[1].record.title, 'ChatGPT');
  assert.equal(local.getItem(key), null);
  assert.equal(reloaded.nodes.get('#submission-success').hidden, false);
});

test('pending submissions retain their ID on reload and only refresh the receipt', async () => {
  const calls = [];
  const request = async (body, id) => {
    calls.push({ body, id });
    return { submission_id: id || body.submission_id, status: 'pending' };
  };
  const original = tab({ request });
  original.fill('ChatGPT');
  await original.submit();
  const id = calls[0].body.submission_id;
  tab({ session: original.session, request });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.body).length, 1);
  assert.equal(calls[1].id, id);
});

test('submission progress stays in the button without a separate status box', async () => {
  let finish;
  const original = tab({ request: body => new Promise(resolve => {
    finish = () => resolve({ submission_id: body.submission_id, status: 'submitted', issue_url: 'https://example.org/issue' });
  }) });
  original.fill('ChatGPT');
  const submitting = original.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(original.submitButton.textContent, 'Submitting…');
  assert.equal(original.nodes.get('#submission-result').hidden, true);
  assert.equal(original.nodes.get('#contribute-fields').disabled, true);
  finish();
  await submitting;
  assert.equal(original.submitButton.innerHTML, 'Submit <span>↗</span>');
  assert.equal(original.nodes.get('#submission-success').hidden, false);
});
