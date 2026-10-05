const api = globalThis.browser ?? globalThis.chrome;
const $ = (s) => document.querySelector(s);
let tabId = null;
let state = null;

async function send(msg) {
  if (tabId == null) {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;
  }
  return api.tabs.sendMessage(tabId, msg);
}

const shared = globalThis.PageRedlineShared;
let settings = shared.normalizeSettings(null);

function reasonOf(id) { return id ? (state.reasons || []).find((r) => r.id === id) || null : null; }
function reasonLabel(id) { const r = reasonOf(id); return r ? r.label : id ? `${id} (removed reason)` : ''; }

function flash(text) {
  $('#flash').textContent = text;
  if (text) setTimeout(() => { if ($('#flash').textContent === text) $('#flash').textContent = ''; }, 2000);
}

function toMarkdown() {
  const lines = [`# Edits for ${state.title || state.url}`, '', state.url, ''];
  for (const e of state.edits) {
    const why = [e.reason && reasonLabel(e.reason), e.note].filter(Boolean).join('; ');
    const change = e.replacement ? `~~${e.exact}~~ → ${e.replacement}` : `~~${e.exact}~~ (remove)`;
    lines.push(`- ${change}${why ? ` — _${why}_` : ''}`);
  }
  return lines.join('\n') + '\n';
}

function render() {
  const edits = state.edits;
  $('#page').textContent = state.title || state.url;
  $('#page').title = state.url;
  $('#count').textContent = edits.length ? `${edits.length} edit${edits.length === 1 ? '' : 's'}` : '';
  for (const id of ['copy-md', 'copy-json', 'clear']) $('#' + id).hidden = edits.length === 0;
  $('#empty').hidden = edits.length > 0;
  if (!edits.length) {
    $('#empty').innerHTML = 'No edits on this page yet.<br><br>Select text on the page, right-click, and choose <code>Mark as invalid…</code>.';
  }
  const list = $('#list');
  list.textContent = '';
  for (const e of edits) {
    const li = document.createElement('li');
    li.dataset.id = e.id;
    if (!e.anchored) li.classList.add('orphan');
    li.title = e.anchored ? 'Click the text to jump to it on the page' : 'Not found on the page right now';

    const line = document.createElement('div');
    line.className = 'text';
    const del = document.createElement('span'); del.className = 'del'; del.textContent = e.exact;
    const reason = reasonOf(e.reason);
    if (reason) { del.style.color = reason.color; del.style.textDecorationColor = reason.color; }
    if (state.replacementColor) line.style.setProperty('--ins', state.replacementColor);
    line.appendChild(del);
    if (e.replacement) {
      const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '→';
      const ins = document.createElement('span'); ins.className = 'ins'; ins.textContent = e.replacement;
      line.append(arrow, ins);
    }
    line.addEventListener('click', () => send({ type: 'pr:open-editor', id: e.id }).catch(() => {}));
    li.appendChild(line);

    const edit = document.createElement('div');
    edit.className = 'edit';
    const repl = document.createElement('input');
    repl.placeholder = 'Replacement (empty = strike through only)';
    repl.value = e.replacement || '';
    repl.addEventListener('change', () => update(e.id, { replacement: repl.value }));
    repl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') repl.blur(); });
    const jump = document.createElement('button');
    jump.textContent = 'Go';
    jump.title = 'Scroll to this edit on the page';
    jump.disabled = !e.anchored;
    jump.addEventListener('click', () => send({ type: 'pr:scroll-to', id: e.id }).catch(() => {}));
    edit.append(repl, jump);
    li.appendChild(edit);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    const sel = document.createElement('select');
    const paint = () => { const r = reasonOf(sel.value); swatch.style.background = r ? r.color : 'transparent'; };
    const none = document.createElement('option'); none.value = ''; none.textContent = '— no reason —'; sel.appendChild(none);
    for (const r of state.reasons) {
      const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; sel.appendChild(o);
    }
    if (e.reason && !reasonOf(e.reason)) {
      const o = document.createElement('option'); o.value = e.reason; o.textContent = reasonLabel(e.reason); sel.appendChild(o);
    }
    sel.value = e.reason || '';
    paint();
    sel.addEventListener('change', () => { paint(); update(e.id, { reason: sel.value }); });
    const note = document.createElement('input');
    note.placeholder = 'Note…';
    note.value = e.note || '';
    note.addEventListener('change', () => update(e.id, { note: note.value }));
    note.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') note.blur(); });
    const rm = document.createElement('button');
    rm.className = 'danger';
    rm.textContent = '✕';
    rm.title = 'Remove this edit';
    rm.addEventListener('click', async () => { await send({ type: 'pr:remove', id: e.id }); await refresh(); });
    meta.append(swatch, sel, note, rm);
    li.appendChild(meta);
    list.appendChild(li);
  }
}

async function update(id, patch) {
  const res = await send({ type: 'pr:update', id, patch });
  if (res && res.edit) {
    const i = state.edits.findIndex((x) => x.id === id);
    if (i >= 0) state.edits[i] = { ...state.edits[i], ...res.edit };
    render();
  }
}

async function refresh() {
  try {
    state = await send({ type: 'pr:list' });
    if (!state || !state.ok) throw new Error('no response');
    document.body.classList.toggle('hidden-marks', state.visible === false);
    render();
  } catch (err) {
    state = null;
    $('#list').textContent = '';
    $('#count').textContent = '';
    for (const id of ['copy-md', 'copy-json', 'clear']) $('#' + id).hidden = true;
    $('#empty').hidden = false;
    $('#empty').innerHTML = 'Page Redline is not running on this page.<br><br>It cannot run on browser pages or extension stores. In Firefox, also check that the extension is allowed to access this site (toolbar icon → Permissions), then reload the page.';
  }
}

async function loadSettings() {
  const r = await api.storage.local.get(shared.SETTINGS_KEY);
  settings = shared.normalizeSettings(r[shared.SETTINGS_KEY]);
  $('#visible').checked = settings.visible;
  document.body.classList.toggle('hidden-marks', !settings.visible);
}
$('#visible').addEventListener('change', async () => {
  settings.visible = $('#visible').checked;
  await api.storage.local.set({ [shared.SETTINGS_KEY]: settings });
  document.body.classList.toggle('hidden-marks', !settings.visible);
});
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[shared.SETTINGS_KEY]) { loadSettings(); refresh(); }
});
$('#reasons').addEventListener('click', () => api.runtime.openOptionsPage());
$('#all-pages').addEventListener('click', () => { api.tabs.create({ url: api.runtime.getURL('pages.html') }); window.close(); });

$('#copy-md').addEventListener('click', async () => { await navigator.clipboard.writeText(toMarkdown()); flash('Copied as Markdown.'); });
$('#copy-json').addEventListener('click', async () => {
  const data = state.edits.map(({ anchored, ...e }) => ({ ...e, reasonLabel: e.reason ? reasonLabel(e.reason) : '' }));
  await navigator.clipboard.writeText(JSON.stringify({ url: state.url, title: state.title, edits: data }, null, 2));
  flash('Copied as JSON.');
});
$('#clear').addEventListener('click', async () => {
  if (!confirm(`Remove all ${state.edits.length} edits on this page?`)) return;
  await send({ type: 'pr:clear' });
  await refresh();
});

loadSettings().then(refresh);
