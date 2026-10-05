// Page Redline — content script.
// Marks selected text as invalid (strikethrough), shows an inline replacement,
// records a reason, persists edits per page and re-anchors them on reload.
(() => {
  if (window.__pageRedlineLoaded) return;
  window.__pageRedlineLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const DEL = 'page-redline-del';
  const INS = 'page-redline-ins';
  const FLASH = 'page-redline-flash';
  const HOST_ID = 'page-redline-host';
  const CTX = 32; // minimum anchor context (chars) on each side
  const MAX_CTX = 2048; // grown while the surroundings repeat elsewhere on the page
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE', 'SVG', 'IFRAME', 'OBJECT']);
  const shared = globalThis.PageRedlineShared;
  if (!shared) {
    console.error('Page Redline: shared.js was not injected. The extension was updated on disk but not reloaded — reload it (chrome://extensions or about:debugging), then reload this page.');
    return;
  }
  const SETTINGS_KEY = shared.SETTINGS_KEY;
  let settings = shared.normalizeSettings(null);
  const reasonOf = (id) => (id ? settings.reasons.find((r) => r.id === id) || null : null);
  const reasonLabel = (id) => { const r = reasonOf(id); return r ? r.label : id ? `${id} (removed reason)` : ''; };

  const pageKey = location.origin + location.pathname + location.search;
  const storageKey = shared.PAGE_PREFIX + pageKey;
  const metaKey = shared.META_PREFIX + pageKey;
  let edits = []; // { id, exact, prefix, suffix, replacement, reason, note, createdAt }
  let lastContextRange = null;

  // ---------- storage ----------
  async function load() {
    const r = await api.storage.local.get([storageKey, SETTINGS_KEY]);
    edits = Array.isArray(r[storageKey]) ? r[storageKey] : [];
    settings = shared.normalizeSettings(r[SETTINGS_KEY]);
    applyVisibility();
  }
  function applyVisibility() {
    if (settings.visible) document.documentElement.removeAttribute('data-page-redline-hidden');
    else { document.documentElement.setAttribute('data-page-redline-hidden', ''); closeEditor(); }
  }
  function applyColor(el, edit) {
    if (el.classList.contains(INS)) { el.style.setProperty('--pr-color', settings.replacementColor); return; }
    const r = reasonOf(edit.reason);
    if (r) el.style.setProperty('--pr-color', r.color);
    else el.style.removeProperty('--pr-color');
  }
  async function save() {
    if (!edits.length) { await api.storage.local.remove([storageKey, metaKey]); return; }
    await api.storage.local.set({ [storageKey]: edits, [metaKey]: { title: document.title, updatedAt: Date.now() } });
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---------- text map ----------
  function collectText() {
    const segs = [];
    const byNode = new Map();
    let text = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(n.nodeName.toUpperCase()) || n.classList.contains(INS) || n.id === HOST_ID) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        }
        return n.data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const seg = { node: n, start: text.length, end: text.length + n.data.length };
      segs.push(seg);
      byNode.set(n, seg);
      text += n.data;
    }
    return { segs, byNode, text };
  }

  function offsetOf(container, offset, map) {
    const seg = map.byNode.get(container);
    if (seg) return seg.start + offset;
    const probe = document.createRange();
    probe.setStart(container, offset);
    probe.collapse(true);
    for (const s of map.segs) {
      if (probe.comparePoint(s.node, 0) >= 0) return s.start;
    }
    return map.text.length;
  }

  function rangeFromOffsets(s, e, map) {
    if (e <= s) return null;
    const range = document.createRange();
    let startSet = false, endSet = false;
    for (const seg of map.segs) {
      if (!startSet && seg.start <= s && s < seg.end) { range.setStart(seg.node, s - seg.start); startSet = true; }
      if (seg.start < e && e <= seg.end) { range.setEnd(seg.node, e - seg.start); endSet = true; break; }
    }
    return startSet && endSet ? range : null;
  }

  function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
  function commonSuffix(a, b) { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }

  function occurrences(text, exact, limit = 500) {
    const out = [];
    for (let i = text.indexOf(exact); i !== -1 && out.length < limit; i = text.indexOf(exact, i + 1)) out.push(i);
    return out;
  }

  // Candidate ranges for an edit, best match first. The score is how much of the stored
  // context matches around each occurrence; ties keep document order.
  function findRanges(edit, map = collectText()) {
    const { text } = map;
    if (!edit.exact) return [];
    const prefix = edit.prefix || '', suffix = edit.suffix || '';
    const scored = occurrences(text, edit.exact).map((c, order) => {
      const end = c + edit.exact.length;
      const score = commonSuffix(text.slice(Math.max(0, c - prefix.length), c), prefix)
        + commonPrefix(text.slice(end, end + suffix.length), suffix);
      return { c, order, score };
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return scored.map(({ c }) => rangeFromOffsets(c, c + edit.exact.length, map)).filter(Boolean);
  }

  // Smallest context (>= CTX) that distinguishes the occurrence at s from every other
  // occurrence of the same text on the page.
  function contextLength(text, s, e) {
    const exact = text.slice(s, e);
    const others = occurrences(text, exact, 2000).filter((c) => c !== s);
    let ctx = CTX;
    while (ctx < MAX_CTX) {
      const before = text.slice(Math.max(0, s - ctx), s), after = text.slice(e, e + ctx);
      const clash = others.some((c) => text.slice(Math.max(0, c - ctx), c) === before && text.slice(c + exact.length, c + exact.length + ctx) === after);
      if (!clash) break;
      ctx *= 2;
    }
    return Math.min(ctx, MAX_CTX);
  }

  // ---------- DOM marks ----------
  function delSpans(id) { return [...document.querySelectorAll(`.${DEL}[data-pr-id="${id}"]`)]; }
  function insSpan(id) { return document.querySelector(`.${INS}[data-pr-id="${id}"]`); }
  function isAnchored(id) { return delSpans(id).length > 0; }

  function tooltip(edit) {
    const parts = [];
    if (edit.reason) parts.push(reasonLabel(edit.reason));
    if (edit.note) parts.push(edit.note);
    parts.push(edit.replacement ? `Replace with: “${edit.replacement}”` : 'Remove');
    return parts.join(' — ');
  }

  function applyMark(range, edit) {
    let sc = range.startContainer, so = range.startOffset, ec = range.endContainer, eo = range.endOffset;
    if (ec.nodeType === Node.TEXT_NODE && eo < ec.data.length) ec.splitText(eo);
    if (sc.nodeType === Node.TEXT_NODE && so > 0) {
      const tail = sc.splitText(so);
      if (ec === sc) { ec = tail; eo = tail.data.length; }
      sc = tail; so = 0;
    }
    const r = document.createRange();
    r.setStart(sc, so);
    r.setEnd(ec, eo);
    const root = r.commonAncestorContainer.nodeType === Node.TEXT_NODE ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer;
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(n.nodeName.toUpperCase()) || n.classList.contains(INS) || n.id === HOST_ID) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return r.intersectsNode(n) && n.data.trim().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    if (!nodes.length) return false;
    if (nodes.some((t) => t.parentElement && t.parentElement.closest(`.${DEL}`))) return false; // overlap
    let last = null;
    for (const t of nodes) {
      const span = document.createElement('span');
      span.className = DEL;
      span.dataset.prId = edit.id;
      span.title = tooltip(edit);
      applyColor(span, edit);
      t.parentNode.insertBefore(span, t);
      span.appendChild(t);
      last = span;
    }
    renderIns(edit, last);
    return true;
  }

  function renderIns(edit, afterEl) {
    let ins = insSpan(edit.id);
    if (!edit.replacement) { if (ins) ins.remove(); return; }
    if (!ins) {
      const spans = delSpans(edit.id);
      const anchor = afterEl || spans[spans.length - 1];
      if (!anchor) return;
      ins = document.createElement('span');
      ins.className = INS;
      ins.dataset.prId = edit.id;
      anchor.after(ins);
    }
    ins.textContent = edit.replacement;
    ins.title = tooltip(edit);
    applyColor(ins, edit);
  }

  function refreshTitles(edit) {
    for (const s of delSpans(edit.id)) { s.title = tooltip(edit); applyColor(s, edit); }
    const ins = insSpan(edit.id);
    if (ins) { ins.title = tooltip(edit); applyColor(ins, edit); }
  }

  function unmark(id) {
    const ins = insSpan(id);
    if (ins) ins.remove();
    for (const span of delSpans(id)) {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      span.remove();
      parent.normalize();
    }
  }

  function anchorAll() {
    for (const edit of edits) {
      if (isAnchored(edit.id)) continue;
      // Try candidates best-first; one already covered by another mark is skipped.
      for (const range of findRanges(edit)) if (applyMark(range, edit)) break;
    }
  }

  // ---------- actions ----------
  function markSelection() {
    const sel = window.getSelection();
    let range = null;
    if (sel && sel.rangeCount && !sel.isCollapsed) range = sel.getRangeAt(0).cloneRange();
    else if (lastContextRange && !lastContextRange.collapsed) range = lastContextRange;
    if (!range) return { error: 'Select some text first.' };
    const map = collectText();
    let s = offsetOf(range.startContainer, range.startOffset, map);
    let e = offsetOf(range.endContainer, range.endOffset, map);
    const text = map.text;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e <= s) return { error: 'The selection contains no text.' };
    const ctx = contextLength(text, s, e);
    const edit = {
      id: uid(),
      exact: text.slice(s, e),
      prefix: text.slice(Math.max(0, s - ctx), s),
      suffix: text.slice(e, e + ctx),
      replacement: '',
      reason: reasonOf(settings.lastReason) ? settings.lastReason : '',
      note: '',
      createdAt: Date.now(),
    };
    const target = rangeFromOffsets(s, e, map);
    if (!target || !applyMark(target, edit)) return { error: 'That selection overlaps an existing mark.' };
    edits.push(edit);
    save();
    if (sel) sel.removeAllRanges();
    lastContextRange = null;
    openEditor(edit.id);
    return { ok: true, edit };
  }

  function updateEdit(id, patch) {
    const edit = edits.find((x) => x.id === id);
    if (!edit) return { error: 'Unknown edit.' };
    if (typeof patch.replacement === 'string') edit.replacement = patch.replacement.trim();
    if (typeof patch.reason === 'string') {
      edit.reason = patch.reason;
      if (settings.lastReason !== patch.reason) {
        settings.lastReason = patch.reason;
        api.storage.local.set({ [SETTINGS_KEY]: settings });
      }
    }
    if (typeof patch.note === 'string') edit.note = patch.note.trim();
    renderIns(edit);
    refreshTitles(edit);
    save();
    return { ok: true, edit };
  }

  function removeEdit(id) {
    unmark(id);
    edits = edits.filter((x) => x.id !== id);
    save();
    closeEditor();
    return { ok: true };
  }

  function clearAll() {
    for (const edit of edits) unmark(edit.id);
    edits = [];
    save();
    closeEditor();
    return { ok: true };
  }

  function listEdits() {
    return {
      ok: true,
      url: location.href,
      title: document.title,
      reasons: settings.reasons,
      visible: settings.visible,
      replacementColor: settings.replacementColor,
      edits: edits.map((e) => ({ ...e, anchored: isAnchored(e.id) })),
    };
  }

  function scrollTo(id) {
    const spans = delSpans(id);
    if (!spans.length) return { error: 'This edit is not visible on the page (its text was not found).' };
    spans[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    const all = [...spans, insSpan(id)].filter(Boolean);
    for (const el of all) el.classList.add(FLASH);
    setTimeout(() => { for (const el of all) el.classList.remove(FLASH); }, 1500);
    return { ok: true };
  }

  // ---------- inline editor (shadow DOM) ----------
  let host = null, shadow = null, editingId = null;

  function ensureEditor() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;z-index:2147483647;';
    // Open, not closed: Vimium and similar extensions find the focused field by descending
    // document.activeElement -> shadowRoot.activeElement, which a closed root makes impossible.
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .card { position: fixed; width: 320px; max-width: calc(100vw - 24px); box-sizing: border-box; padding: 12px;
          background: #fff; color: #1d1d1f; border: 1px solid #c9c9cf; border-radius: 10px;
          box-shadow: 0 10px 30px rgba(0,0,0,.22); font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .orig { color: #8a1c1c; text-decoration: line-through; margin-bottom: 8px; max-height: 3.9em; overflow: hidden; word-break: break-word; }
        label { display: block; font-weight: 600; margin: 8px 0 4px; }
        textarea, input, select { width: 100%; box-sizing: border-box; font: inherit; padding: 6px 8px; border: 1px solid #b8b8c0; border-radius: 6px; background: #fff; color: inherit; }
        textarea { resize: vertical; min-height: 44px; }
        .row { display: flex; gap: 6px; margin-top: 10px; }
        button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid #b8b8c0; background: #f4f4f6; color: inherit; cursor: pointer; }
        button.primary { background: #2e7d32; border-color: #2e7d32; color: #fff; }
        button.danger { color: #b71c1c; margin-left: auto; }
        .hint { margin-top: 8px; color: #6e6e73; font-size: 11px; }
        .swatch { width: 14px; height: 14px; border-radius: 50%; flex: none; border: 1px solid rgba(0,0,0,.2); background: transparent; }
        @media (prefers-color-scheme: dark) {
          .card { background: #1f1f23; color: #ededf0; border-color: #45454d; }
          .orig { color: #ff8a80; }
          textarea, input, select { background: #2a2a30; border-color: #55555e; }
          button { background: #2e2e35; border-color: #55555e; }
          button.danger { color: #ff8a80; }
          .hint { color: #9a9aa3; }
        }
      </style>
      <div class="card" role="dialog" aria-label="Page Redline edit">
        <div class="orig"></div>
        <label>Replacement <span style="font-weight:400;color:#6e6e73">(leave empty to just strike through)</span></label>
        <textarea rows="2" class="repl" placeholder="New text…"></textarea>
        <label>Reason</label>
        <div style="display:flex;gap:6px;align-items:center"><span class="swatch"></span><select class="reason"></select></div>
        <input class="note" type="text" placeholder="Optional note…" style="margin-top:6px">
        <div class="row">
          <button class="primary save">Save</button>
          <button class="close">Close</button>
          <button class="danger remove">Remove mark</button>
        </div>
        <div class="hint">Enter saves · Esc closes · click any mark to edit it later</div>
      </div>`;
    shadow.querySelector('.reason').addEventListener('change', updateSwatch);
    shadow.querySelector('.save').addEventListener('click', saveFromEditor);
    shadow.querySelector('.close').addEventListener('click', closeEditor);
    shadow.querySelector('.remove').addEventListener('click', () => { if (editingId) removeEdit(editingId); });
    shadow.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); closeEditor(); }
      else if (ev.key === 'Enter' && !ev.shiftKey && ev.target.tagName !== 'SELECT') { ev.preventDefault(); saveFromEditor(); }
      ev.stopPropagation();
    });
    shadow.addEventListener('keyup', (ev) => ev.stopPropagation());
    shadow.addEventListener('keypress', (ev) => ev.stopPropagation());
    (document.body || document.documentElement).appendChild(host);
  }

  function fillReasonSelect(current) {
    const sel = shadow.querySelector('.reason');
    sel.textContent = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = '— no reason —';
    sel.appendChild(none);
    for (const r of settings.reasons) {
      const o = document.createElement('option');
      o.value = r.id; o.textContent = r.label;
      sel.appendChild(o);
    }
    if (current && !reasonOf(current)) {
      const o = document.createElement('option');
      o.value = current; o.textContent = reasonLabel(current);
      sel.appendChild(o);
    }
    sel.value = current || '';
    updateSwatch();
  }
  function updateSwatch() {
    const r = reasonOf(shadow.querySelector('.reason').value);
    shadow.querySelector('.swatch').style.background = r ? r.color : 'transparent';
  }

  function saveFromEditor() {
    if (!editingId) return;
    updateEdit(editingId, {
      replacement: shadow.querySelector('.repl').value,
      reason: shadow.querySelector('.reason').value,
      note: shadow.querySelector('.note').value,
    });
    closeEditor();
  }

  function openEditor(id) {
    const edit = edits.find((x) => x.id === id);
    const spans = delSpans(id);
    if (!edit || !spans.length || !settings.visible) return;
    ensureEditor();
    editingId = id;
    shadow.querySelector('.orig').textContent = edit.exact;
    shadow.querySelector('.repl').value = edit.replacement || '';
    fillReasonSelect(edit.reason || '');
    shadow.querySelector('.note').value = edit.note || '';
    const card = shadow.querySelector('.card');
    host.style.display = 'block';
    const rect = spans[spans.length - 1].getBoundingClientRect();
    const cw = card.offsetWidth || 320, ch = card.offsetHeight || 220;
    let top = rect.bottom + 8, left = rect.left;
    if (top + ch > window.innerHeight - 8) top = Math.max(8, rect.top - ch - 8);
    if (left + cw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - cw - 8);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
    shadow.querySelector('.repl').focus();
  }

  function closeEditor() {
    editingId = null;
    if (host) host.style.display = 'none';
  }

  // ---------- page events ----------
  document.addEventListener('contextmenu', () => {
    const sel = window.getSelection();
    lastContextRange = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
  }, true);

  document.addEventListener('click', (ev) => {
    const path = ev.composedPath ? ev.composedPath() : [];
    if (host && path.includes(host)) return;
    const mark = settings.visible && ev.target instanceof Element ? ev.target.closest(`.${DEL}, .${INS}`) : null;
    if (mark) {
      ev.preventDefault();
      ev.stopPropagation();
      openEditor(mark.dataset.prId);
    } else if (editingId) {
      closeEditor();
    }
  }, true);

  // ---------- messaging ----------
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    let result;
    switch (msg && msg.type) {
      case 'pr:ping': result = { ok: true }; break;
      case 'pr:mark-selection': result = markSelection(); break;
      case 'pr:list': result = listEdits(); break;
      case 'pr:update': result = updateEdit(msg.id, msg.patch || {}); break;
      case 'pr:remove': result = removeEdit(msg.id); break;
      case 'pr:clear': result = clearAll(); break;
      case 'pr:scroll-to': result = scrollTo(msg.id); break;
      case 'pr:open-editor': scrollTo(msg.id); openEditor(msg.id); result = { ok: true }; break;
      default: return false;
    }
    sendResponse(result);
    return false;
  });

  // Keep in sync when the same page is open in another tab.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SETTINGS_KEY]) {
      settings = shared.normalizeSettings(changes[SETTINGS_KEY].newValue);
      applyVisibility();
      for (const e of edits) refreshTitles(e);
      if (editingId) fillReasonSelect(shadow.querySelector('.reason').value);
    }
    if (!changes[storageKey]) return;
    const incoming = changes[storageKey].newValue || [];
    if (JSON.stringify(incoming) === JSON.stringify(edits)) return;
    for (const e of edits) unmark(e.id);
    edits = incoming;
    anchorAll();
  });

  // Re-anchor edits whose text appears later (dynamic pages).
  let reanchorTimer = null;
  const observer = new MutationObserver(() => {
    if (reanchorTimer) return;
    reanchorTimer = setTimeout(() => {
      reanchorTimer = null;
      if (edits.some((e) => !isAnchored(e.id))) anchorAll();
    }, 500);
  });

  load().then(() => {
    anchorAll();
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  });
})();
