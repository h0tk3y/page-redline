// End-to-end probe: loads the real, unpacked extension into a headless Chrome and
// exercises background, content script, popup and options page over the DevTools protocol.
// Needs a Chrome that honors --load-extension (Chrome for Testing or Chromium; branded
// Google Chrome 137+ ignores it):  CHROME_BIN=/path/to/chrome node test/e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const CHROME = process.env.CHROME_BIN;
if (!CHROME) { console.error('Set CHROME_BIN to a Chrome for Testing / Chromium binary.'); process.exit(2); }
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'page-redline-e2e-'));
const FIXTURE = path.join(EXT, 'test', 'plain.html');
const PORT = 9333;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  '--allow-file-access-from-files', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; chrome.stderr.on('data', d => stderr += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
async function json(path) { const r = await fetch(`http://127.0.0.1:${PORT}${path}`); return r.json(); }
async function connect(ws) {
  const sock = new WebSocket(ws); await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  let id = 0; const pending = new Map(); const events = [];
  sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else events.push(d); };
  return { send: (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); sock.send(JSON.stringify({ id: i, method, params })); }), events, close: () => sock.close() };
}
try {
  for (let i = 0; i < 50; i++) { try { await json('/json/version'); break; } catch { await sleep(200); } }
  await sleep(1500);
  let targets = await json('/json/list');
  log('targets:', targets.map(t => `${t.type} ${t.url}`).join(' | '));
  let sw = null;
  for (const t of targets.filter(t => t.type === 'service_worker' && t.url.endsWith('/background.js'))) {
    const c = await connect(t.webSocketDebuggerUrl);
    const r = await c.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true });
    c.close();
    if (r.result?.result?.value === 'Page Redline') { sw = t; break; }
  }
  if (!sw) { log('NO SERVICE WORKER FOR PAGE REDLINE'); }
  const extId = sw ? new URL(sw.url).host : null;
  // open the test page in a tab
  const page = await connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await page.send('Runtime.enable'); await page.send('Page.enable'); await page.send('Log.enable');
  await page.send('Page.navigate', { url: 'file://' + FIXTURE });
  await sleep(1500);
  const pageErrors = page.events.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded').map(e => JSON.stringify(e.params).slice(0, 300));
  log('page console:', pageErrors.length ? pageErrors.join('\n') : '(none)');
  if (sw) {
    const bg = await connect(sw.webSocketDebuggerUrl);
    await bg.send('Runtime.enable');
    const ev = async (expr) => { const r = await bg.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? 'EXC ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 300) : JSON.stringify(r.result?.result?.value); };
    const pev = async (expr) => { const r = await page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? 'EXC ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 300) : JSON.stringify(r.result?.result?.value); };
    log('ping content script:', await ev('chrome.tabs.query({url:"file://*/*"}).then(ts => chrome.tabs.sendMessage(ts[0].id, {type:"pr:ping"})).catch(e => "ERR " + e.message)'));
    log('note menu exists (duplicate-id error expected):', await ev('new Promise(res => chrome.contextMenus.create({id:"page-redline-note", title:"p", contexts:["selection"]}, () => res(chrome.runtime.lastError ? chrome.runtime.lastError.message : "created-ok (menu was MISSING)")))'));
    log('our menu exists (duplicate-id error expected):', await ev('new Promise(res => chrome.contextMenus.create({id:"page-redline-mark", title:"p", contexts:["selection"]}, () => res(chrome.runtime.lastError ? chrome.runtime.lastError.message : "created-ok (menu was MISSING)")))'));
    // select text on the page, then fire the same message the context menu sends
    await pev('(() => { const p = document.getElementById("p1"); const r = document.createRange(); r.setStart(p.firstChild, 4); r.setEnd(p.childNodes[2], 6); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()');
    log('mark via message:', await ev('chrome.tabs.query({url:"file://*/*"}).then(ts => chrome.tabs.sendMessage(ts[0].id, {type:"pr:mark-selection"})).then(r => JSON.stringify(r)).catch(e => "ERR " + e.message)'));
    log('marks in page DOM:', await pev('document.querySelectorAll(".page-redline-del").length + " del, host=" + !!document.getElementById("page-redline-host")'));
    const tabIdExpr = await ev('chrome.tabs.query({url:"file://*/*"}).then(ts => ts[0].id)');
    log('command registered:', await ev('chrome.commands.getAll().then(cs => cs.map(c => c.name + "=" + c.shortcut).join(","))'));
    // Clicking the page closes the open card (a shortcut with the card open would flip that mark instead).
    await pev('(() => { document.body.click(); const p = document.getElementById("p2"); const r = document.createRange(); r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, 6); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()');
    log('mark via shortcut handler:', await ev(`chrome.commands.onCommand.dispatch("mark-selection", { id: ${tabIdExpr} }), new Promise(res => setTimeout(() => res("dispatched"), 400))`));
    log('list (expect n=2: menu + shortcut):', await ev('chrome.tabs.query({url:"file://*/*"}).then(ts => chrome.tabs.sendMessage(ts[0].id, {type:"pr:list"})).then(r => JSON.stringify({n:r.edits.length, visible:r.visible, reasons:r.reasons.length})).catch(e => "ERR " + e.message)'));
    log('toggle visibility via storage:', await ev('chrome.storage.local.get("settings").then(r => { const s = r.settings || {}; s.visible = false; return chrome.storage.local.set({settings: s}); }).then(() => "ok")'));
    await sleep(300);
    log('page hidden attr:', await pev('document.documentElement.hasAttribute("data-page-redline-hidden")'));
    log('reload page -> edits re-anchored:', (await page.send('Page.reload'), await sleep(1500), await pev('document.querySelectorAll(".page-redline-del").length')));
    log('storage keys:', await ev('chrome.storage.local.get(null).then(o => Object.keys(o))'));
    // popup + options pages
    for (const f of ['popup.html', 'options.html', 'pages.html']) {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/${f}`, { method: 'PUT' })).json();
      const c = await connect(t.webSocketDebuggerUrl); await c.send('Runtime.enable'); await sleep(1200);
      const errs = c.events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => e.params.exceptionDetails.exception?.description?.slice(0, 200));
      const body = await c.send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0, 160).replace(/\\n+/g, " | ")', returnByValue: true });
      log(`${f}: errors=${JSON.stringify(errs)} text=${JSON.stringify(body.result?.result?.value)}`);
      if (f === 'pages.html') {
        const imp = await c.send('Runtime.evaluate', { expression: `importFile(new File([JSON.stringify({ format: 'page-redline/1', pages: [{ url: 'https://example.test/doc', title: 'Imported doc', edits: [{ id: 'imp1', exact: 'foo', prefix: '', suffix: '', replacement: 'bar', reason: 'zzz', note: '', createdAt: 1 }] }], settings: { reasons: [{ id: 'zzz', label: 'Imported reason', color: '#112233' }] } })], 'x.json')).then(() => document.getElementById('stats').textContent + ' / ' + document.getElementById('flash').textContent)`, awaitPromise: true, returnByValue: true });
        log('  import:', JSON.stringify(imp.result?.result?.value ?? imp.result?.exceptionDetails?.text));
      }
      if (f === 'popup.html') log('  openOptionsPage:', JSON.stringify((await c.send('Runtime.evaluate', { expression: 'chrome.runtime.openOptionsPage().then(() => "ok", e => "ERR " + e.message)', awaitPromise: true, returnByValue: true })).result?.result?.value));
      c.close();
    }
    log('sw errors:', bg.events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => e.params.exceptionDetails.exception?.description?.slice(0, 200)).join('\n') || '(none)');
    bg.close();
  }
  // extension error page: chrome://extensions shows runtime errors; fetch via a new target
  page.close();
} catch (e) { log('script error', e); }
finally { chrome.kill(); await sleep(300); log('chrome stderr (filtered):', stderr.split('\n').filter(l => /extension|manifest|Error|error/i.test(l) && !/CVDisplayLink|updater|GoogleUpdater/.test(l)).slice(0, 15).join('\n') || '(none)'); fs.rmSync(PROFILE, { recursive: true, force: true }); }
