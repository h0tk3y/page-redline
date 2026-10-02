// Page Redline — background script (MV3). Firefox runs it as an event page via
// background.scripts, Chrome as a service worker via background.service_worker.
const api = globalThis.browser ?? globalThis.chrome;
const MENU_MARK = 'page-redline-mark';

function createMenu() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({ id: MENU_MARK, title: 'Mark as invalid…', contexts: ['selection'] });
  });
}

api.runtime.onInstalled.addListener(createMenu);
if (api.runtime.onStartup) api.runtime.onStartup.addListener(createMenu);

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_MARK || !tab || tab.id == null) return;
  const options = info.frameId != null ? { frameId: info.frameId } : undefined;
  const p = api.tabs.sendMessage(tab.id, { type: 'pr:mark-selection' }, options);
  if (p && typeof p.catch === 'function') p.catch(() => {});
});
