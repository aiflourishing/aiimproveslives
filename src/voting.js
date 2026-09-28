(() => {
  const base = new URL(document.body.dataset.base, location.href);
  const dialog = document.querySelector('#signin');
  const authStatus = document.querySelector('#auth-status');
  const providers = [...dialog.querySelectorAll('#google-signin, #github-signin')];
  const signout = document.querySelector('#signout');
  const status = document.querySelector('#vote-status');
  let client, session, config, busy = false;
  const returnKey = `auth-return:${base.href}`;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  window.impactAuth = {
    ready,
    get session() { return session; },
    async requireSession() { await ready; if (!session) openSignin(); return session; },
    async requestSubmission(body, id) {
      await ready;
      if (config?.submissionsEnabled === false) throw Error('Submissions aren’t available yet. Your draft is saved.');
      if (!client) throw Error('Sign-in is unavailable. Please try again later.');
      const { data, error } = await client.auth.getSession();
      if (error || !data.session) { session = null; openSignin(); throw Error('Please sign in to submit. Your draft is saved.'); }
      const url = new URL('functions/v1/submit-impact', config.url.replace(/\/?$/, '/'));
      if (id) url.searchParams.set('id', id);
      let response;
      try { response = await fetch(url, {
        method: id ? 'GET' : 'POST',
        headers: { apikey: config.publishableKey, Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
        body: id ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)
      }); } catch { throw Error('Couldn’t connect. Your draft is saved. Please try again.'); }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) { session = null; openSignin(); }
        const failure = Error(result.error || 'Couldn’t submit. Your draft is saved. Please try again.');
        failure.status = response.status;
        throw failure;
      }
      return result;
    }
  };
  let votes = new Map();
  let scoreRequest = 0;
  let state = 'loading';
  let toastTimer;
  const showStatus = (message, quiet = false) => {
    status.classList.toggle('sr-only', quiet);
    status.textContent = message; status.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { status.hidden = true; }, 6000);
  };
  function openSignin() {
    authStatus.textContent = state === 'ready' || session ? '' :
      state === 'loading' ? 'Connecting…' : 'Sign-in is unavailable. Please try again.';
    document.querySelector('#signin-title').textContent = session ? 'Account' : 'Sign in';
    providers.forEach(button => { button.hidden = !!session || state !== 'ready'; button.disabled = false; });
    signout.hidden = !session;
    if (!dialog.open) dialog.showModal();
  }
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  document.addEventListener('click', async event => {
    if (event.target.closest('[data-signin]')) { await ready; openSignin(); }
  });
  function paintVotes() {
    document.querySelectorAll('[data-reaction]').forEach(button => {
      const id = button.closest('[data-impact]').dataset.impact;
      button.setAttribute('aria-pressed', String(votes.get(id) === button.dataset.reaction));
      button.disabled = busy;
    });
  }
  async function refreshVotes() {
    if (!session) { votes.clear(); paintVotes(); return; }
    if (!document.querySelector('[data-reaction]')) return;
    const { data, error } = await client.rpc('my_reactions');
    if (error) throw error;
    votes = new Map(data.map(row => [row.impact_id, row.reaction === 'improved' ? 'heart' : row.reaction]));
    paintVotes();
  }
  async function publicRanking(name) {
    try {
      const response = await fetch(new URL(`rest/v1/rpc/${name}`, config.url.replace(/\/?$/, '/')), {
        method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw Error('Ranking unavailable');
      const data = await response.json();
      if (!Array.isArray(data)) throw Error('Invalid ranking');
      return { data, error: null };
    } catch (error) { return { data: null, error }; }
  }
  async function refreshRanking(updateOrder = true) {
    if (!document.querySelector('[data-reaction]')) return;
    const request = ++scoreRequest;
    const { data, error } = await publicRanking('impact_scores');
    if (request !== scoreRequest) return;
    if (!error) {
      const scores = new Map(data.map(row => [row.impact_id, row.score]));
      document.querySelectorAll('[data-score-for]').forEach(label => {
        const score = Number(scores.get(label.dataset.scoreFor));
        label.hidden = !Number.isFinite(score) || score <= 5;
        label.textContent = label.hidden ? '' : String(score);
        label.setAttribute('aria-label', label.hidden ? 'Score hidden' : `Score ${score}`);
      });
    }
    if (updateOrder && document.querySelector('#impacts')) {
      // Older databases still provide ordering while the aggregate RPC is being deployed.
      const ranking = error ? await publicRanking('ranked_impacts') : { data, error: null };
      window.dispatchEvent(new CustomEvent('impact-ranking', { detail: {
        ids: ranking.error ? null : ranking.data.map(row => row.impact_id),
        rows: error ? null : data,
        message: 'Couldn’t load Top. Showing newest first.'
      }}));
    }
    paintVotes();
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-reaction]');
    if (!button) return;
    event.preventDefault();
    await ready;
    if (busy) return;
    if (!client || !session) { openSignin(); return; }
    const id = button.closest('[data-impact]').dataset.impact;
    const reaction = votes.get(id) === button.dataset.reaction ? null : button.dataset.reaction;
    busy = true; paintVotes();
    try {
      const { error } = await client.rpc('set_reaction', { p_impact: id, p_reaction: reaction });
      if (error) throw error;
      reaction ? votes.set(id, reaction) : votes.delete(id);
      showStatus(reaction ? 'Vote saved.' : 'Vote removed.', true);
      // Read authoritative totals without moving cards while someone is voting.
      await refreshRanking(false).catch(() => {});
    } catch {
      showStatus('Couldn’t save your vote. Try again.');
    } finally { busy = false; paintVotes(); }
  });
  providers.forEach(button => button.addEventListener('click', async () => {
    providers.forEach(item => { item.disabled = true; });
    authStatus.textContent = 'Opening sign-in…';
    // Keep the existing allowlisted callback, then restore the page that requested sign-in.
    try { sessionStorage.setItem(returnKey, location.href); } catch {}
    // A clean callback URL avoids carrying arbitrary query parameters into auth.
    const { error } = await client.auth.signInWithOAuth({
      provider: button.id === 'google-signin' ? 'google' : 'github',
      options: { redirectTo: new URL('index.html', base).href }
    });
    if (error) {
      authStatus.textContent = 'Could not open sign-in. Please try again.';
      providers.forEach(item => { item.disabled = false; });
    }
  }));
  signout.addEventListener('click', async () => {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) { authStatus.textContent = 'Could not sign out. Please try again.'; return; }
    session = null; votes.clear(); paintVotes(); dialog.close();
    window.dispatchEvent(new Event('impact-auth'));
  });
  async function start() {
    try {
      const response = await fetch(new URL('voting-config.json', base), { cache: 'no-store' });
      if (!response.ok) throw Error('Configuration unavailable');
      config = await response.json();
      if (!config.url || !config.publishableKey) {
        state = 'unconfigured'; return;
      }
      // Public rankings start before downloading the sign-in SDK or resolving a session.
      refreshRanking().catch(() => {});
      if (document.querySelector('[data-reaction]')) {
        const refreshVisibleScores = () => {
          if (document.visibilityState === 'visible') refreshRanking(false).catch(() => {});
        };
        setInterval(refreshVisibleScores, 30000);
        document.addEventListener('visibilitychange', refreshVisibleScores);
      }
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = new URL('vendor/supabase.js', base).href;
        script.onload = resolve; script.onerror = reject; document.head.append(script);
      });
      client = window.supabase.createClient(config.url, config.publishableKey, {
        auth: { flowType: 'pkce', detectSessionInUrl: true }
      });
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      session = data.session;
      state = 'ready';
      try {
        const saved = sessionStorage.getItem(returnKey);
        sessionStorage.removeItem(returnKey);
        if (session && saved) {
          const target = new URL(saved);
          if (target.origin === base.origin && target.pathname.startsWith(base.pathname) && target.href !== location.href) { location.replace(target.href); return; }
        }
      } catch {}
      client.auth.onAuthStateChange((_event, nextSession) => {
        session = nextSession;
        if (session && dialog.open) dialog.close();
        window.dispatchEvent(new Event('impact-auth'));
        // Avoid awaiting another auth call inside the SDK callback.
        setTimeout(() => refreshVotes().catch(() => showStatus('Could not load your reactions.')), 0);
      });
      // Voting failures must not disable a working sign-in or contribution form.
      refreshVotes().catch(() => showStatus('Could not load your reactions.'));
    } catch {
      state = 'error';
      if (!config?.url) window.dispatchEvent(new CustomEvent('impact-ranking', { detail: { ids: null } }));
      if (document.querySelector('[data-reaction]')) showStatus('Voting is temporarily unavailable.');
    } finally { resolveReady(); window.dispatchEvent(new Event('impact-auth')); }
  }
  start();
})();
