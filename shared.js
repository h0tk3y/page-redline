// Page Redline — settings shared by the content script, popup and options page.
(() => {
  const SETTINGS_KEY = 'settings';
  const DEFAULT_REASONS = [
    { id: 'verbose', label: 'Too verbose', color: '#d32f2f' },
    { id: 'unclear', label: 'Unclear', color: '#ef6c00' },
    { id: 'incorrect', label: 'Incorrect', color: '#c2185b' },
    { id: 'duplicate', label: 'Duplicate', color: '#7b1fa2' },
    { id: 'outdated', label: 'Outdated', color: '#5d4037' },
    { id: 'offtopic', label: 'Off-topic', color: '#455a64' },
    { id: 'style', label: 'Style / tone', color: '#0288d1' },
    { id: 'other', label: 'Other', color: '#616161' },
  ];
  const HEX = /^#[0-9a-f]{6}$/i;
  const DEFAULT_REPLACEMENT_COLOR = '#2e7d32';

  function normalizeSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const reasons = Array.isArray(s.reasons)
      ? s.reasons
          .filter((r) => r && typeof r.id === 'string' && r.id)
          .map((r) => ({
            id: r.id,
            label: typeof r.label === 'string' ? r.label : r.id,
            color: HEX.test(r.color || '') ? r.color.toLowerCase() : '#d32f2f',
          }))
      : DEFAULT_REASONS.map((r) => ({ ...r }));
    const replacementColor = HEX.test(s.replacementColor || '') ? s.replacementColor.toLowerCase() : DEFAULT_REPLACEMENT_COLOR;
    const lastReason = typeof s.lastReason === 'string' ? s.lastReason : '';
    return { visible: s.visible !== false, reasons, replacementColor, lastReason };
  }

  function newReasonId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  const PAGE_PREFIX = 'page:';
  const META_PREFIX = 'meta:';
  const EXPORT_FORMAT = 'page-redline/1';

  // Groups raw storage into pages: [{ key, url, title, updatedAt, edits }], newest first.
  function pagesFromStorage(all) {
    const pages = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(PAGE_PREFIX) || !Array.isArray(v) || !v.length) continue;
      const url = k.slice(PAGE_PREFIX.length);
      const meta = all[META_PREFIX + url] || {};
      pages.push({ key: url, url, title: typeof meta.title === 'string' ? meta.title : '', updatedAt: meta.updatedAt || Math.max(0, ...v.map((e) => e.createdAt || 0)), edits: v });
    }
    pages.sort((a, b) => b.updatedAt - a.updatedAt);
    return pages;
  }

  const isNote = (e) => e && e.kind === 'note';

  // ---- color helpers (dark-background adaptation) ----
  // Parses #rrggbb / #rgb / rgb() / rgba(); returns [r, g, b, a] or null.
  function parseColor(str) {
    if (!str) return null;
    const s = String(str).trim();
    let m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
    m = s.match(/^#([0-9a-f]{3})$/i);
    if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat([1]);
    m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
    if (m) { let a = m[4] == null ? 1 : parseFloat(m[4]); if (m[4] && m[4].endsWith('%')) a /= 100; return [+m[1], +m[2], +m[3], a]; }
    return null;
  }
  const toHex = (rgb) => '#' + rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  // WCAG relative luminance, 0 (black) .. 1 (white).
  function luminance(rgb) {
    const [r, g, b] = rgb.slice(0, 3).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const isDarkColor = (str) => { const c = parseColor(str); return !!c && c[3] > 0 && luminance(c) < 0.35; };
  const mixWithWhite = (rgb, t) => rgb.slice(0, 3).map((v) => v + (255 - v) * t);
  // A mark color as it should be drawn on a dark background: mixed with white until it is light
  // enough (luminance >= 0.5) to read as a line, underline or badge. Unchanged on light backgrounds.
  function displayColor(hex, onDark) {
    const c = parseColor(hex);
    if (!c || !onDark) return hex;
    let rgb = c.slice(0, 3);
    for (let t = 0.3; t <= 0.9 && luminance(rgb) < 0.5; t += 0.1) rgb = mixWithWhite(c, t);
    return toHex(rgb);
  }

  // One Markdown bullet per mark. `label(reasonId)` resolves the reason's display name.
  function editToMarkdown(e, label) {
    const reason = e.reason ? label(e.reason) : '';
    if (isNote(e)) {
      const why = reason ? ` _(${reason})_` : '';
      return `- ✎ “${e.exact}” — ${e.note || '(no note)'}${why}`;
    }
    const why = [reason, e.note].filter(Boolean).join('; ');
    const change = e.replacement ? `~~${e.exact}~~ → ${e.replacement}` : `~~${e.exact}~~ (remove)`;
    return `- ${change}${why ? ` — _${why}_` : ''}`;
  }

  globalThis.PageRedlineShared = { isNote, editToMarkdown, parseColor, luminance, isDarkColor, displayColor, SETTINGS_KEY, PAGE_PREFIX, META_PREFIX, EXPORT_FORMAT, DEFAULT_REASONS, DEFAULT_REPLACEMENT_COLOR, normalizeSettings, newReasonId, pagesFromStorage };
})();
