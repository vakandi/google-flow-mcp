# Google Studio Hack

**Stack**: Python (stdlib) + Chrome MV3 Extension (Vue/TypeScript — pre-compiled)

## OVERVIEW
Automates Google Flow (labs.google.com/fx/tools/flow) video/image generation at scale. REST API server (`server.py`) queues tasks; Chrome extension opens Flow tabs, fills forms via content script, captures download URLs, and uploads results.

## STRUCTURE
```
./
├── server.py                             # REST API (port 9876, stdlib-only)
├── veo-automation-extension/             # OUR HACKED VERSION — work here
├── veo-automation-extension-original/    # ⛔ ORIGINAL — DO NOT TOUCH, reference only
├── docs/API-SERVER-PLAN.md              # Architecture doc (partially stale)
├── results/                             # Downloaded media artifacts
├── .sisyphus/                           # Sisyphus dev tool tracking
├── .playwright-mcp/                     # Playwright browser session recordings
├── AGENTS.md                            # ← this file
├── insights_*.png                       # Google Flow UI screenshots
└── __pycache__/                         # Python bytecode cache
```

## ⛔ CRITICAL RULE: NEVER TOUCH THE ORIGINAL
- **`veo-automation-extension-original/`** is the STORE VERSION (copied from Edge, has `key` + `update_url` in manifest).
- This folder exists ONLY as reference — to compare working original code vs our hacked version.
- **NEVER edit, never load unpacked, never modify** any file inside `veo-automation-extension-original/`.
- Always work in `veo-automation-extension/` (no `key`, no `update_url`).

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| REST API endpoints | `server.py` | All endpoints in one file |
| Task queue logic | `server.py` `TaskStore` class | Thread-safe in-memory queue |
| Extension service worker | `veo-automation-extension/assets/index.ts-DoSGWp_j.js` | Tab lifecycle, polling, downloads |
| Content script (Flow automation) | `veo-automation-extension/assets/index.ts-Bt6B9Lbt.js` | Form fill, generation monitoring |
| Side panel UI (Vue) | `veo-automation-extension/assets/index.html-B15jV9u5.js` | 162KLOC compiled Vue app |
| Server-mode UI patch | `veo-automation-extension/assets/server-panel.js` | Non-Vue DOM injection |
| Extension manifest | `veo-automation-extension/manifest.json` | Permissions, entry points |
| File upload intercept | `veo-automation-extension/assets/catchUploadFile.ts-DJwIizxX.js` | `HTMLInputElement` monkey-patch |
| Remote config | `veo-automation-extension/assets/remoteConfig-CbIdrXch.js` | External config fetcher |
| Original reference (DO NOT TOUCH) | `veo-automation-extension-original/` | Store version — compare only |
| Known bugs | `AGENTS.md` (below) | 24 documented issues |
| Server mode design (unimplemented) | `docs/API-SERVER-PLAN.md` | WebSocket+HTTP version |
| MCP tools | `mcp_server.py` | 7 tools wrapping the REST API; `flow_generate_image` accepts `image_path` |
| Toolbar popup | `veo-automation-extension/src/ui/popup/popup.{html,css,js}` | Primary UI: server toggle, health, task list, Open/Close side panel |

## IMAGE INPUT (IMAGE-TO-IMAGE)
The prompt field is a **ProseMirror `contenteditable` div** (`.ProseMirror`), not a
`<textarea>`. Flow exposes no file input and no reference slot there — see the known-bugs
table — so a reference image is attached by **pasting into that field**.

Verified on a live project (2026-10-13): dispatching a `ClipboardEvent('paste',{clipboardData})`
carrying a `File` is consumed by Flow (`dispatchEvent` returns false) and the image appears as
the **first tile of the media grid**, labelled with its filename (`ref.png`).

Two facts that are easy to get wrong:
- The pasted image is **not** rendered inside `.ProseMirror`; it appears in the right-hand
  grid. Do not conclude the paste failed by looking at the prompt field's HTML.
- The grid mixes uploads and generated assets. Upload URLs are `/image/<uuid>`, generated
  assets are `/asb/<opaque>`. Always exclude `/image/` before reporting a result.

