const api = globalThis.browser ?? globalThis.chrome;
const shared = globalThis.PageRedlineShared;
const $ = (s) => document.querySelector(s);
let settings = shared.normalizeSettings(null);
let pages = [];
const open = new Set(); // page keys whose edit list is expanded

const reasonOf = (id) => (id ? settings.reasons.find((r) => r.id === id) || null : null);
const reasonLabel = (id) => { const r = reasonOf(id); return r ? r.label : id ? `${id} (removed reason)` : ''; };
const shown = (hex) => shared.displayColor(hex, window.matchMedia('(prefers-color-scheme: dark)').matches);
const fmtDate = (t) => (t ? new Date(t).toLocaleString() : '');

function flash(text) {
  $('#flash').textContent = text;
  if (text) setTimeout(() => { if ($('#flash').textContent === text) $('#flash').textContent = ''; }, 3000);
}

async function load() {
  const all = await api.storage.local.get(null);
  settings = shared.normalizeSettings(all[shared.SETTINGS_KEY]);
  pages = shared.pagesFromStorage(all);
  render();
}

function markdownFor(page) {
  const lines = [`# Edits for ${page.title || page.url}`, '', page.url, ''];
  for (const e of page.edits) lines.push(shared.editToMarkdown(e, reasonLabel));
  return lines.join('\n') + '\n';
}

