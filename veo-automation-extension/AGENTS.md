# veo-automation-extension — Chrome MV3 Extension

**Purpose**: Automates Google Flow video/image generation. Opens Flow tabs, fills forms, captures download URLs, uploads results.

## STRUCTURE
```
veo-automation-extension/
├── manifest.json                  # MV3 manifest (permissions, entry points)
├── service-worker-loader.js       # 1-line loader → assets/index.ts-DoSGWp_j.js
├── assets/                        # Pre-built bundles (Vite output)
│   ├── index.ts-DoSGWp_j.js       # Service worker (825 lines)
│   ├── index.ts-Bt6B9Lbt.js       # Content script (8.5K lines)
│   ├── index.html-B15jV9u5.js     # Side panel Vue app (162K lines)
│   ├── server-panel.js            # Server-mode UI DOM injection
│   ├── catchUploadFile.ts-DJwIizxX.js  # File upload monkey-patch
│   └── remoteConfig-CbIdrXch.js   # External config fetcher
├── src/
│   ├── ui/side-panel/index.html   # Side panel entry
│   ├── ui/popup/popup.html        # Toolbar popup entry (+ popup.css, popup.js)
│   └── assets/logo.png            # Extension icon
└── logo/                          # Chrome + Edge SVG logos
```

## WHERE TO LOOK
| Area | File | Notes |
|------|------|-------|
| Service worker logic | `assets/index.ts-DoSGWp_j.js` | Flow tab lifecycle, polling, WS client, downloads |
| Content script | `assets/index.ts-Bt6B9Lbt.js` | Form fill, auto-fill flow, gen monitoring |
| Side panel UI | `assets/index.html-B15jV9u5.js` | Vue 3 SPA with PrimeVue components |
| Server panel (bolt-on) | `assets/server-panel.js` | Standalone DOM injection (not part of Vue app) |
| Toolbar popup | `src/ui/popup/popup.{html,css,js}` | Primary UI: server toggle, health, task list, open-side-panel button |
| Permissions/entry points | `manifest.json` | `debugger`, `cookies`, host perms |
| File upload intercept | `assets/catchUploadFile.ts-DJwIizxX.js` | Monkey-patches `HTMLInputElement` |
| Remote config | `assets/remoteConfig-CbIdrXch.js` | Fetches selectors from CDN |

The popup talks to the worker only through existing messages — `SERVER_STATUS`,
`SERVER_START`, `SERVER_STOP`, `QUEUE_GET`. Add UI, never a new message type, unless the
worker genuinely needs new data. Its "Open side panel" button calls
`chrome.sidePanel.open()` and falls back to `chrome.tabs.create()` on the same URL, because
`sidePanel.open()` rejects when it loses the user-gesture context.

MV3 CSP is strict here: the popup uses an external `popup.js` and `addEventListener` only.
No inline `<script>`, no `onclick=`, no `eval` — each of those silently kills the popup.

## Running tasks: the Flow tab MUST be brought to the front

The worker **does** focus the Flow window, and that is deliberate. Google throttles a background
tab, so a queued task simply never starts: it sits in `processing` until the user manually
clicks the Flow tab. Verified on 2026-10-13 — with focus suppressed, tasks stalled indefinitely.

`focusTab()` therefore brings the tab forward:

- Reuse the Flow tab that is already open (exact project URL first, any Flow tab second); only
  create a tab when none exists.
- `chrome.windows.update(winId, {focused:true})` when the tab's window is not focused, then
  `chrome.tabs.update(tabId, {active:true})` when the tab is not active.
- The window check must run **before** any early return on `tab.active`. An active tab inside a
  background window is still throttled; returning early on `tab.active` was a real bug that left
  tasks hanging forever.

The trade-off is accepted knowingly: starting a task steals the user's screen. Anything that
hides the tab from the site's own activity detection is deliberately **not** here — that belongs
to the separate extension the user runs for it.

## CONVENTIONS (extension-specific)
- **Bundle naming**: `{sourceExt}-{contentHash}.js` (Vite content-hash). NOT built in-repo.
- **Side panel**: Vue 3 + PrimeVue (primeicons font files in `assets/`).
- **Content script messaging**: `AUTO_FILL_FLOW` → fills form. `PROMPT_GROUP_STATUS` → reports progress.
- **Task lifecycle**: pending → processing (via service worker poll) → completed/failed/cancelled.

## ANTI-PATTERNS (extension)
- **No TypeScript source in-repo** — only Vite-compiled JS bundles. Cannot modify without build tooling.
- **`server-panel.js` bypasses Vue** — injected via `<script defer>` in `index.html`. If Vue re-renders its mount point, the injected DOM disappears.
- **Hardcoded API secret** — `remoteConfig-CbIdrXch.js` sends `X-Client-Secret: YES_THAT_IS_VERY_EASY_RIGHT_?!$` in plaintext.
- **Logo triplication** — `logo.png` at extension root + `logo/chrome.svg` + `src/assets/logo.png`.
- **Remote config dependency** — Extension fetches selectors from `configs.kylenguyen.me` and `extension-config.onegreen.workers.dev`. Breaks if those endpoints go down.
