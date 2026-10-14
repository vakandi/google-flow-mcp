# Google Studio Hack

Unlimited AI image and video generation on Google Flow — automated through a local REST API and a Chrome extension.

Instead of clicking through the Flow web UI one generation at a time, you queue a task over HTTP. The extension drives the real Flow page in your own logged-in browser session, waits for the result, downloads the file, and hands it back to your machine. No API keys, no third-party proxy, no per-request billing on your side.

## What you get

**Images — unlimited Nano Banana.** Every image model Flow exposes, each in any aspect ratio:

- Nano Banana Pro
- Nano Banana 2 Lite
- Nano Banana 2.1
- 1:1, 16:9, 9:16, 4:3, 3:4

**Video — unlimited Omni and Veo 3.** Any video model, in either supported ratio:

- Omni 1.1 Flash
- Veo 3.1 — Lite, Fast, or Quality
- 16:9 and 9:16

**Any format.** Results land on disk as whatever the model produced — JPEG, PNG, MP4 — named from your prompt, ready to use. Nothing is re-encoded or downscaled on the way through.

## Why it works

Google Flow is a browser app. The generation happens in your own Chrome or Edge session, against your own account. This project drives that session instead of replacing it, which is what makes it unlimited: there is no metered API in the path, only the UI you already have access to.

## Install

**1. Load the extension**

```
Chrome/Edge → Extensions → Developer mode → Load unpacked
```

Select the `veo-automation-extension/` folder.

**2. Start the server**

```bash
python3 server.py
```

Python standard library only. No pip install, no dependencies. It listens on port `9876`.

**3. Turn on server mode**

Click the extension icon in your toolbar. The popup has the server toggle, live status, endpoint, and your active task queue. The full side panel is one button away.

The extension picks up your Flow project URL from the panel, so it works on any project you own.

## Use it

Generate an image:

```bash
curl -X POST http://localhost:9876/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a red apple on a wooden table, studio lighting",
    "mode": "textToImage",
    "model": "Nano Banana 2.1",
    "aspectRatio": "1:1"
  }'
```

Generate video:

```bash
curl -X POST http://localhost:9876/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "slow aerial push over a coastline at dusk",
    "mode": "textToVideo",
    "model": "Veo 3.1 - Fast",
    "aspectRatio": "16:9"
  }'
```

Or drive it from the MCP server in `mcp_server.py`, which exposes the same generation, status, and file tools to an agent.

Results are written to `results/{task_id}/` as they finish.

## How it fits together

- `server.py` — REST API and task queue. Threaded, standard library only.
- `veo-automation-extension/` — MV3 extension: toolbar popup, side panel, and the service worker that drives Flow.
- `mcp_server.py` — MCP tools wrapping the API for agent use.

The background-operation details, the message contract between popup and worker, and the MV3 constraints that shaped the code are documented in `veo-automation-extension/AGENTS.md`.

## Notes

Keep Edge or Chrome open with the extension loaded and a Flow project tab available. Chrome throttles background tabs, so the automation keeps its tab active inside its own window — but it never brings that window to the front of your screen.

Model names and available ratios come from the Flow UI and can change over time. If a model disappears from Flow, it stops working here too.

## License

MIT.
