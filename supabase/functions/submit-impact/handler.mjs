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
export function issueBody(record, id) {
  // Escape backticks inside JSON strings so submitted text cannot introduce another fence.
  const json = JSON.stringify(record, null, 2).replaceAll('`', '\\u0060');
  const escape = value => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char])).replaceAll('`', '&#96;');
  const url = value => value.replace(/[<>\s]/g, char => encodeURIComponent(char));
  const image = record.image ? `![Submitted impact image](<${url(record.image)}>)\n\n` : '';
  return `## ${escape(record.title)}\n\n${escape(record.description)}\n\n${image}### Impact occurred by\n\n${record.occurred_by}\n\n### Sources\n\n${record.sources.map(link => `- <${url(link)}>`).join('\n')}\n\n### Are you one of the contributor(s)?\n\n${record.submitter_is_contributor ? 'Yes' : 'No'}\n\n<details>\n<summary>Submission data</summary>\n\n### Impact JSON\n\n\`\`\`json\n${json}\n\`\`\`\n\n</details>\n\n<!-- website-submission:${id} -->`;

}
export function createHandler(env, fetcher = fetch) {
  const origins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const repo = env.GITHUB_REPOSITORY || 'aiflourishing/aiimproveslives';
  const githubBase = `https://api.github.com/repos/${repo}`;
  const githubHeaders = { Authorization: `Bearer ${env.GITHUB_ISSUES_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
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
      issue_url: receipt.issue_number ? `https://github.com/${repo}/issues/${receipt.issue_number}` : null };
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
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.GITHUB_ISSUES_TOKEN || !origins.length) throw new Error('Missing configuration');
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
      if (!receipt.fresh) return reply(receiptResult(receipt));
      let response;
      try {
        response = await fetcher(`${githubBase}/issues`, { method: 'POST', headers: githubHeaders,
          body: JSON.stringify({ title: `[Impact] ${record.title}`, body: issueBody(record, receipt.id) }), signal: AbortSignal.timeout(15000) });
      } catch {
        // The request might have reached GitHub. Never blindly repeat a content-creating call.
        return reply(receiptResult(receipt), 202);
      }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          await rpc('finish_submission', { p_user: user.id, p_id: receipt.id, p_issue: null });
          throw new RequestError('GitHub could not accept the submission. Please try again in a minute.', 502);
        }
        return reply(receiptResult(receipt), 202);
      }
      const issue = await response.json();
      if (!Number.isSafeInteger(issue.number) || issue.number < 1) return reply(receiptResult(receipt), 202);
      await rpc('finish_submission', { p_user: user.id, p_id: receipt.id, p_issue: issue.number });
      return reply(receiptResult({ ...receipt, status: 'submitted', issue_number: issue.number }), 201);
    } catch (error) {
      return reply({ error: error instanceof RequestError ? error.message : 'Submissions are temporarily unavailable. Your form has been kept; please try again.' }, error instanceof RequestError ? error.status : 503);
    }
  };
}
