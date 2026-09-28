// Standard web APIs keep the handler testable without a deployed Supabase project.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function validateSubmission(input) {
  if (!input || !uuid.test(input.submission_id)) throw new RequestError('Invalid submission identifier.');
  const value = input.record;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError('Complete the impact form.');
  if (Object.keys(value).some(key => !['title','description','occurred_by','sources','image','submitter_is_contributor'].includes(key))) throw new RequestError('Unexpected impact field.');
  const text = (key, max) => {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > max) throw new RequestError(`Check ${key.replaceAll('_', ' ')}.`);
    return value[key].trim();
  };
  const validURL = (value, image = false) => {
    try {
      const parsed = new URL(value);
      return typeof value === 'string' && value.length <= 2048 && !/\s/.test(value) &&
        (image ? parsed.protocol === 'https:' : ['http:', 'https:'].includes(parsed.protocol)) &&
        !!parsed.hostname && parsed.port !== '0' && !parsed.username && !parsed.password;
    } catch { return false; }
  };
  const date = text('occurred_by', 10);
  const iso = date.replaceAll('/', '-');
  const parsed = new Date(iso + 'T00:00:00Z');
  if (!/^[0-9]{4}\/[0-9]{2}\/[0-9]{2}$/.test(date) || date.startsWith('0000') ||
      !Number.isFinite(+parsed) || parsed.toISOString().slice(0,10) !== iso) throw new RequestError('Enter a valid impact date.');
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 20 || value.sources.some(url => !validURL(url))) throw new RequestError('Add 1–20 valid source links.');
  if (typeof value.submitter_is_contributor !== 'boolean') throw new RequestError('Answer whether you contributed to this impact.');
  const record = { title: text('title', 180), description: text('description', 10000), occurred_by: date,
    sources: [...new Set(value.sources)], submitter_is_contributor: value.submitter_is_contributor };
  if (value.image) {
    if (!validURL(value.image, true)) throw new RequestError('Use a direct HTTPS image link.');
    record.image = value.image;
  }
  return record;
}
export function createHandler(env, fetcher = fetch) {
  const origins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const repo = env.GITHUB_REPOSITORY || 'aiflourishing/aiimproveslives';
  const githubBase = `https://api.github.com/repos/${repo}`;
  const githubHeaders = { Authorization: `Bearer ${(env.GITHUB_SUBMISSIONS_TOKEN || env.GITHUB_ISSUES_TOKEN)}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function rpc(name, body) {
    const response = await fetcher(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      if (detail.message === 'Submission limit reached') throw new RequestError('Please wait a minute between submissions. You can submit up to 10 impacts per day.', 429);
      if (detail.message === 'Submission identifier already used') throw new RequestError('This submission has already been sent. Start a new contribution to change it.', 409);
      throw new Error('Receipt storage unavailable');
    }
    return response.status === 204 ? null : response.json();
  }
  function receiptResult(receipt) {
    return { submission_id: receipt.id, status: receipt.status,
      pr_url: receipt.pr_number ? `https://github.com/${repo}/pull/${receipt.pr_number}` : null,
      issue_url: receipt.issue_number ? `https://github.com/${repo}/issues/${receipt.issue_number}` : null };
  }
  async function github(path, method = 'GET', body, allow404 = false) {
    const response = await fetcher(`${githubBase}/${path}`, { method, headers: githubHeaders,
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const error = new Error('GitHub request failed');
      error.definite = response.status >= 400 && response.status < 500;
      throw error;
    }
    return response.json();
  }
  const branchFor = receipt => `codex/submission-${receipt.id}`;
  async function findPR(receipt) {
    const owner = repo.split('/')[0];
    const rows = await github(`pulls?state=all&head=${encodeURIComponent(owner + ':' + branchFor(receipt))}&per_page=100`);
    return rows.find(pr => pr.head?.ref === branchFor(receipt) && pr.head?.repo?.full_name === repo);
  }
  async function finishPR(receipt, user, pr) {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error('Invalid PR response');
    await rpc('finish_pr_submission', { p_user: user.id, p_id: receipt.id, p_pr: pr.number });
    return receiptResult({ ...receipt, status: 'submitted', pr_number: pr.number });
  }
  async function createPR(receipt, record) {
    const branch = branchFor(receipt);
    const base = await github('git/ref/heads/main');
    const existing = await github(`git/ref/heads/${branch}`, 'GET', undefined, true);
    const content = JSON.stringify({ id: receipt.id, ...record }, null, 2) + '\n';
    const decode = encoded => new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/\s/g, '')), char => char.charCodeAt(0)));
    if (existing) {
      const file = await github(`contents/data/impacts/${receipt.id}.json?ref=${existing.object.sha}`);
      if (decode(file.content) !== content) throw new Error('Existing submission branch differs');
    } else {
      const accepted = await github(`contents/data/impacts/${receipt.id}.json?ref=${base.object.sha}`, 'GET', undefined, true);
      if (accepted) throw Object.assign(new Error('Entry identifier already exists'), { definite: true });
      const commit = await github(`git/commits/${base.object.sha}`);
      const tree = await github('git/trees', 'POST', { base_tree: commit.tree.sha,
        tree: [{ path: `data/impacts/${receipt.id}.json`, mode: '100644', type: 'blob', content }] });
      const proposed = await github('git/commits', 'POST', { message: `Add entry ${receipt.id}`, tree: tree.sha, parents: [base.object.sha] });
      await github('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: proposed.sha });
    }
    // Fetch review questions only from the trusted main commit.
    const template = await github(`contents/.github/pull_request_template.md?ref=${base.object.sha}`);
    const checklist = decode(template.content);
    // HTML escaping keeps contributor text from introducing checklist headings or rows.
    const escape = value => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char])).replaceAll('`', '&#96;');
    const url = value => value.replace(/[<>\s()]/g, char => encodeURIComponent(char));
    const preview = `<h2>${escape(record.title)}</h2>\n\n<p>${escape(record.description).replaceAll('\n', '<br>')}</p>\n\n` +
      `### Entry occurred by\n\n${record.occurred_by}\n\n### Supporting sources\n\n${record.sources.map(link => `- <${url(link)}>`).join('\n')}\n\n` +
      `### Did the submitter contribute?\n\n${record.submitter_is_contributor ? 'Yes' : 'No'}\n\n` +
      (record.image ? `### Image preview\n\n![Submitted entry image](<${url(record.image)}>)\n\n` : '');
    return github('pulls', 'POST', { title: record.title, head: branch, base: 'main',
      body: `Submitted through the website.\n\n${checklist}\n\n${preview}<!-- website-submission:${receipt.id} -->` });
  }
  return async request => {
    const origin = request.headers.get('Origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info' };
    if (origins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !origins.includes(origin)) return reply({ error: 'Origin not allowed.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!['GET','POST'].includes(request.method)) return reply({ error: 'Method not allowed.' }, 405);
    try {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !(env.GITHUB_SUBMISSIONS_TOKEN || env.GITHUB_ISSUES_TOKEN) || !origins.length) throw new Error('Missing configuration');
      const authorization = request.headers.get('Authorization') || '';
      if (!/^Bearer \S+$/.test(authorization)) throw new RequestError('Please sign in to contribute.', 401);
      const auth = await fetcher(`${env.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: authorization }, signal: AbortSignal.timeout(15000)
      });
      if (!auth.ok) throw new RequestError('Please sign in again to contribute.', 401);
      const user = await auth.json();
      if (!uuid.test(user.id) || !user.email_confirmed_at || user.is_anonymous) throw new RequestError('Please use a verified account to contribute.', 403);
      if (request.method === 'GET') {
        const id = new URL(request.url).searchParams.get('id');
        if (!uuid.test(id || '')) throw new RequestError('Invalid submission identifier.');
        const receipt = await rpc('submission_receipt', { p_user: user.id, p_id: id });
        if (!receipt) throw new RequestError('Submission not found.', 404);
        const result = receiptResult(receipt);
        if (receipt.status === 'pending' && !receipt.issue_number && !receipt.pr_number) {
          const existing = await findPR(receipt);
          if (existing) return reply(await finishPR(receipt, user, existing));
        }
        if (receipt.issue_number) {
          // Only trusted automation comments can supply the PR link or review status.
          const response = await fetcher(`${githubBase}/issues/${receipt.issue_number}/comments?per_page=100`, { headers: githubHeaders, signal: AbortSignal.timeout(15000) });
          if (response.ok) {
            const comments = (await response.json()).filter(c => c.user?.login === 'github-actions[bot]');
            for (const comment of comments.reverse()) {
              const prefix = `https://github.com/${repo}/pull/`;
              const candidate = (comment.body || '').split(/\s+/).find(word => word.startsWith(prefix) && /^\d+$/.test(word.slice(prefix.length)));
              if (candidate) { result.pr_url = candidate; break; }
              if ((comment.body || '').startsWith('Submission needs changes:') || (comment.body || '').startsWith('Intake automation failed.')) {
                result.review_error = 'The submission needs attention. Open its GitHub Issue for details.'; break;
              }
            }
          }
        }
        return reply(result);
      }
      if (!request.headers.get('Content-Type')?.includes('application/json')) throw new RequestError('Expected JSON.');
      const reader = request.body?.getReader();
      if (!reader) throw new RequestError('Complete the impact form.');
      let length = 0; const chunks = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 60000) { await reader.cancel(); throw new RequestError('Submission is too large.', 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let input;
      try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RequestError('Invalid JSON.'); }
      const record = validateSubmission(input);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(record)));
      const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      const receipt = await rpc('reserve_submission', { p_user: user.id, p_id: input.submission_id, p_hash: hash });
      if (receipt.pr_number || receipt.issue_number) return reply(receiptResult(receipt));
      let existing;
      try { existing = await findPR(receipt); }
      catch (error) {
        // This read precedes every content write, so a failed fresh request is safe to retry.
        if (receipt.fresh) await rpc('finish_pr_submission', { p_user: user.id, p_id: receipt.id, p_pr: null });
        throw error;
      }
      if (existing) return reply(await finishPR(receipt, user, existing));
      // Only the reservation owner creates content; concurrent repeats merely poll.
      if (!receipt.fresh) return reply(receiptResult(receipt), 202);
      let pr;
      try { pr = await createPR(receipt, record); }
      catch (error) {
        if (error.definite) {
          await rpc('finish_pr_submission', { p_user: user.id, p_id: receipt.id, p_pr: null });
          throw new RequestError('GitHub could not accept the submission. Please try again in a minute.', 502);
        }
        // A PR might exist despite a timeout. GET safely recovers its link without creating another.
        return reply(receiptResult(receipt), 202);
      }
      return reply(await finishPR(receipt, user, pr), 201);
    } catch (error) {
      return reply({ error: error instanceof RequestError ? error.message : 'Submissions are temporarily unavailable. Your form has been kept; please try again.' }, error instanceof RequestError ? error.status : 503);
    }
  };
}
