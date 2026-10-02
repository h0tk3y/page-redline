# Page Redline

A small browser extension (Chrome and Firefox, Manifest V3) for preparing page edits.
Select text on any page, mark it as invalid, and it is struck through in red. Optionally
give a replacement, which is shown in green right after the struck text, and a reason
(too verbose, unclear, incorrect, duplicate, outdated, off-topic, style, other) plus a
free-text note. Edits are stored per page and re-applied when you come back. The toolbar
popup lists every edit on the current page.

## Use

1. Select text on the page, right-click, choose **Mark as invalid…**.
2. In the small editor that opens, type a replacement (or leave it empty to only strike
   the text through), pick a reason, add a note. Enter saves, Esc closes.
3. Click any red or green mark later to edit or remove it.
4. Open the toolbar popup to see all edits on the page: edit replacements, reasons and
   notes inline, jump to an edit on the page, remove one, clear all, or copy the list as
   Markdown or JSON.
5. **Show / hide edits**: the toggle in the popup header hides every mark on every page
   (the text reads as if untouched) and shows them again. Edits are kept while hidden.
6. **Reasons and colors**: *Reasons…* in the popup (or the extension's options page) opens
   the settings. Struck-through text is tinted with the color of its reason (red when no
   reason is set); rename, recolor, reorder, add or remove reasons, with a live preview.
   Replacement text uses one **replacement color**, green by default, also set there.
   Removing a reason keeps existing edits, which show it as a removed reason until you
   pick another.

Marks never change the page's own text: they wrap it in spans, so unmarking restores the
page exactly. Edits are anchored by the exact text plus 32 characters of context on each
side, so they survive reloads and small layout changes; if the text is gone, the edit is
listed greyed out in the popup until the text appears again.

## Install (unpacked, no store)

**Chrome / Chromium / Edge:** open `chrome://extensions`, enable *Developer mode*, click
*Load unpacked*, pick this folder.

**Firefox:** open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on…*,
pick `manifest.json`. Then click the extension's toolbar icon, open *Permissions*, and
allow access to the sites you want (Firefox MV3 does not grant host access by default),
then reload the page. A temporary add-on is removed when Firefox quits; for a permanent
install the extension must be signed through addons.mozilla.org (free, unlisted is fine).

## Test

```
./test/run.sh
```

Runs `test/smoke.html` in headless Chrome and prints PASS/FAIL per check. The page stubs
the extension API, so the test exercises the content script's marking, replacement
rendering, removal and re-anchoring without installing the extension.

```
CHROME_BIN="/path/to/Google Chrome for Testing" node test/e2e.mjs
```

Loads the real unpacked extension into a headless Chrome and drives it over the DevTools
protocol: pings the content script, checks the context menu is registered, marks a
selection, lists edits, toggles visibility, reloads the page and checks re-anchoring, and
opens the popup and options pages. Branded Google Chrome 137+ ignores `--load-extension`,
so point `CHROME_BIN` at Chrome for Testing (`npx @puppeteer/browsers install chrome@stable`)
or Chromium.

## After editing the extension

Changes to `manifest.json`, `background.js`, `shared.js` or `content.js` only take effect
after you **reload the extension** (`chrome://extensions` → reload, or `about:debugging` →
Reload) and then reload the open pages. Until then the old manifest is still in force: new
content-script files are not injected, new menu items and the options page do not exist.
The popup is read from disk on every open, so it can look up to date while the rest is stale.

## Layout

- `manifest.json` — MV3 manifest. `background.scripts` is for Firefox, `background.service_worker`
  for Chrome; each browser ignores the other key (Chrome logs a warning).
- `background.js` — registers the context menu entry and forwards it to the content script.
- `content.js` / `content.css` — marking, inline editor (shadow DOM), storage, anchoring.
- `shared.js` — settings schema (visibility, reasons with colors) and defaults.
- `popup.html` / `popup.js` — the edit list and the show/hide toggle.
- `options.html` / `options.js` — the replacement color and the editable reasons list with colors.
- `icons/` — generated PNG icons.