Pipeline: `image_path` (MCP) → base64 → `imageBase64` on the task → worker maps it into the
existing `AUTO_FILL_FLOW` `images[]` field → content script uploads and awaits.
Verified byte-identical round-trip of a 763 KB image (1,018,064 base64 chars).

`catchUploadFile.ts-DJwIizxX.js` and the `images[]` plumbing predate this work and are
**not** sufficient on their own: with no `input[type=file]` in the DOM the hijack never fires.

## KNOWN BUGS
| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Tab creation URL 404 | `labs.google.com/flow` → 404 | Use `labs.google/fx/tools/flow` |
| Content script not injecting | `*://labs.google/*` no match `labs.google.com` | All patterns changed to `*://labs.google.com/*` |
| Infinite regeneration loop | Download failure re-adds prompt index | `_processedGenIndexes` Set skips re-submission |
| `folderName.trim()` crash | `t.folderName` is `undefined` | `(t.folderName \|\| "").trim()` |
| Ugly filenames from TRPC | Filename from TRPC path not media ID | Extract `name` query param from URL |
| Extension never contacts the server, no error anywhere | **Service worker crashed on load:** `chrome.alarms` is undefined because `"alarms"` was missing from `permissions`, so the top-level `chrome.alarms.onAlarm.addListener` threw and nothing after it ran | Add `"alarms"` to `permissions`. Check the SW console for `Uncaught TypeError` — the failure is otherwise completely silent |
| Server reports the extension as connected when it is not | The MCP's own health and queue polling was counted as client contact | All MCP calls send `?probe=1`; the server ignores probe requests when recording `last_seen_at` |
| Healthy extension reported as not polling | `client_state` used a 45s single-poll threshold, but Chrome may delay a 30s alarm arbitrarily | Require ≥2 polls inside a 90s window instead of guessing one threshold |
| `POST /api/generate` returns `{"error": "not found"}` | Routes compared the raw `self.path` by equality, so any query string (e.g. `?probe=1`) made every route miss | Route on `self._parsed_path()`, which strips the query — run the full MCP sweep after touching routing |
| Failed `wait=true` calls leave pending tasks that later run for nobody | The wait loop returned on timeout without deleting the unclaimed task, so once an extension connected it would execute those orphans and burn credits | On a `pending` timeout, `DELETE /api/queue/<id>` before returning (`cancelled_orphan`) |
| Task reports `completed` after ~25s with zero files, and no download happens | The automation loop marked a prompt "Download failed after generation" the instant it saw the same index a second time — before the download could finish. A real Flow generation takes 60-90s | Gate on `completedPromptIndexes.has(idx)` with a 3-attempt budget instead of a second sighting, and have the worker report `failed` when zero uploads succeeded |
| `1:1`, `4:3` and `3:4` silently fall back to the previous format | The aspect-ratio selector did `aspectRatio.replace(":", "_")`, so `1:1` searched for the text `1_1`. Only `16:9` and `9:16` happened to match, because their Material icons are literally named `crop_16_9` / `crop_9_16`; the others are `crop_square`, `crop_landscape`, `crop_portrait` and match nothing | Pass `aspectRatio` verbatim. The label text (`crop_square1:1`) carries the colon, so `[role="radio"]:contains("{aspectRatio}")` matches all five ratios — verified 1 match each |
| `outputCount=1` is never applied | The substitution was `t > 1 ? \`x${t}\` : "1x"`, so the default count of 1 searched for the text `1x`. Flow labels the count radios `x1`, `x2`, `x3`, `x4`, so `1x` matched 0 elements and the count was silently left unset | Drop the special case and always substitute `` `x${t}` `` — verified `x1`..`x4` each match exactly 1 radio |
| Video duration (`videoOption`) is silently ignored | `videoLengthTemplate` is only defined on the remote CDN and targets the retired labs.google DOM (`div[data-orientation="horizontal"] > div > button`), which matches **0** elements on flow.google.com. There is no local override, and the current Flow UI exposes no duration radio group at all — `8s` appears only inside a read-only summary pill (`Video · 720p · 8s …`) | Unresolved. Needs the real duration control located on the live UI before an override can be written. Note also that Flow only offers **16:9 and 9:16** in video mode; `1:1`, `4:3` and `3:4` are image-only |
| Task settles ~20s with 0 result urls, while the image really did generate | **The Angular (flow.google.com) path never downloads at all.** `H()` returns `{success:true, tileIds:[]}` immediately for Angular, so `X()` marks the prompt settled on the first pass. The download queue (`ee`) is **never pushed to by any code path**, so `U()` → `flowCollect()` were dead code on this UI. The group then reported `completed` with `resultUrls: []` at ~20s and the worker correctly reported `failed` | After `$()` returns success on the Angular path, call `U()` directly from `X()` and pass `_downloadRef: e.id`. That routes through `DOWNLOAD_VIDEO`, which already queues `_pendingDownloadFiles` for the worker to upload — **do not also push the urls onto `_resultUrls`**, that fetches the same image a second time. Also require a settled tile in `flowCollect`: reject `flow-pending-tile`/`.loading-percentage`, and accept only on `[data-media-id]`, a revealed `video[src]`, or `flow-video-tile`, since a pending tile ships a placeholder `img` that made the old predicate accept a tile still reading 99%. The `flow-video-tile` clause is required for video: a finished video tile's `<video src>` only appears after `flowRevealVideoUrl` clicks it, so keying on `[data-media-id]`/`video[src]` alone can reject a valid video and time out. Predicate verified 7/7 against a table of finished/pending image and video tiles — video remains untested end-to-end on the live site |
| Every generated file appears twice — once in `~/Downloads`, once in `results/` | `DOWNLOAD_VIDEO` ran `chrome.downloads.download` **and** pushed to `_pendingDownloadFiles`, so server-mode tasks were saved locally and uploaded. Not a prompt — `saveAs: false` already auto-accepts | Skip the browser download when `_downloadRef` is present (`if (!d && s !== false)` / `else if (!d)`), so server-mode tasks land only in `results/` |
| Saved files named `undefined_<prompt>.png` | `U()` derives the filename prefix from `config.promptIndex`, which the Angular path never sets | Pass `promptIndex: s.promptIndex ?? i` when calling `U()` |
| Task reports `failed` even though the file downloaded correctly | Two code paths drain the same `_pendingDownloadFiles` array: `flushPendingDownloads` runs on a 5s interval and `splice(0)`s **everything**, while the `PROMPT_GROUP_STATUS` completed handler filters by `taskId`. When the interval won the race it uploaded the file, leaving the completed handler with 0 pending files and 0 urls — so a successful download was reported as a failure | Make the server the source of truth: before declaring failure, GET `/api/queue/<taskId>` and count `result_files`. Treat the task as completed when `uploaded + onServer.length > 0`, so it no longer matters which drain path wins |
| `wait=true` never returns even though the file is on disk | The worker uploaded the artifact but never sent a terminal status, so the task stayed `processing` forever and every waiting caller hung | In `server.py`'s upload handler, a landed file **is** completion: if `status == "processing"`, flip it to `completed` and stamp `completed_at` |
| Image-to-image produced nothing, task failed with 0 result urls | The prompt bar has **no reference-image slot**. `catchUploadFile.ts-DJwIizxX.js` hijacks `HTMLInputElement.prototype.click`, but a live Flow project renders **zero** `input[type=file]` (verified: `hiddenFileFields: 0`), so the hijack has nothing to catch and the upload silently no-ops | Do not rely on the file-input hijack. Feed the image through the prompt field instead — see the clipboard-paste row below |
| Image upload walks the app into `/character`, so nothing generates | The remote-config selectors `addImageButton` / `uploadMediaButton` no longer match Flow's current UI. The uploader clicked them, landed on `.../project/<id>/character` (verified live: URL ended in `/character`, 0 tiles), and the subsequent prompt produced nothing — the task then reported `0 result url(s)` | Replace the uploader's click-based path with a direct paste into the `.ProseMirror` prompt editor (`ClipboardEvent('paste')` carrying a `File`), which is the only surface that accepts an image. The old implementation is parked as `__M_OLD__` for reference |
| Reference image pasted repeatedly until the grid filled with duplicates | The fill routine is re-entered on every retry and `M()` pasted unconditionally each time. A `data-veo-ref-pasted` DOM marker cannot prevent this: the worker **reloads the Flow tab at the start of every task**, which destroys the marker. Guarding on `e.taskId` is worse still — that field never reaches the content script's config | Guard on observable state instead: skip the paste when the grid already holds an `img[src*="/image/"]` tile **whose filename matches this task's image**. Matching the name (not just the presence) matters, because the previous run's reference stays in the grid and a blanket "/image/ exists" check would block every later image. Verified 5/5 by simulation |
| Attaching the reference to the composer fails; the asset picker re-opens forever | `flowAssetPane()` identified the open picker **by looking for `button.detail-add-to-prompt`**, which does not exist in the current Flow UI, so it returned `null` even with the picker visibly open (verified live: 10/10 frames showed `pickerOpen=true assetItems=15` while `addBtn=false`). The attach step then bailed every run, and each retry re-opened the picker — which is what looked like duplicate pasting | Detect the pane by `button.asset-item`, and drop the confirm step entirely: **selecting the asset IS the attach**. Verified by hand — clicking the item replaced the `@` in the composer with `<span class="mention-chip" data-reference-type="media">tiny.png</span>` and the picker closed itself (`paneOpen=false`). Do not force-close the pane after clicking; that races the in-flight attach and destroys it. Wait for the `mention-chip` instead — that is the only reliable success signal |
| A pasted reference image gets collected as the generated result | A pasted reference lands in the **same** grid as generated media, as the first tile. `flowCollect` walked new tiles and would happily return the input as the output | Skip any collected URL matching `/image/` — Flow serves uploads from `/image/<uuid>` and generated assets from `/asb/<opaque>`. Verified live: `ref.png` → `/image/46679376-…` sitting beside `/asb/ANqvLO…` generated tiles |

