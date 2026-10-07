const api = globalThis.browser ?? globalThis.chrome;
const shared = globalThis.PageRedlineShared;
const $ = (s) => document.querySelector(s);
let settings = shared.normalizeSettings(null);

async function load() {
  const r = await api.storage.local.get(shared.SETTINGS_KEY);
  settings = shared.normalizeSettings(r[shared.SETTINGS_KEY]);
  render();
}

async function save() {
  await api.storage.local.set({ [shared.SETTINGS_KEY]: settings });
  renderPreview();
}

function render() {
  $('#replacement-color').value = settings.replacementColor;
  const list = $('#list');
  list.textContent = '';
  settings.reasons.forEach((r, i) => {
    const li = document.createElement('li');
    const color = document.createElement('input');
    color.type = 'color';
    color.value = r.color;
    color.title = 'Mark color';
    color.addEventListener('input', () => { r.color = color.value; renderPreview(); });
    color.addEventListener('change', () => { r.color = color.value; save(); });
    const label = document.createElement('input');
    label.type = 'text';
    label.value = r.label;
    label.placeholder = 'Reason';
    label.addEventListener('change', () => { r.label = label.value.trim() || r.label; label.value = r.label; save(); });
    label.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') label.blur(); });
    const up = document.createElement('button');
    up.textContent = '↑'; up.title = 'Move up'; up.disabled = i === 0;
    up.addEventListener('click', () => { settings.reasons.splice(i - 1, 0, settings.reasons.splice(i, 1)[0]); save(); render(); });
    const down = document.createElement('button');
    down.textContent = '↓'; down.title = 'Move down'; down.disabled = i === settings.reasons.length - 1;
    down.addEventListener('click', () => { settings.reasons.splice(i + 1, 0, settings.reasons.splice(i, 1)[0]); save(); render(); });
    const rm = document.createElement('button');
    rm.className = 'danger'; rm.textContent = '✕'; rm.title = 'Remove this reason';
    rm.addEventListener('click', () => {
      if (!confirm(`Remove the reason “${r.label}”? Existing edits keep it as a removed reason.`)) return;
      settings.reasons.splice(i, 1); save(); render();
    });
    li.append(color, label, up, down, rm);
    list.appendChild(li);
  });
  renderPreview();
}

const shown = (hex) => shared.displayColor(hex, window.matchMedia('(prefers-color-scheme: dark)').matches);

function renderPreview() {
  const p = $('#preview');
  p.textContent = '';
  if (!settings.reasons.length) { p.textContent = 'No reasons defined.'; return; }
  const rows = [{ label: 'no reason', color: '#d32f2f' }, ...settings.reasons];
  for (const r of rows) {
    const line = document.createElement('div');
    const del = document.createElement('span'); del.className = 'del'; del.textContent = r.label;
    del.style.setProperty('--c', shown(r.color));
    const ins = document.createElement('span'); ins.className = 'ins'; ins.textContent = 'replacement';
    ins.style.setProperty('--c', shown(settings.replacementColor));
    line.append(del, ins);
    p.appendChild(line);
  }
}

$('#replacement-color').addEventListener('input', () => { settings.replacementColor = $('#replacement-color').value; renderPreview(); });
$('#replacement-color').addEventListener('change', () => { settings.replacementColor = $('#replacement-color').value; save(); });
$('#replacement-reset').addEventListener('click', () => { settings.replacementColor = shared.DEFAULT_REPLACEMENT_COLOR; save(); render(); });

$('#add').addEventListener('click', () => {
  const palette = ['#d32f2f', '#ef6c00', '#fbc02d', '#388e3c', '#0288d1', '#7b1fa2', '#c2185b', '#5d4037', '#455a64'];
  const used = new Set(settings.reasons.map((r) => r.color));
  const color = palette.find((c) => !used.has(c)) || palette[settings.reasons.length % palette.length];
  settings.reasons.push({ id: shared.newReasonId(), label: 'New reason', color });
  save(); render();
  const inputs = document.querySelectorAll('#list input[type="text"]');
  const last = inputs[inputs.length - 1];
  if (last) { last.focus(); last.select(); }
});

$('#reset').addEventListener('click', () => {
  if (!confirm('Restore the default reasons, their colors and the replacement color? Your custom reasons will be removed.')) return;
  settings.reasons = shared.DEFAULT_REASONS.map((r) => ({ ...r }));
  settings.replacementColor = shared.DEFAULT_REPLACEMENT_COLOR;
  save(); render();
});

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[shared.SETTINGS_KEY] && document.activeElement && document.activeElement.tagName !== 'INPUT') load();
});

load();
