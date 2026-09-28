(() => {
  const auth = window.impactAuth;
  const copy = JSON.parse(document.querySelector('#contribution-copy').textContent);
  const form = document.querySelector('#contribute-form');
  if (!form || !auth) return;
  const sourceList = document.querySelector('#source-list');
  const addSource = document.querySelector('#add-source');
  const sourceInputs = () => [...sourceList.querySelectorAll('input')];
  const fields = document.querySelector('#contribute-fields');
  const submitButton = form.querySelector('button[type="submit"]');
  const submitButtonContent = submitButton.innerHTML;
  const result = document.querySelector('#submission-result');
  const success = document.querySelector('#submission-success');
  const reviewPending = document.querySelector('#review-pending');
  const message = document.querySelector('#submission-message');
  const intro = document.querySelector('#contribute-intro');
  const pr = document.querySelector('#submission-pr');
  const storageKey = `impact-draft:v2:${new URL(document.body.dataset.base, location.href).pathname}`;
  let draft, busy = false, timer, polls = 0;
  // Duplicated tabs copy sessionStorage once, but later draft edits stay in their own tab.
  try { draft = JSON.parse(sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey)); } catch {}
  if (draft?.receipt?.status === 'submitted') {
    draft = null;
    try { sessionStorage.removeItem(storageKey); } catch {}
  }
  if (!draft || typeof draft !== 'object' || !draft.submission_id) draft = { submission_id: crypto.randomUUID() };
  function save() {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(draft));
      localStorage.removeItem(storageKey); // Migrate drafts saved before tab-local storage.
    } catch {}
  }
  function readForm() {
    const data = new FormData(form);
    const record = { title: data.get('title').trim(), description: data.get('description').trim(),
      occurred_by: data.get('occurred_by').replaceAll('-', '/'),
      sources: data.getAll('sources').map(s => s.trim()).filter(Boolean),
      submitter_is_contributor: data.get('submitter_is_contributor') === 'true' };
    if (data.get('image').trim()) record.image = data.get('image').trim();
    return { record };
  }
  function rememberForm() {
    if (!draft) return;
    const data = new FormData(form);
    draft.values = { ...Object.fromEntries(data), sources: data.getAll('sources') };
    if (draft.receipt?.status === 'failed') { draft.submission_id = crypto.randomUUID(); delete draft.receipt; }
    save();
  }
  function showError(text) {
    result.hidden = false; success.hidden = true; result.classList.remove('is-success');
    message.hidden = false; message.textContent = text;
  }
  function showReceipt(receipt) {
    draft.receipt = receipt; draft.submission_id = receipt.submission_id; save();
    result.hidden = false;
    const accepted = receipt.status === 'submitted';
    if (accepted) { try { sessionStorage.removeItem(storageKey); } catch {} }
    form.hidden = accepted || receipt.status === 'pending';
    const confirmed = accepted;
    intro.hidden = accepted;
    success.hidden = !confirmed;
    result.classList.toggle('is-success', confirmed);
    message.hidden = confirmed;
    const reviewURL = receipt.pr_url || receipt.issue_url;
    reviewPending.hidden = !!reviewURL;
    pr.hidden = !reviewURL; if (reviewURL) pr.href = reviewURL;
    message.textContent = receipt.status === 'failed' ? copy['Failed submission message'] :
      confirmed ? '' : copy['Pending submission message'].replace('{reference}', receipt.submission_id);
    clearTimeout(timer);
    if (!receipt.pr_url && !receipt.review_error && receipt.status !== 'failed' && polls++ < 12) timer = setTimeout(refresh, 10000);
  }
  async function refresh() {
    if (busy || !draft?.receipt || draft.owner !== auth.session?.user.id) return;
    busy = true;
    const owner = auth.session.user.id;
    const submissionId = draft.submission_id;
    try {
      const receipt = await auth.requestSubmission(null, submissionId);
      if (owner === auth.session?.user.id && draft.submission_id === submissionId) showReceipt(receipt);
    }
    catch {} // Keep the receipt visible if background refresh fails.
    finally { busy = false; }
  }
  function paintAuth() {
    if (!auth.session) { clearTimeout(timer); form.hidden = false; intro.hidden = false; result.hidden = true; return; }
    if (draft.receipt && draft.owner === auth.session.user.id) { showReceipt(draft.receipt); refresh(); }
  }
  function labelSources() {
    const rows = [...sourceList.children];
    rows.forEach((row, index) => {
      const input = row.querySelector('input');
      input.id = index === 0 ? 'impact-sources' : `impact-source-${index + 1}`;
      input.setAttribute('aria-label', `Source ${index + 1}`);
      input.required = true;
      const remove = row.querySelector('button');
      remove.hidden = rows.length === 1;
      remove.setAttribute('aria-label', `Remove source ${index + 1}`);
    });
    addSource.disabled = rows.length >= 20;
  }
  function appendSource(value = '') {
    const row = sourceList.firstElementChild.cloneNode(true);
    row.querySelector('input').value = value;
    row.querySelector('input').setCustomValidity('');
    sourceList.append(row); labelSources();
    return row.querySelector('input');
  }
  function restoreSources(values) {
    // Preserve drafts saved by the earlier multiline field.
    const links = Array.isArray(values) ? values : typeof values === 'string' ? values.split(/\r?\n/).filter(Boolean) : [];
    sourceList.querySelector('input').value = links[0] || '';
    for (const link of links.slice(1, 20)) appendSource(link);
    labelSources();
  }
  addSource.addEventListener('click', () => {
    if (sourceInputs().length >= 20) return;
    appendSource().focus(); rememberForm();
  });
  sourceList.addEventListener('click', event => {
    const remove = event.target.closest('.source-remove');
    if (!remove || sourceInputs().length === 1) return;
    const index = [...sourceList.children].indexOf(remove.parentElement);
    remove.parentElement.remove(); labelSources(); rememberForm();
    sourceInputs()[Math.min(index, sourceInputs().length - 1)].focus();
  });
  restoreSources(draft.values?.sources);
  for (const [name, value] of Object.entries(draft.values || {})) {
    if (name === 'sources') continue;
    const field = form.elements.namedItem(name);
    if (field?.type === 'checkbox') field.checked = value === 'on';
    else if (field && typeof value === 'string') field.value = name === 'occurred_by' ? value.replaceAll('-', '/') : value;
  }
  save();
  const imageInput = form.elements.image;
  const imagePreview = document.querySelector('#image-preview');
  const imageStatus = document.querySelector('#image-status');
  let imageTimer, imageSequence = 0;
  function previewImage() {
    const sequence = ++imageSequence;
    clearTimeout(imageTimer);
    imagePreview.hidden = true; imagePreview.removeAttribute('src');
    const url = imageInput.value.trim();
    imageStatus.hidden = !url;
    if (!url) return;
    try { if (new URL(url).protocol !== 'https:') throw Error(); }
    catch { imageStatus.textContent = copy['Image link warning']; return; }
    imageStatus.textContent = copy['Image checking message'];
    imageTimer = setTimeout(() => {
      const probe = new Image();
      const timeout = setTimeout(() => finish(false), 10000);
      function finish(ok) {
        clearTimeout(timeout); probe.onload = null; probe.onerror = null;
        if (sequence !== imageSequence) return;
        imageStatus.textContent = ok ? '' : copy['Image unavailable message'];
        imageStatus.hidden = ok;
        if (ok) { imagePreview.src = url; imagePreview.hidden = false; }
      }
      probe.onload = () => finish(probe.naturalWidth > 0);
      probe.onerror = () => finish(false);
      probe.src = url;
    }, 450);
  }
  imageInput.addEventListener('input', previewImage);
  previewImage();
  form.addEventListener('input', () => {
    form.elements.occurred_by.setCustomValidity('');
    sourceInputs().forEach(input => input.setCustomValidity(''));
    rememberForm();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const payload = readForm();
    const dateValue = form.elements.occurred_by.value;
    const parsedDate = new Date(`${dateValue.replaceAll('/', '-')}T00:00:00Z`);
    const validDate = /^\d{4}\/\d{2}\/\d{2}$/.test(dateValue) &&
      !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === dateValue.replaceAll('/', '-');
    form.elements.occurred_by.setCustomValidity(validDate ? '' : copy['Invalid date message']);
    sourceInputs().forEach(input => {
      let valid = false;
      try { const url = new URL(input.value.trim()); valid = ['http:', 'https:'].includes(url.protocol) && !/\s/.test(input.value.trim()); } catch {}
      input.setCustomValidity(valid ? '' : copy['Invalid link message']);
    });
    if (!form.reportValidity()) return;
    rememberForm();
    const session = await auth.requireSession(); if (!session || busy) return;
    if (draft.owner && draft.owner !== session.user.id) { draft.submission_id = crypto.randomUUID(); delete draft.receipt; }
    const serialized = JSON.stringify(payload);
    // An unsubmitted draft can carry an ID copied from another tab. Reserve a new
    // one at its first attempt; only retries of the same payload reuse an ID.
    if (draft.lastPayload !== serialized) { draft.submission_id = crypto.randomUUID(); delete draft.receipt; }
    draft.lastPayload = serialized; draft.owner = session.user.id; save();
    busy = true; fields.disabled = true; result.hidden = true;
    submitButton.textContent = copy['Submitting message'];
    submitButton.setAttribute('aria-busy', 'true');
    const owner = session.user.id;
    try {
      let receipt;
      try {
        receipt = await auth.requestSubmission({ ...payload, submission_id: draft.submission_id });
      } catch (error) {
        // A definite ID conflict means this payload was not accepted. Recover
        // drafts from the old shared storage without retrying uncertain failures.
        if (error.status !== 409) throw error;
        draft.submission_id = crypto.randomUUID(); delete draft.receipt; save();
        receipt = await auth.requestSubmission({ ...payload, submission_id: draft.submission_id });
      }
      if (owner === auth.session?.user.id) { polls = 0; showReceipt(receipt); result.focus(); }
    } catch (error) { showError(error.message); }
    finally {
      busy = false; fields.disabled = false;
      submitButton.innerHTML = submitButtonContent;
      submitButton.removeAttribute('aria-busy');
    }
  });
  function resetCompletedForm() {
    if (draft.receipt?.status !== 'submitted') return;
    clearTimeout(timer); polls = 0;
    draft = { submission_id: crypto.randomUUID() }; save();
    form.reset();
    [...sourceList.children].slice(1).forEach(row => row.remove());
    labelSources(); previewImage();
    form.hidden = false; intro.hidden = false; result.hidden = true;
    success.hidden = true; pr.hidden = true;
  }
  document.querySelectorAll('a[href]').forEach(link => {
    if (new URL(link.href).pathname !== location.pathname) return;
    link.addEventListener('click', event => {
      if (draft.receipt?.status !== 'submitted') return;
      event.preventDefault(); resetCompletedForm(); form.elements.title.focus();
    });
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) resetCompletedForm();
  });
  window.addEventListener('impact-auth', paintAuth);
  auth.ready.then(paintAuth);
})();
