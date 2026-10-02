// Page Redline — background script (MV3). Firefox runs it as an event page via
// background.scripts, Chrome as a service worker via background.service_worker.
const api = globalThis.browser ?? globalThis.chrome;
const MENU_MARK = 'page-redline-mark';
const MENU_TOGGLE = 'page-redline-toggle';
const SETTINGS_KEY = 'settings';

function createMenu() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({ id: MENU_MARK, title: 'Mark as invalid…', contexts: ['selection'] });
    api.contextMenus.create({ id: MENU_TOGGLE, title: 'Show / hide edits', contexts: ['page', 'selection', 'link', 'image'] });
  });
}

async function toggleVisibility() {
  const r = await api.storage.local.get(SETTINGS_KEY);
  const settings = r[SETTINGS_KEY] && typeof r[SETTINGS_KEY] === 'object' ? r[SETTINGS_KEY] : {};
  settings.visible = settings.visible === false;
  await api.storage.local.set({ [SETTINGS_KEY]: settings });
}

api.runtime.onInstalled.addListener(createMenu);
if (api.runtime.onStartup) api.runtime.onStartup.addListener(createMenu);

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_TOGGLE) { toggleVisibility(); return; }
  if (info.menuItemId !== MENU_MARK || !tab || tab.id == null) return;
  const options = info.frameId != null ? { frameId: info.frameId } : undefined;
  const p = api.tabs.sendMessage(tab.id, { type: 'pr:mark-selection' }, options);
  if (p && typeof p.catch === 'function') p.catch(() => {});
});

if (api.commands) {
  api.commands.onCommand.addListener((command) => {
    if (command === 'toggle-visibility') toggleVisibility();
  });
}
