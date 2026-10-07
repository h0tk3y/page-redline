// Page Redline — content script.
// Marks selected text as invalid (strikethrough), shows an inline replacement,
// records a reason, persists edits per page and re-anchors them on reload.
(() => {
  if (window.__pageRedlineLoaded) return;
  window.__pageRedlineLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const DEL = 'page-redline-del';   // struck-through mark (kind 'edit')
  const NOTE = 'page-redline-note'; // highlighted mark (kind 'note')
  const INS = 'page-redline-ins';   // replacement text after an edit
  const BADGE = 'page-redline-badge'; // note indicator after an edit
  const NOTE_FALLBACK_COLOR = '#f9a825';
  const EDIT_FALLBACK_COLOR = '#d32f2f';
  const FLASH = 'page-redline-flash';
  const HOVER = 'page-redline-hover';
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
  // Is the background behind this element dark? Walks up (from the element itself if `self`)
  // to the first painted background.
  function backgroundIsDark(el, self = false) {
    for (let node = self ? el : el.parentElement; node; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      const c = shared.parseColor(bg);
      if (c && c[3] > 0.5) return shared.luminance(c) < 0.35;
    }
    return false;
  }
  // The page can change scheme after we colored the marks: Dark Reader and similar extensions
  // inject their stylesheets after load, sites have theme toggles, the OS scheme can flip.
  // None of them can restyle our marks (extension CSS is invisible to page-level tools), so we
  // re-sample the background and recolor when it changes.
  let pageWasDark = null;
  function recolorIfSchemeChanged(force = false) {
    const dark = document.body ? backgroundIsDark(document.body, true) : false;
    if (!force && dark === pageWasDark) return;
    pageWasDark = dark;
    for (const edit of edits) refreshTitles(edit);
  }
  // Mark colors adapt to the background: on a dark page the color is lightened so lines, underlines
  // and badges stay visible, and the tint behind the text is strengthened.
  function applyColor(el, edit) {
    const dark = backgroundIsDark(el);
    let base;
    if (el.classList.contains(INS)) base = settings.replacementColor;
    else { const r = reasonOf(edit.reason); base = r ? r.color : isNote(edit) ? NOTE_FALLBACK_COLOR : EDIT_FALLBACK_COLOR; }
    el.style.setProperty('--pr-color', shared.displayColor(base, dark));
    if (dark) el.style.setProperty('--pr-tint', el.classList.contains(INS) ? '26%' : el.classList.contains(NOTE) ? '42%' : '34%');
    else el.style.removeProperty('--pr-tint');
  }
  async function save() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!edits.length) { await api.storage.local.remove([storageKey, metaKey]); return; }
    await api.storage.local.set({ [storageKey]: edits, [metaKey]: { title: document.title, updatedAt: Date.now() } });
  }
  // Live edits from the card arrive on every keystroke; coalesce the storage writes.
  let saveTimer = null;
  function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; save(); }, 250);
  }
  window.addEventListener('pagehide', () => { if (saveTimer) save(); });
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---------- text map ----------
  function collectText() {
    const segs = [];
    const byNode = new Map();
    let text = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(n.nodeName.toUpperCase()) || isOwnUi(n)) {
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
  const isNote = (edit) => shared.isNote(edit);
  const isOwnUi = (el) => el.id === HOST_ID || el.classList.contains(INS) || el.classList.contains(BADGE);
  // The spans wrapping the marked text (struck or highlighted).
  function delSpans(id) { return [...document.querySelectorAll(`.${DEL}[data-pr-id="${id}"], .${NOTE}[data-pr-id="${id}"]`)]; }
  function insSpan(id) { return document.querySelector(`.${INS}[data-pr-id="${id}"]`); }
  function badgeSpan(id) { return document.querySelector(`.${BADGE}[data-pr-id="${id}"]`); }
  function isAnchored(id) { return delSpans(id).length > 0; }

  function tooltip(edit) {
    const parts = [];
    if (edit.reason) parts.push(reasonLabel(edit.reason));
    if (edit.note) parts.push(edit.note);
    if (isNote(edit)) return parts.join(' — ') || 'Note';
    parts.push(edit.replacement ? `Replace with: “${edit.replacement}”` : 'Remove');
    return parts.join(' — ');
  }

  // Inline elements may be wrapped whole; anything else is a block boundary we descend into.
  function isInlineElement(el) {
    if (SKIP_TAGS.has(el.nodeName.toUpperCase()) || isOwnUi(el)) return false;
    const d = getComputedStyle(el).display;
    return d.startsWith('inline') || d === 'contents';
  }
  function hasVisibleText(node) {
    return node.nodeType === Node.TEXT_NODE ? node.data.trim().length > 0 : node.textContent.trim().length > 0;
  }

  // Wraps the range in as few spans as possible: within each block, one span per run of
  // fully covered sibling nodes (text and whole inline elements such as <code> or <b>),
  // splitting only the partially covered text nodes at the two ends. Returns false and
  // changes nothing if the range is empty or touches an existing mark.
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

    // Collect the runs first, then check for overlap, then wrap: no half-applied marks.
    const runs = [];
    const markSelector = `.${DEL}, .${NOTE}, .${INS}, .${BADGE}`;
    let touchesMark = false;
    function collect(parent) {
      let run = [];
      const flush = () => { if (run.some(hasVisibleText)) runs.push(run); run = []; };
      for (const child of [...parent.childNodes]) {
        if (!r.intersectsNode(child)) { flush(); continue; }
        if (child.nodeType === Node.ELEMENT_NODE && child.matches(markSelector)) { touchesMark = true; return; }
        const fullyCovered = r.comparePoint(child, 0) >= 0 && (child.nodeType === Node.TEXT_NODE
          ? r.comparePoint(child, child.data.length) <= 0
          : r.comparePoint(child.parentNode, [...child.parentNode.childNodes].indexOf(child) + 1) <= 0);
        if (child.nodeType === Node.TEXT_NODE) {
          if (fullyCovered && !SKIP_TAGS.has(parent.nodeName.toUpperCase())) run.push(child); else flush();
        } else if (fullyCovered && isInlineElement(child)) {
          if (child.querySelector(markSelector)) { touchesMark = true; return; }
          run.push(child);
        } else {
          flush();
          if (!SKIP_TAGS.has(child.nodeName.toUpperCase()) && !isOwnUi(child)) collect(child);
          if (touchesMark) return;
        }
      }
      flush();
    }
    const root = r.commonAncestorContainer.nodeType === Node.TEXT_NODE ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer;
    if (root.closest && root.closest(markSelector)) return false;
    collect(root);
    if (touchesMark || !runs.length) return false;

    for (const run of runs) {
      const span = document.createElement('span');
      span.className = isNote(edit) ? NOTE : DEL;
      span.dataset.prId = edit.id;
      span.title = tooltip(edit);
      applyColor(span, edit);
      run[0].parentNode.insertBefore(span, run[0]);
      for (const node of run) span.appendChild(node);
    }
    renderTrailing(edit);
    return true;
  }

  // What follows the marked text: the replacement (edits only) and the note badge
  // (edits with a note). Notes carry their text in the highlight itself, no badge.
  function renderTrailing(edit) {
    const spans = delSpans(edit.id);
    const lastSpan = spans[spans.length - 1];
    let ins = insSpan(edit.id);
    if (isNote(edit) || !edit.replacement) { if (ins) ins.remove(); ins = null; }
    else if (lastSpan) {
      if (!ins) { ins = document.createElement('span'); ins.className = INS; ins.dataset.prId = edit.id; lastSpan.after(ins); }
      ins.textContent = edit.replacement;
      ins.title = tooltip(edit);
      applyColor(ins, edit);
    }
    let badge = badgeSpan(edit.id);
    if (isNote(edit) || !edit.note) { if (badge) badge.remove(); }
    else if (lastSpan) {
      if (!badge) { badge = document.createElement('span'); badge.className = BADGE; badge.dataset.prId = edit.id; }
      (ins || lastSpan).after(badge);
      badge.title = edit.note;
      applyColor(badge, edit);
    }
  }

  function refreshTitles(edit) {
    for (const s of delSpans(edit.id)) { s.title = tooltip(edit); applyColor(s, edit); }
    renderTrailing(edit);
  }

  function reapply(edit) {
    unmark(edit.id);
    for (const range of findRanges(edit)) if (applyMark(range, edit)) break;
  }

  function unmark(id) {
    if (hoveredId === id) hoveredId = null;
    const ins = insSpan(id);
    if (ins) ins.remove();
    const badge = badgeSpan(id);
    if (badge) badge.remove();
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
  // With the card open, the shortcut of the OTHER kind converts the open mark (note -> edit or
  // edit -> note); the same kind's shortcut behaves as usual. The context menu never converts.
  function markSelection(kind = 'edit', source = 'menu') {
    if (source === 'shortcut' && editingId) {
      const open = edits.find((x) => x.id === editingId);
      if (open && (isNote(open) ? 'note' : 'edit') !== kind) {
        const edit = convertOpenEdit();
        return { ok: true, edit, converted: true };
      }
    }
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
      kind: kind === 'note' ? 'note' : 'edit',
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

  // `live` updates come from the card on every keystroke and coalesce their storage writes;
  // everything else (popup, cancel, save) persists immediately.
  function updateEdit(id, patch, live = false) {
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
    const newKind = patch.kind === 'note' ? 'note' : patch.kind === 'edit' ? 'edit' : null;
    if (newKind && newKind !== (isNote(edit) ? 'note' : 'edit')) { edit.kind = newKind; reapply(edit); }
    else refreshTitles(edit);
    if (live) saveSoon(); else save();
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
    const all = [...spans, insSpan(id), badgeSpan(id)].filter(Boolean);
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
        .card.note-mode .orig { color: inherit; text-decoration: none; background: color-mix(in srgb, var(--note-color, #f9a825) 30%, transparent); border-radius: 3px; padding: 0 2px; }
        .card.note-mode .repl-block { display: none; }
        .card { display: flex; flex-direction: column; }
        .note-block textarea { min-height: 36px; }
        .card.note-mode .note-block textarea { min-height: 60px; }
        .convert { margin-top: 8px; font-size: 11px; color: #6e6e73; }
        /* A real button (native Enter/Space activation) styled as a link. */
        .convert button { all: unset; font: inherit; color: inherit; cursor: pointer; text-decoration: underline; }
        .convert button:focus-visible { outline: 2px solid #2e7d32; outline-offset: 2px; border-radius: 2px; }
        label { display: block; font-weight: 600; margin: 8px 0 4px; }
        textarea, input, select { width: 100%; box-sizing: border-box; font: inherit; padding: 6px 8px; border: 1px solid #b8b8c0; border-radius: 6px; background: #fff; color: inherit; }
        textarea { resize: vertical; min-height: 44px; }
        .row { display: flex; gap: 6px; margin-top: 10px; justify-content: flex-end; }
        .row .remove { order: -1; margin-right: auto; }
        .row .save { order: 1; }
        button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid #b8b8c0; background: #f4f4f6; color: inherit; cursor: pointer; }
        button.primary { background: #2e7d32; border-color: #2e7d32; color: #fff; }
        button.danger { color: #b71c1c; }
        .swatch { width: 14px; height: 14px; border-radius: 50%; flex: none; border: 1px solid rgba(0,0,0,.2); background: transparent; }
        @media (prefers-color-scheme: dark) {
          .card { background: #1f1f23; color: #ededf0; border-color: #45454d; }
          .orig { color: #ff8a80; }
          textarea, input, select { background: #2a2a30; border-color: #55555e; }
          button { background: #2e2e35; border-color: #55555e; }
          button.danger { color: #ff8a80; }
        }
      </style>
      <div class="card" role="dialog" aria-label="Page Redline edit">
        <div class="orig"></div>
        <div class="repl-block">
          <label>Replacement</label>
          <textarea rows="2" class="repl" placeholder="Optional"></textarea>
        </div>
        <div class="reason-block">
          <label>Reason</label>
          <div style="display:flex;gap:6px;align-items:center"><span class="swatch"></span><select class="reason"></select></div>
        </div>
        <div class="note-block">
          <label>Note</label>
          <textarea rows="1" class="note"></textarea>
        </div>
        <div class="convert"><button type="button" class="convert-link"></button></div>
        <div class="row">
          <button class="primary save" title="Enter">Save</button>
          <button class="cancel" title="Esc">Cancel</button>
          <button class="danger remove">Remove</button>
        </div>
      </div>`;
    shadow.querySelector('.reason').addEventListener('change', updateSwatch);
    shadow.querySelector('.save').addEventListener('click', saveFromEditor);
    shadow.querySelector('.cancel').addEventListener('click', cancelEditor);
    // Everything applies live: the mark on the page follows the fields as you type or pick.
    shadow.querySelector('.repl').addEventListener('input', applyLive);
    shadow.querySelector('.note').addEventListener('input', applyLive);
    shadow.querySelector('.reason').addEventListener('change', applyLive);
    shadow.querySelector('.remove').addEventListener('click', () => { if (editingId) removeEdit(editingId); });
    shadow.querySelector('.convert-link').addEventListener('click', convertOpenEdit);
    shadow.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); cancelEditor(); }
      else if (ev.key === 'Enter' && !ev.shiftKey) {
        const t = ev.target;
        if (t.tagName === 'BUTTON') { /* Enter on a button (incl. the convert link) activates it natively */ }
        else { ev.preventDefault(); saveFromEditor(); } // textareas, the reason select, anything else
      }
      ev.stopPropagation();
    });
    shadow.addEventListener('keyup', (ev) => ev.stopPropagation());
    // Keyboard-driven extensions (Vimium) handle Esc in text fields themselves by blurring the
    // field, and stop the event before it reaches us. Focus leaving the card to nothing, while
    // the window keeps focus and no pointer is involved, is that case: treat it as Cancel.
    shadow.addEventListener('focusout', (ev) => {
      if (rebuilding) return; // the card is hiding/moving its own fields while (re)opening
      if (!editingId || ev.relatedTarget) return; // focus moved to another element: not Esc
      if (!document.hasFocus()) return; // window lost focus (app switch): keep the card
      if (Date.now() - lastPointerDown < 500) return; // a click elsewhere: the click handler decides
      cancelEditor();
    });
    shadow.addEventListener('keypress', (ev) => ev.stopPropagation());
    (document.body || document.documentElement).appendChild(host);
  }

  function fillReasonSelect(current) {
    const sel = shadow.querySelector('.reason');
    sel.textContent = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = 'No reason';
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
    const cardDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    shadow.querySelector('.card').style.setProperty('--note-color', shared.displayColor(r ? r.color : NOTE_FALLBACK_COLOR, cardDark));
  }

  // Flip the open mark's kind, keeping whatever was typed, and reopen the card in the other mode.
  function convertOpenEdit() {
    if (!editingId) return null;
    const edit = edits.find((x) => x.id === editingId);
    if (!edit) return null;
    const id = editingId;
    updateEdit(id, {
      replacement: shadow.querySelector('.repl').value,
      reason: shadow.querySelector('.reason').value,
      note: shadow.querySelector('.note').value,
      kind: isNote(edit) ? 'edit' : 'note',
    });
    openEditor(id);
    return edit;
  }

  // Snapshot of the mark when the card opened, so Cancel can put it back.
  let snapshot = null;
  let rebuilding = false; // true while openEditor rearranges the card (suppresses the focusout rule)
  function fieldValues() {
    return {
      replacement: shadow.querySelector('.repl').value,
      reason: shadow.querySelector('.reason').value,
      note: shadow.querySelector('.note').value,
    };
  }
  function applyLive() {
    if (!editingId) return;
    updateEdit(editingId, fieldValues(), true);
  }
  // Save: changes are already applied; make sure they are persisted and close.
  function saveFromEditor() {
    if (!editingId) return;
    updateEdit(editingId, fieldValues());
    closeEditor();
  }
  // Cancel / Esc: revert to the state at open (including the kind) and close.
  function cancelEditor() {
    if (editingId && snapshot) updateEdit(editingId, snapshot);
    closeEditor();
  }

  function openEditor(id) {
    const edit = edits.find((x) => x.id === id);
    const spans = delSpans(id);
    if (!edit || !spans.length || !settings.visible) return;
    ensureEditor();
    rebuilding = true;
    if (editingId !== id) snapshot = { replacement: edit.replacement || '', reason: edit.reason || '', note: edit.note || '', kind: isNote(edit) ? 'note' : 'edit' };
    editingId = id;
    const note = isNote(edit);
    const card = shadow.querySelector('.card');
    card.classList.toggle('note-mode', note);
    // Note mode shows the note above the reason. Reorder the DOM (not CSS order) so the tab
    // order matches what is on screen.
    const noteBlock = shadow.querySelector('.note-block'), reasonBlock = shadow.querySelector('.reason-block');
    if (note) reasonBlock.before(noteBlock); else reasonBlock.after(noteBlock);
    shadow.querySelector('.note').placeholder = note ? '' : 'Optional';
    shadow.querySelector('.convert-link').textContent = note ? 'Strike through instead' : 'Note only';
    shadow.querySelector('.orig').textContent = edit.exact;
    shadow.querySelector('.repl').value = edit.replacement || '';
    fillReasonSelect(edit.reason || '');
    shadow.querySelector('.note').value = edit.note || '';
    host.style.display = 'block';
    const rect = spans[spans.length - 1].getBoundingClientRect();
    const cw = card.offsetWidth || 320, ch = card.offsetHeight || 220;
    let top = rect.bottom + 8, left = rect.left;
    if (top + ch > window.innerHeight - 8) top = Math.max(8, rect.top - ch - 8);
    if (left + cw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - cw - 8);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
    shadow.querySelector(note ? '.note' : '.repl').focus();
    rebuilding = false;
  }

  // Closing without Cancel (Save, Enter, clicking outside) keeps the live changes.
  function closeEditor() {
    editingId = null;
    snapshot = null;
    if (host) host.style.display = 'none';
  }

  // Every element belonging to a mark: text spans, replacement, badge.
  function markElements(id) { return [...document.querySelectorAll(`[data-pr-id="${id}"]`)]; }

  // Hover the whole mark, not just the piece under the cursor.
  let hoveredId = null;
  function setHover(id) {
    if (id === hoveredId) return;
    if (hoveredId) for (const el of markElements(hoveredId)) el.classList.remove(HOVER);
    hoveredId = id;
    if (id) for (const el of markElements(id)) el.classList.add(HOVER);
  }
  document.addEventListener('mouseover', (ev) => {
    const mark = settings.visible && ev.target instanceof Element ? ev.target.closest('[data-pr-id]') : null;
    setHover(mark ? mark.dataset.prId : null);
  }, true);
  document.addEventListener('mouseleave', () => setHover(null), true);

  let lastPointerDown = 0;
  document.addEventListener('pointerdown', () => { lastPointerDown = Date.now(); }, true);

  // ---------- page events ----------
  document.addEventListener('contextmenu', () => {
    const sel = window.getSelection();
    lastContextRange = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
  }, true);

  document.addEventListener('click', (ev) => {
    const path = ev.composedPath ? ev.composedPath() : [];
    if (host && path.includes(host)) return;
    const mark = settings.visible && ev.target instanceof Element ? ev.target.closest(`.${DEL}, .${NOTE}, .${INS}, .${BADGE}`) : null;
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
      case 'pr:mark-selection': result = markSelection(msg.kind, msg.source); break;
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
      recolorIfSchemeChanged();
    }, 500);
  });

  // Theme switches usually show up as attribute changes on <html>/<body> (class, style, data-theme,
  // Dark Reader's data-darkreader-* attributes); handle those immediately.
  const schemeObserver = new MutationObserver(() => recolorIfSchemeChanged());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => recolorIfSchemeChanged(true));

  load().then(() => {
    anchorAll();
    pageWasDark = document.body ? backgroundIsDark(document.body, true) : false;
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    schemeObserver.observe(document.documentElement, { attributes: true });
    if (document.body) schemeObserver.observe(document.body, { attributes: true });
  });
})();
