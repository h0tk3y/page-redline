// Builds store-ready zips in dist/: one for Chrome Web Store, one for Firefox Add-ons.
// Each gets a manifest trimmed to what that browser understands, so neither store warns about
// the other's keys. Tests, docs, scripts and VCS files are excluded.
//   node scripts/package.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const FILES = ['background.js', 'content.css', 'content.js', 'shared.js', 'popup.html', 'popup.js', 'options.html', 'options.js', 'pages.html', 'pages.js', 'icons'];

function build(target) {
  const m = JSON.parse(JSON.stringify(manifest));
  if (target === 'chrome') {
    delete m.background.scripts;              // Chrome: service worker only
    delete m.browser_specific_settings;       // Firefox-only key
  } else {
    delete m.background.service_worker;       // Firefox: event page scripts only
  }
  const stage = path.join(DIST, `stage-${target}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const f of FILES) fs.cpSync(path.join(ROOT, f), path.join(stage, f), { recursive: true });
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  const zip = path.join(DIST, `page-redline-${version}-${target}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', '-X', zip, '.'], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });
  return zip;
}

fs.mkdirSync(DIST, { recursive: true });
for (const t of ['chrome', 'firefox']) {
  const zip = build(t);
  console.log(`${path.relative(ROOT, zip)}  ${(fs.statSync(zip).size / 1024).toFixed(0)} KB`);
}
