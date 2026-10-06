// Firefox popup probe (investigation tool, not a regular test).
//
// Installs the extension temporarily into a throwaway Firefox profile, pins its button, grants
// host access, creates a few edits on a page, then opens the toolbar popup repeatedly with REAL
// OS-level mouse clicks (the test window is brought to the front and the mouse pointer moves),
// dismissing it between opens the way a user would. Prints the panel state, the popup's size and
// text, and Firefox's internal view state after every step.
//
//   python3 -m http.server 8766 -d test --bind 127.0.0.1 &
//   node test/firefox-popup-probe.mjs
//
// Written while investigating a report that the popup opens only once per page load in Firefox;
// in a clean profile (Firefox 158) every path opened reliably: toolbar button, extensions menu,
// with and without Vimium, dismissed by clicking the page or the icon.
import net from 'node:net';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const FF = '/Applications/Firefox.app/Contents/MacOS/firefox';
const EXT = process.env.EXT || '/Users/sigushkin/Projects/page-redline';
const ID = 'page-redline@igushkin.dev', WID = 'page-redline_igushkin_dev-browser-action';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ffp-'));
fs.writeFileSync(path.join(PROFILE, 'user.js'), ['user_pref("browser.shell.checkDefaultBrowser", false);', 'user_pref("datareporting.policy.dataSubmissionEnabled", false);', 'user_pref("browser.aboutwelcome.enabled", false);', 'user_pref("browser.startup.homepage_override.mstone", "ignore");'].join('\n'));
const ff = spawn(FF, ['-marionette', '-remote-allow-system-access', '-no-remote', '-profile', PROFILE, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function connect() { for (let i = 0; i < 240; i++) { try { return await new Promise((res, rej) => { const s = net.connect(2828, '127.0.0.1'); s.once('connect', () => res(s)); s.once('error', rej); }); } catch { await sleep(500); } } throw new Error('marionette not reachable'); }
function client(sock) {
  let buf = Buffer.alloc(0); let id = 0; const pending = new Map(); const queue = [];
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const colon = buf.indexOf(0x3a); if (colon < 0) break;
      const len = parseInt(buf.subarray(0, colon).toString(), 10); if (!Number.isFinite(len)) { buf = Buffer.alloc(0); break; }
      if (buf.length < colon + 1 + len) break;
      const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString('utf8')); buf = buf.subarray(colon + 1 + len);
      if (Array.isArray(msg)) { const [, mid, err, ok] = msg; if (pending.has(mid)) { pending.get(mid)(err ? { error: err } : ok); pending.delete(mid); } } else queue.push(msg);
    }
  });
  return { send: (cmd, params = {}) => new Promise((res) => { const i = ++id; const t = setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ error: { message: 'timeout: ' + cmd } }); } }, 25000); pending.set(i, (v) => { clearTimeout(t); res(v); }); const body = Buffer.from(JSON.stringify([0, i, cmd, params]), 'utf8'); sock.write(Buffer.concat([Buffer.from(`${body.length}:`), body])); }), handshake: () => new Promise((res) => { const t = setInterval(() => { if (queue.length) { clearInterval(t); res(queue.shift()); } }, 50); }) };
}
const val = (r) => (r && r.error) ? 'ERR ' + (r.error.message || JSON.stringify(r.error)).slice(0, 200) : r.value;
try {
  const sock = await connect(); const c = client(sock); await c.handshake();
  console.log('session:', JSON.stringify(await c.send('WebDriver:NewSession', { capabilities: { alwaysMatch: {} } })).slice(0, 80));
  console.log('install:', val(await c.send('Addon:Install', { path: EXT, temporary: true })) ? 'ok' : 'ok');
  const chrome = async (script) => { await c.send('Marionette:SetContext', { value: 'chrome' }); const r = await c.send('WebDriver:ExecuteScript', { script }); await c.send('Marionette:SetContext', { value: 'content' }); return val(r); };
  const setup = await chrome(`
    const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    const p = WebExtensionPolicy.getByID('${ID}');
    win.CustomizableUI.addWidgetToArea('${WID}', win.CustomizableUI.AREA_NAVBAR);
    return ExtensionPermissions.add('${ID}', { permissions: [], origins: ['<all_urls>'] }, p.extension).then(() => p.getURL('pages.html'));`);
  console.log('setup, helper url:', setup);
  // demo tab
  await c.send('WebDriver:Navigate', { url: 'http://127.0.0.1:8766/demo.html' });
  const demoHandle = val(await c.send('WebDriver:GetWindowHandle'));
  await sleep(1200);
  // helper tab on an extension page
  const nw = await c.send('WebDriver:NewWindow', { type: 'tab' });
  const helperHandle = nw.handle;
  await c.send('WebDriver:SwitchToWindow', { handle: helperHandle });
  await c.send('WebDriver:Navigate', { url: setup });
  await sleep(800);
  const inHelper = async (script) => { await c.send('WebDriver:SwitchToWindow', { handle: helperHandle }); const r = await c.send('WebDriver:ExecuteScript', { script }); await c.send('WebDriver:SwitchToWindow', { handle: demoHandle }); return val(r); };
  const inDemo = async (script) => { await c.send('WebDriver:SwitchToWindow', { handle: demoHandle }); return val(await c.send('WebDriver:ExecuteScript', { script })); };
  try { const { execSync } = await import('node:child_process'); execSync(`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${ff.pid}) to true'`); await sleep(800); console.log('frontmost: ok'); } catch (e) { console.log('frontmost failed:', String(e).slice(0, 120)); }
  console.log('helper has API:', await inHelper(`return typeof browser + '/' + typeof browser.tabs`));
  console.log('tabs:', await inHelper(`return browser.tabs.query({}).then(ts => JSON.stringify(ts.map(t => [t.id, t.url, t.active])))`));
  const demoTabId = await inHelper(`return browser.tabs.query({}).then(ts => ts.find(t => (t.url || '').includes('8766'))?.id)`);
  if (typeof demoTabId !== 'number') throw new Error('demo tab not found: ' + demoTabId);
  console.log('demo tab id:', demoTabId, ' content script:', await inHelper(`return browser.tabs.sendMessage(${demoTabId}, { type: 'pr:ping' }).then(JSON.stringify, e => 'ERR ' + e.message)`));
  // create two edits like the menu would
  await inDemo(`const p = document.querySelector('p:not(.sub)'); const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 40); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString();`);
  const e1 = await inHelper(`return browser.tabs.sendMessage(${demoTabId}, { type: 'pr:mark-selection' }).then(r => browser.tabs.sendMessage(${demoTabId}, { type: 'pr:update', id: r.edit.id, patch: { replacement: 'Short version', reason: 'verbose', note: 'n' } }).then(() => r.edit.id))`);
  await inDemo(`document.body.click(); const p = document.querySelectorAll('p:not(.sub)')[1]; const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 20); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 1;`);
  const e2 = await inHelper(`return browser.tabs.sendMessage(${demoTabId}, { type: 'pr:mark-selection' }).then(r => r.edit.id)`);
  await inDemo('document.body.click(); return 1;');
  console.log('edits created:', e1, e2, ' marks on page:', await inDemo(`return document.querySelectorAll('.page-redline-del').length`));

  const openPopup = () => chrome(`
    const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    const ext = WebExtensionPolicy.getByID('${ID}').extension;
    return Promise.resolve(ExtensionParent.apiManager.global.browserActionFor(ext).triggerAction(win)).then(() => 'triggered', e => 'trigger failed: ' + e);`);
  const inspect = async () => {
    const panel = await chrome(`
      const win = Services.wm.getMostRecentWindow('navigator:browser');
      const panels = [...win.document.querySelectorAll('panel')].filter(p => p.state !== 'closed').map(p => p.id + ':' + p.state);
      const b = win.document.querySelector('browser.webextension-popup-browser, browser[webextension-view-type="popup"]');
      const btn = win.CustomizableUI.getWidget('${WID}').forWindow(win).node;
      const fe = win.document.activeElement;
      return JSON.stringify({ panels, browser: b ? { w: b.clientWidth, h: b.clientHeight } : null, btnOpen: btn && btn.getAttribute('open'), windowActive: Services.focus.activeWindow === win, focused: fe && (fe.id || fe.localName) });`);
    const views = await inHelper(`return JSON.stringify(browser.extension.getViews({ type: 'popup' }).map(v => ({ bodyH: v.document.body.offsetHeight, text: v.document.body.innerText.slice(0, 60).replace(/\\n+/g, ' | ') })))`);
    return panel + ' views=' + views;
  };
  const closePopup = () => chrome(`const win = Services.wm.getMostRecentWindow('navigator:browser'); for (const p of win.document.querySelectorAll('panel')) if (p.state !== 'closed') p.hidePopup(); return 'closed';`);

  // Real OS mouse events via sendNativeMouseEvent. Coordinates: screen device pixels.
  const NATIVE = `
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    const wu = win.windowUtils;
    const scale = wu.screenPixelsPerCSSPixel || win.devicePixelRatio;
    const toScreen = (r) => [Math.round((r.left + r.width / 2 + win.mozInnerScreenX) * scale), Math.round((r.top + r.height / 2 + win.mozInnerScreenY) * scale)];
    const nativeClick = (x, y, el) => new Promise((resolve) => {
      const obs = { observe() { } };
      wu.sendNativeMouseEvent(x, y, wu.NATIVE_MOUSE_MESSAGE_MOVE, 0, 0, el, obs);
      win.setTimeout(() => {
        wu.sendNativeMouseEvent(x, y, wu.NATIVE_MOUSE_MESSAGE_BUTTON_DOWN, 0, 0, el, obs);
        win.setTimeout(() => { wu.sendNativeMouseEvent(x, y, wu.NATIVE_MOUSE_MESSAGE_BUTTON_UP, 0, 0, el, obs); resolve('clicked ' + x + ',' + y); }, 80);
      }, 80);
    });`;
  const nativeOpen = () => chrome(NATIVE + `
    const btn = win.CustomizableUI.getWidget('${WID}').forWindow(win).node;
    const [x, y] = toScreen(btn.getBoundingClientRect());
    return nativeClick(x, y, btn);`);
  const nativeClickPage = () => chrome(NATIVE + `
    const b = win.gBrowser.selectedBrowser;
    const r = b.getBoundingClientRect();
    const [x, y] = toScreen({ left: r.left, top: r.top + r.height * 0.75, width: r.width, height: 0 });
    return nativeClick(x, y, b);`);
  const viewFor = () => chrome(`
    const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    const ext = WebExtensionPolicy.getByID('${ID}').extension;
    const action = ExtensionParent.apiManager.global.browserActionFor(ext);
    let vp = 'n/a';
    for (const url of ['resource:///modules/ExtensionPopups.sys.mjs', 'moz-src:///browser/components/extensions/ExtensionPopups.sys.mjs', 'resource://gre/modules/ExtensionPopups.sys.mjs']) {
      try { const { ViewPopup } = ChromeUtils.importESModule(url); const v = ViewPopup.for(ext, win); vp = v ? { destroyed: v.destroyed, panelState: v.panel && v.panel.state } : 'none'; break; } catch (e) { vp = 'module error'; }
    }
    return JSON.stringify({ viewPopup: vp, pendingPopup: !!action.pendingPopup });`);

  // Cycle on a page: reload, open (native click), dismiss by clicking the page, open again.
  const cycle = async (label, url, n = 3) => {
    console.log(`\n=== ${label} ===`);
    await c.send('WebDriver:SwitchToWindow', { handle: demoHandle });
    await c.send('WebDriver:Navigate', { url }); await sleep(2500);
    console.log(' content script:', await inHelper(`return browser.tabs.sendMessage(${demoTabId}, { type: 'pr:ping' }).then(JSON.stringify, e => 'ERR ' + e.message)`));
    // make sure there are a few edits on this page
    const n0 = await inHelper(`return browser.tabs.sendMessage(${demoTabId}, { type: 'pr:list' }).then(l => l.edits.length, e => 'ERR ' + e.message)`);
    if (n0 === 0) {
      for (let k = 0; k < 3; k++) {
        await inDemo(`const ps = [...document.querySelectorAll('main p, article p, p')].filter(p => p.textContent.trim().length > 60 && !p.querySelector('.page-redline-del')); const p = ps[${k}]; if (!p) return 0; const t = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode(); const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, Math.min(25, t.data.length)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 1;`);
        await inHelper(`return browser.tabs.sendMessage(${demoTabId}, { type: 'pr:mark-selection' }).then(r => r.ok ? browser.tabs.sendMessage(${demoTabId}, { type: 'pr:update', id: r.edit.id, patch: { replacement: 'better ${'$'}{${k}}', reason: 'verbose', note: 'n' } }) : r)`);
        await inDemo('document.body.click(); return 1;');
      }
    }
    console.log(' edits on page:', await inHelper(`return browser.tabs.sendMessage(${demoTabId}, { type: 'pr:list' }).then(l => l.edits.length + ' (anchored ' + l.edits.filter(e => e.anchored).length + ')', e => 'ERR ' + e.message)`));
    await c.send('WebDriver:SwitchToWindow', { handle: demoHandle });
    await c.send('WebDriver:Refresh'); await sleep(3000);
    console.log(' after reload, marks:', await inDemo(`return document.querySelectorAll('.page-redline-del').length`));
    for (let i = 1; i <= n; i++) {
      nativeOpen(); await sleep(1800);
      console.log(` open #${i}:`, await inspect());
      nativeClickPage(); await sleep(1000);
      console.log(`   after page click:`, await inspect());
    }
  };
  // Unpin the button so it lives in the unified extensions (puzzle-piece) panel, then open the popup from there.
  console.log('unpin:', await chrome(`const win = Services.wm.getMostRecentWindow('navigator:browser'); win.CustomizableUI.addWidgetToArea('${WID}', win.CustomizableUI.AREA_ADDONS); const pl = win.CustomizableUI.getPlacementOfWidget('${WID}'); return pl ? pl.area : 'unplaced';`));
  await c.send('WebDriver:SwitchToWindow', { handle: demoHandle });
  await c.send('WebDriver:Navigate', { url: 'http://127.0.0.1:8766/demo.html' }); await sleep(2000);
  const openFromMenu = async () => {
    // click the puzzle-piece button, then the extension's row inside the panel, both with native clicks
    const r1 = await chrome(NATIVE + `const b = win.document.getElementById('unified-extensions-button'); const [x, y] = toScreen(b.getBoundingClientRect()); return nativeClick(x, y, b);`);
    await sleep(1200);
    const r2 = await chrome(NATIVE + `
      const panel = win.document.getElementById('unified-extensions-panel');
      const area = win.document.getElementById('unified-extensions-area') || panel;
      const rows = [...area.children].map(el => el.localName + '[' + [...el.attributes].map(a => a.name + '=' + a.value.slice(0, 40)).join(' ') + ']');
      let item = [...area.querySelectorAll('*')].find(el => [...el.attributes].some(a => a.value.includes('page-redline') || a.value.includes('page_redline') || a.value === '${ID}'));
      if (!item) item = [...panel.querySelectorAll('toolbarbutton, unified-extensions-item')].find(el => (el.getAttribute('label') || el.textContent || '').includes('Page Redline'));
      if (!item) return 'no item; rows=' + rows.join(' ; ').slice(0, 600);
      const btn = item.localName === 'unified-extensions-item' ? (item.querySelector('.unified-extensions-item-action-button') || item) : item;
      const [x, y] = toScreen(btn.getBoundingClientRect());
      return nativeClick(x, y, btn).then(r => item.localName + '/' + btn.localName + '#' + btn.id + ': ' + r);`);
    return r1 + ' / ' + r2;
  };
  for (let i = 1; i <= 4; i++) {
    console.log(` menu open #${i}:`, await openFromMenu()); await sleep(1800);
    console.log('   state:', await inspect());
    nativeClickPage(); await sleep(1000);
    console.log('   after page click:', await inspect());
  }
  console.log('console:', await chrome(`return JSON.stringify(Services.console.getMessageArray().map(m => m.message).filter(m => /page-redline|moz-extension|popup/i.test(m)).slice(-8).map(m => m.slice(0, 200)))`));
} catch (e) { console.error('probe error:', e); }
finally { ff.kill(); await sleep(500); fs.rmSync(PROFILE, { recursive: true, force: true }); }
