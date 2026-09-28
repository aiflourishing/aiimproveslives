import { run } from '../_shared/review-checklist.mjs';

export function createHandler(env, fetcher = fetch) {
  const token = env.GITHUB_SUBMISSIONS_TOKEN || env.GITHUB_ISSUES_TOKEN;
  return async request => {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!env.GITHUB_WEBHOOK_SECRET || !token) return new Response('Not configured', { status: 503 });
    const raw = await request.text();
    if (raw.length > 1000000) return new Response('Too large', { status: 413 });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = 'sha256=' + [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const supplied = request.headers.get('x-hub-signature-256') || '';
    let difference = signature.length ^ supplied.length;
    for (let n = 0; n < signature.length; n++) difference |= signature.charCodeAt(n) ^ (supplied.charCodeAt(n) || 0);
    if (difference) return new Response('Invalid signature', { status: 401 });
    let payload;
    try { payload = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (request.headers.get('x-github-event') === 'ping') return new Response('OK');
    if (request.headers.get('x-github-event') !== 'pull_request' || !['opened','edited','synchronize','reopened','ready_for_review'].includes(payload.action)) return new Response('Ignored');
    if (payload.action === 'edited' && !payload.changes?.body) return new Response('Ignored');
    const repo = env.GITHUB_REPOSITORY || 'aiflourishing/aiimproveslives';
    if (payload.repository?.full_name !== repo || !Number.isSafeInteger(payload.pull_request?.number)) return new Response('Wrong repository', { status: 400 });
    const base = `https://api.github.com/repos/${repo}`;
    async function api(path, method = 'GET', body) {
      const response = await fetcher(base + path, { method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('GitHub verification unavailable');
      return response.json();
    }
    const github = {
      rest: {
        pulls: {
          get: async ({ pull_number }) => ({ data: await api(`/pulls/${pull_number}`) }),
          listFiles: 'files'
        },
        repos: { createCommitStatus: ({ sha, context, state, description }) => api(`/statuses/${sha}`, 'POST', { context, state, description }) }
      },
      paginate: async (_, { pull_number }) => {
        const files = [];
        for (let page = 1; page <= 30; page++) {
          const rows = await api(`/pulls/${pull_number}/files?per_page=100&page=${page}`);
          files.push(...rows);
          if (rows.length < 100) return files;
        }
        throw new Error('Too many changed files to verify');
      }
    };
    try {
      const [owner, repository] = repo.split('/');
      await run({ github, context: { repo: { owner, repo: repository }, payload }, core: { setFailed() {} } });
      return new Response('Verified');
    } catch {
      // Non-2xx makes failed webhook deliveries visible; Actions remains a fallback.
      return new Response('Verification temporarily unavailable', { status: 503 });
    }
  };
}
