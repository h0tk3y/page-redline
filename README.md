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
5. **Show / hide edits**: the toggle in the popup header, the right-click menu entry, or
   `Alt+Shift+H` hides every mark on every page (the text reads as if untouched) and shows
   them again. Edits are kept while hidden.
6. **Reasons and colors**: *Reasons…* in the popup (or the extension's options page) opens
   an editable list. Rename, recolor, reorder, add or remove reasons; a preview shows how
   marks will look. Marks on the page are tinted with their reason's color; marks without
   a reason stay red (removed) and green (replacement). Removing a reason keeps existing
   edits, which show it as a removed reason until you pick another.

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

## Layout

- `manifest.json` — MV3 manifest. `background.scripts` is for Firefox, `background.service_worker`
  for Chrome; each browser ignores the other key (Chrome logs a warning).
- `background.js` — context menu (mark, show/hide) and the keyboard shortcut.
- `content.js` / `content.css` — marking, inline editor (shadow DOM), storage, anchoring.
- `shared.js` — settings schema (visibility, reasons with colors) and defaults.
- `popup.html` / `popup.js` — the edit list and the show/hide toggle.
- `options.html` / `options.js` — the editable reasons list with colors.
- `icons/` — generated PNG icons.