## CONVENTIONS
- **Python**: stdlib-only (`http.server`, `threading`, `json`, `pathlib`, `uuid`, `urllib.request`). No pip deps.
- **API**: REST on port 9876, JSON body, CORS wide-open (`*`). Task IDs = `uuid.hex[:12]`.
- **Task flow**: POST → pending → processing (via poll) → completed/failed/cancelled.
- **Content script**: `AUTO_FILL_FLOW` message triggers form automation on Flow tab.
- **Bundles**: Named `{sourceExt}-{contentHash}.js` (Vite convention). NOT built in-repo.

## ANTI-PATTERNS
- ~~No `.gitignore` at root~~ — **FIXED**: a root `.gitignore` now excludes `__pycache__/`,
  `.playwright-mcp/`, `results/`, `veo-automation-extension-original/` (holds the signing key)
  and env files. The store build was untracked on 2026-10-13.
- **No build tooling in-repo** — Extension cannot be modified at source level. Bundles are deploy-only.
- **`server-panel.js` bolt-on** — Side-panel server UI injected via `<script defer>` outside Vue app. Breaks if Vue re-renders the DOM.
- **Hardcoded secret** — `remoteConfig-CbIdrXch.js` has `X-Client-Secret` in plaintext.
- **Orphaned plan** — `docs/API-SERVER-PLAN.md` describes WebSocket server that was never built.
- **Screenshots at root** — `insights_*.png` pollute workspace top-level.

## COMMANDS
```bash
python3 server.py              # Start REST API on port 9876
# Extension: Chrome → Extensions → Load unpacked → veo-automation-extension/
curl -X POST http://localhost:9876/api/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cat playing piano"}'
```

## NOTES
- The extension is pre-built with Vite. Source `.ts` files are NOT in this repo.
- Server is single-threaded HTTP + background threads for file downloads.
- Results stored in `results/{task_id}/` on server filesystem.
- Extension service worker uses `chrome.alarms` for keepalive.
