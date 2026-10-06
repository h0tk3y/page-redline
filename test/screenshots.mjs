// Produces the README screenshots by driving the real extension in a headless Chrome.
//   CHROME_BIN=/path/to/chrome-for-testing node test/screenshots.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const CHROME = process.env.CHROME_BIN;
if (!CHROME) { console.error('Set CHROME_BIN to a Chrome for Testing / Chromium binary.'); process.exit(2); }
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(EXT, 'docs');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'page-redline-shots-'));
const PORT = 9334;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  '--allow-file-access-from-files', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = async (p, init) => (await fetch(`http://127.0.0.1:${PORT}${p}`, init)).json();
async function connect(ws) {
  const sock = new WebSocket(ws); await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  let id = 0; const pending = new Map();
  sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); sock.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; };
  const shot = async (file, w, h) => { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false }); await sleep(300); const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64')); console.log('wrote', file); };
  return { send, evaluate, shot, close: () => sock.close() };
}
try {
  for (let i = 0; i < 50; i++) { try { await http('/json/version'); break; } catch { await sleep(200); } }
  await sleep(1500);
  const targets = await http('/json/list');
  let bg = null, extId = null;
  for (const t of targets.filter((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'))) {
    const c = await connect(t.webSocketDebuggerUrl);
    if ((await c.evaluate('chrome.runtime.getManifest().name')) === 'Page Redline') { bg = c; extId = new URL(t.url).host; break; }
    c.close();
  }
  if (!bg) throw new Error('extension not loaded');
  const page = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: 'file://' + path.join(EXT, 'test', 'demo.html') });
  await sleep(1200);
  const tabId = await bg.evaluate('chrome.tabs.query({url:"file://*/*"}).then(ts => ts[0].id)');
  const msg = (m) => bg.evaluate(`chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(m)})`);
  // select a phrase by text and mark it
  const mark = async (phrase, patch, kind = 'edit') => {
    await page.evaluate(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf(${JSON.stringify(phrase)}); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${phrase.length}); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } } return false; })()`);
    const r = await msg({ type: 'pr:mark-selection', kind });
    if (!r || !r.ok) throw new Error('mark failed for ' + phrase + ': ' + JSON.stringify(r));
    await msg({ type: 'pr:update', id: r.edit.id, patch });
    return r.edit.id;
  };
  await mark('In order to be able to configure the build, you first of all need to', { replacement: 'To configure the build,', reason: 'verbose', note: 'Say it in half the words.' });
  await mark('repositorys', { replacement: 'repositories', reason: 'incorrect' });
  const dupId = await mark('Plugins are declared in the settings file, never in a build file.', { replacement: '', reason: 'duplicate', note: 'Already said in the first sentence.' });
  await mark('The next page explains', { replacement: 'The next guide explains', reason: 'unclear' });
  const noteId = await mark('it contributes a schema that describes the software types', { note: 'Link to the schema language page here.', reason: 'style' }, 'note');
  await page.evaluate('document.getElementById("page-redline-host")?.style.setProperty("display","none")');
  await page.shot('page-marks.png', 1000, 620);
  // inline editor open on the duplicate
  await msg({ type: 'pr:open-editor', id: dupId });
  await sleep(400);
  await page.shot('page-editor.png', 1000, 620);
  await page.evaluate('document.getElementById("page-redline-host")?.style.setProperty("display","none")');
  // editor in note mode
  await msg({ type: 'pr:open-editor', id: noteId });
  await sleep(400);
  await page.shot('page-note.png', 1000, 620);
  await page.evaluate('document.getElementById("page-redline-host")?.style.setProperty("display","none")');
  // popup, pointed at the demo tab
  const pt = await http(`/json/new?chrome-extension://${extId}/popup.html`, { method: 'PUT' });
  const popup = await connect(pt.webSocketDebuggerUrl);
  await popup.send('Page.enable'); await popup.send('Runtime.enable'); await sleep(800);
  await popup.evaluate(`tabId = ${tabId}; refresh()`); await sleep(500);
  await popup.shot('popup.png', 380, 470);
  popup.close();
  // all-pages screen
  const at = await http(`/json/new?chrome-extension://${extId}/pages.html`, { method: 'PUT' });
  const allp = await connect(at.webSocketDebuggerUrl);
  await allp.send('Page.enable'); await allp.send('Runtime.enable'); await sleep(800);
  await allp.evaluate('document.querySelector("details").open = true');
  await sleep(200);
  await allp.shot('all-pages.png', 900, 560);
  allp.close();
  // options page
  const ot = await http(`/json/new?chrome-extension://${extId}/options.html`, { method: 'PUT' });
  const options = await connect(ot.webSocketDebuggerUrl);
  await options.send('Page.enable'); await options.send('Runtime.enable'); await sleep(800);
  await options.shot('options.png', 520, 800);
  options.close();
  page.close(); bg.close();
} catch (e) { console.error('screenshots failed:', e); process.exitCode = 1; }
finally { chrome.kill(); await sleep(300); fs.rmSync(PROFILE, { recursive: true, force: true }); }