function render() {
  const total = pages.reduce((n, p) => n + p.edits.length, 0);
  $('#stats').textContent = pages.length ? `${total} edit${total === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}` : '';
  $('#empty').hidden = pages.length > 0;
  $('#clear-all').disabled = pages.length === 0;
  $('#export').disabled = pages.length === 0;
  const list = $('#list');
  list.textContent = '';
  for (const page of pages) {
    const details = document.createElement('details');
    details.className = 'page';
    details.open = open.has(page.key);
    details.addEventListener('toggle', () => { if (details.open) open.add(page.key); else open.delete(page.key); });
    const summary = document.createElement('summary');
    const title = document.createElement('div'); title.className = 'title'; title.textContent = page.title || page.url;
    const url = document.createElement('div'); url.className = 'url'; url.textContent = page.url;
    const count = document.createElement('div'); count.className = 'count';
    count.textContent = `${page.edits.length} edit${page.edits.length === 1 ? '' : 's'} · ${fmtDate(page.updatedAt)}`;
    summary.append(title, count, url);
    details.appendChild(summary);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const openBtn = document.createElement('button'); openBtn.textContent = 'Open page';
    openBtn.addEventListener('click', () => api.tabs.create({ url: page.url }));
    const copyBtn = document.createElement('button'); copyBtn.textContent = 'Copy Markdown';
    copyBtn.addEventListener('click', async () => { await navigator.clipboard.writeText(markdownFor(page)); flash(`Copied ${page.edits.length} edits as Markdown.`); });
    const delBtn = document.createElement('button'); delBtn.className = 'danger'; delBtn.textContent = 'Delete edits';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete all ${page.edits.length} edits for\n${page.title || page.url}?`)) return;
      await api.storage.local.remove([shared.PAGE_PREFIX + page.key, shared.META_PREFIX + page.key]);
      await load();
    });
    actions.append(openBtn, copyBtn, delBtn);
    details.appendChild(actions);

    const ul = document.createElement('ul');
    for (const e of page.edits) {
      const li = document.createElement('li');
      const line = document.createElement('div');
      const r = reasonOf(e.reason);
      if (shared.isNote(e)) {
        const icon = document.createElement('span'); icon.className = 'note-icon'; icon.textContent = '✎';
        const txt = document.createElement('span'); txt.className = 'note-text'; txt.textContent = e.exact;
        if (r) txt.style.setProperty('--note', shown(r.color));
        line.append(icon, txt);
      } else {
        const del = document.createElement('span'); del.className = 'del'; del.textContent = e.exact;
        if (r) { del.style.color = shown(r.color); del.style.textDecorationColor = shown(r.color); }
        line.appendChild(del);
      }
      if (!shared.isNote(e) && e.replacement) {
        const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '→';
        const ins = document.createElement('span'); ins.className = 'ins'; ins.textContent = e.replacement;
        ins.style.color = shown(settings.replacementColor); ins.style.textDecorationColor = shown(settings.replacementColor);
        line.append(arrow, ins);
      }
      li.appendChild(line);
      if (e.reason || e.note) {
        const why = document.createElement('div'); why.className = 'why';
        if (r) { const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = r.color; why.appendChild(sw); }
        why.appendChild(document.createTextNode([e.reason && reasonLabel(e.reason), e.note].filter(Boolean).join(' — ')));
        li.appendChild(why);
      }
      ul.appendChild(li);
    }
    details.appendChild(ul);
    list.appendChild(details);
  }
}

function exportAll() {
  const data = {
    format: shared.EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    settings: { reasons: settings.reasons, replacementColor: settings.replacementColor },
    pages: pages.map((p) => ({ url: p.url, title: p.title, updatedAt: p.updatedAt, edits: p.edits })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `page-redline-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  flash(`Exported ${data.pages.reduce((n, p) => n + p.edits.length, 0)} edits from ${data.pages.length} pages.`);
}

// Merge. Reasons first: an incoming reason with an unknown id is added; one with a known id and
// the same label is the same reason; one with a known id but a different label is a collision
// (e.g. a built-in renamed on one machine) - if the local reason is still the untouched default
// it adopts the incoming definition, otherwise the incoming reason gets a fresh id and the
// imported edits are remapped to it. Edits are matched by id, so re-importing changes nothing.
async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { flash('That file is not valid JSON.'); return; }
  if (!data || data.format !== shared.EXPORT_FORMAT || !Array.isArray(data.pages)) { flash('That file is not a Page Redline export.'); return; }
  const all = await api.storage.local.get(null);
  settings = shared.normalizeSettings(all[shared.SETTINGS_KEY]);
  const updates = {};
  const idMap = new Map(); // incoming reason id -> local reason id, when they differ
  let reasonsAdded = 0, reasonsUpdated = 0;
  const sameLabel = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
  const isPristineDefault = (r) => shared.DEFAULT_REASONS.some((d) => d.id === r.id && d.label === r.label && d.color === r.color);
  if (data.settings && Array.isArray(data.settings.reasons)) {
    const incoming = shared.normalizeSettings({ reasons: data.settings.reasons }).reasons;
    for (const r of incoming) {
      const local = settings.reasons.find((x) => x.id === r.id);
      if (!local) { settings.reasons.push({ ...r }); reasonsAdded++; continue; }
      if (sameLabel(local.label, r.label)) continue;
      if (isPristineDefault(local)) { local.label = r.label; local.color = r.color; reasonsUpdated++; continue; }
      const byLabel = settings.reasons.find((x) => sameLabel(x.label, r.label));
      if (byLabel) { idMap.set(r.id, byLabel.id); continue; }
      const fresh = { id: shared.newReasonId(), label: r.label, color: r.color };
      settings.reasons.push(fresh); idMap.set(r.id, fresh.id); reasonsAdded++;
    }
    if (reasonsAdded || reasonsUpdated) updates[shared.SETTINGS_KEY] = settings;
  }
  let added = 0, pagesTouched = 0;
  for (const p of data.pages) {
    if (!p || typeof p.url !== 'string' || !Array.isArray(p.edits)) continue;
    const key = shared.PAGE_PREFIX + p.url;
    const existing = Array.isArray(all[key]) ? all[key] : [];
    const have = new Set(existing.map((e) => e.id));
    const fresh = p.edits
      .filter((e) => e && typeof e.id === 'string' && typeof e.exact === 'string' && !have.has(e.id))
      .map((e) => (idMap.has(e.reason) ? { ...e, reason: idMap.get(e.reason) } : e));
    if (!fresh.length) continue;
    updates[key] = existing.concat(fresh);
    const meta = all[shared.META_PREFIX + p.url] || {};
    updates[shared.META_PREFIX + p.url] = { title: meta.title || p.title || '', updatedAt: Math.max(meta.updatedAt || 0, p.updatedAt || 0, Date.now()) };
    added += fresh.length; pagesTouched++;
  }
  if (Object.keys(updates).length) await api.storage.local.set(updates);
  const parts = [`Imported ${added} new edit${added === 1 ? '' : 's'} on ${pagesTouched} page${pagesTouched === 1 ? '' : 's'}`];
  if (reasonsAdded) parts.push(`added ${reasonsAdded} reason${reasonsAdded === 1 ? '' : 's'}`);
  if (reasonsUpdated) parts.push(`updated ${reasonsUpdated} reason${reasonsUpdated === 1 ? '' : 's'}`);
  flash(parts.join(', ') + '.');
  await load();
}

async function clearAll() {
  const total = pages.reduce((n, p) => n + p.edits.length, 0);
  if (!confirm(`Delete all ${total} edits on ${pages.length} pages? Reasons and colors are kept. This cannot be undone.`)) return;
  const keys = pages.flatMap((p) => [shared.PAGE_PREFIX + p.key, shared.META_PREFIX + p.key]);
  await api.storage.local.remove(keys);
  flash('All edits deleted.');
  await load();
}

$('#export').addEventListener('click', exportAll);
$('#import').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async () => { const f = $('#file').files[0]; if (f) await importFile(f); $('#file').value = ''; });
$('#clear-all').addEventListener('click', clearAll);
api.storage.onChanged.addListener((_changes, area) => { if (area === 'local') load(); });
load();
