/* Static content works without JavaScript. Rankings come only from the server. */
(() => {
  // Sharing is public and independent of the reaction sign-in flow.
  document.querySelectorAll('[data-share-url], [data-copy-url]').forEach(shareButton => {
    shareButton.hidden = false;
    const control = shareButton.closest('.share-control');
    const shareStatus = control.querySelector('.share-toast');
    const fallback = control.querySelector('.share-fallback');
    const input = fallback.querySelector('input');
    let toastTimer;
    input.value = shareButton.dataset.shareUrl || shareButton.dataset.copyUrl;
    input.addEventListener('click', () => input.select());
    shareButton.addEventListener('click', async () => {
      shareButton.disabled = true;
      clearTimeout(toastTimer);
      shareStatus.hidden = true;
      shareStatus.textContent = '';
      fallback.hidden = true;
      try {
        await navigator.clipboard.writeText(input.value);
        shareStatus.textContent = 'Link copied';
        shareStatus.hidden = false;
        toastTimer = setTimeout(() => { shareStatus.hidden = true; }, 2500);
      } catch {
        fallback.hidden = false;
        input.focus();
        input.select();
      } finally {
        shareButton.disabled = false;
      }
    });
  });
  const search = document.querySelector('#search');
  if (search) {
    const form = search.closest('form');
    const clear = form.querySelector('button');
    const grid = document.querySelector('#impacts .card-grid');
    const cards = [...grid.querySelectorAll('.card')].sort((a, b) => Number(a.dataset.newOrder) - Number(b.dataset.newOrder));
    const buttons = [...document.querySelectorAll('[data-sort]')];
    const params = new URLSearchParams(location.search);
    let order = params.get('sort') === 'new' ? 'new' : 'top';
    let ranking = null;
    function rankedIds(rows) {
      const grouped = rows.every(row => Number.isFinite(row.vote_rank));
      // Older responses hide small totals: preserve their server order instead of treating null as zero.
      if (!grouped && rows.some(row => row.score === null)) return rows.map(row => row.impact_id);
      const scores = new Map(rows.map(row => [row.impact_id, grouped ? -row.vote_rank : Number(row.score) || 0]));
      // Cards already follow newest impact date; stable sorting preserves that for ties.
      const fallback = grouped ? -Infinity : 0;
      return [...cards].sort((a, b) => (scores.get(b.dataset.impact) ?? fallback) - (scores.get(a.dataset.impact) ?? fallback)).map(card => card.dataset.impact);
    }
    const initial = document.querySelector('#initial-ranking');
    if (initial) { try { ranking = JSON.parse(initial.textContent); } catch {} }
    const rankingCacheKey = `impact-ranking:v1:${new URL(document.body.dataset.base, location.href).href}`;
    try {
      const cached = JSON.parse(localStorage.getItem(rankingCacheKey));
      if (cached && Date.now() - cached.savedAt < 86400000 && Array.isArray(cached.rows)) {
        ranking = rankedIds(cached.rows);
        const scores = new Map(cached.rows.map(row => [row.impact_id, row.score]));
        document.querySelectorAll('[data-score-for]').forEach(label => {
          const score = Number(scores.get(label.dataset.scoreFor));
          label.hidden = !Number.isFinite(score) || score <= 5;
          label.textContent = label.hidden ? '' : String(score);
          label.setAttribute('aria-label', label.hidden ? 'Score hidden' : `Score ${score}`);
        });
      }
    } catch {}
    let rankMessage = '';
    search.value = params.get('q') || '';
    function filter(updateURL = true) {
      const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const ranks = new Map((ranking || []).map((id, index) => [id, index]));
      const ordered = order === 'top' && ranking !== null
        ? [...cards].sort((a, b) => (ranks.get(a.dataset.impact) ?? Infinity) - (ranks.get(b.dataset.impact) ?? Infinity))
        : cards;
      grid.append(...ordered);
      let count = 0;
      cards.forEach(card => {
        card.hidden = !terms.every(term => card.dataset.search.includes(term));
        if (!card.hidden) count++;
      });
      const empty = document.querySelector('#impacts .empty');
      empty.hidden = count > 0;
      empty.textContent = cards.length ? 'No results. Try a different search.' : 'No listings yet.';
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sort === order)));
      const status = document.querySelector('#ranking-status');
      status.hidden = !rankMessage || order !== 'top' || ranking !== null || !cards.length;
      status.textContent = rankMessage;
      clear.hidden = !search.value;
      document.querySelector('#search-status').textContent = `${count} ${count === 1 ? 'result' : 'results'} found.`;
      if (updateURL) {
        const url = new URL(location.href);
        search.value ? url.searchParams.set('q', search.value) : url.searchParams.delete('q');
        order === 'new' ? url.searchParams.set('sort', 'new') : url.searchParams.delete('sort');
        url.searchParams.delete('year');
        history.replaceState(null, '', url);
      }
    }
    buttons.forEach(button => button.addEventListener('click', () => { order = button.dataset.sort; filter(); }));
    window.addEventListener('impact-ranking', event => {
      if (event.detail.ids !== null) ranking = event.detail.ids;
      if (event.detail.rows) {
        ranking = rankedIds(event.detail.rows);
        try { localStorage.setItem(rankingCacheKey, JSON.stringify({ savedAt: Date.now(), rows: event.detail.rows })); } catch {}
      }
      rankMessage = event.detail.message || 'Couldn’t load Top. Showing newest first.';
      filter(false);
    });
    search.addEventListener('input', () => filter());
    form.addEventListener('submit', event => event.preventDefault());
    form.addEventListener('reset', event => { event.preventDefault(); search.value = ''; filter(); search.focus(); });
    filter(false);
  }
  // Replace broken card images with the brand placeholder.
  document.addEventListener('error', event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.classList.contains('card-image')) {
      const placeholder = document.createElement('div');
      placeholder.className = 'card-image image-empty';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.innerHTML = '<span class="brand-mark">aı</span>';
      img.replaceWith(placeholder);
    } else img.hidden = true;
  }, true);
})();

// Refresh the local home preview when its approved catalog or template changes.
if (['localhost', '127.0.0.1'].includes(location.hostname) && document.querySelector('#impacts')) {
  (async () => {
    let version;
    async function checkBuild() {
      try {
        const response = await fetch('/__preview_version', { cache: 'no-store' });
        if (!response.ok) return false;
        const current = (await response.json()).version;
        if (version !== undefined && current !== version) { location.reload(); return false; }
        version = current;
        return true;
      } catch { return false; }
    }
    if (await checkBuild()) {
      const timer = setInterval(async () => { if (!await checkBuild()) clearInterval(timer); }, 5000);
    }
  })();
}
