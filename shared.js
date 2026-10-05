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

  globalThis.PageRedlineShared = { SETTINGS_KEY, PAGE_PREFIX, META_PREFIX, EXPORT_FORMAT, DEFAULT_REASONS, DEFAULT_REPLACEMENT_COLOR, normalizeSettings, newReasonId, pagesFromStorage };
})();
