// Page Redline — background script (MV3). Firefox runs it as an event page via
// background.scripts, Chrome as a service worker via background.service_worker.
const api = globalThis.browser ?? globalThis.chrome;
const MENU_MARK = 'page-redline-mark';
const MENU_NOTE = 'page-redline-note';

function createMenu() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({ id: MENU_MARK, title: 'Mark as invalid…', contexts: ['selection'] });
    api.contextMenus.create({ id: MENU_NOTE, title: 'Add a note…', contexts: ['selection'] });
  });
}

api.runtime.onInstalled.addListener(createMenu);
if (api.runtime.onStartup) api.runtime.onStartup.addListener(createMenu);

function markSelection(tabId, frameId, kind = 'edit', source = 'menu') {
  const options = frameId != null ? { frameId } : undefined;
  const p = api.tabs.sendMessage(tabId, { type: 'pr:mark-selection', kind, source }, options);
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

api.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === MENU_MARK) markSelection(tab.id, info.frameId, 'edit');
  else if (info.menuItemId === MENU_NOTE) markSelection(tab.id, info.frameId, 'note');
});

// Keyboard shortcut (Alt+Shift+M by default; rebindable in the browser's extension shortcuts).
if (api.commands) {
  api.commands.onCommand.addListener((command, tab) => {
    const kind = command === 'mark-selection' ? 'edit' : command === 'add-note' ? 'note' : null;
    if (!kind) return;
    if (tab && tab.id != null) { markSelection(tab.id, undefined, kind, 'shortcut'); return; }
    api.tabs.query({ active: true, currentWindow: true }).then((tabs) => { if (tabs[0]) markSelection(tabs[0].id, undefined, kind, 'shortcut'); });
  });
}
