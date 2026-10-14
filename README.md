# Google Studio Hack

Unlimited AI image and video generation on Google Flow — automated through a local REST API, a Chrome extension, and an MCP server.

Instead of clicking through the Flow web UI one generation at a time, you queue a task over HTTP. The extension drives the real Flow page in your own logged-in browser session, waits for the result, downloads the file, and hands it back to your machine. No API keys, no third-party proxy, no per-request billing on your side.

## What you get

**Images — unlimited Nano Banana.** Every image model Flow exposes, in any aspect ratio:

- Nano Banana Pro
- Nano Banana 2 Lite
- Nano Banana 2.1
- 1:1, 16:9, 9:16, 4:3, 3:4

**Image-to-image.** Pass a local image and Flow uses it as the visual reference for the generation. The extension uploads it once, waits for it to finish landing, then runs your prompt.

**Video — unlimited Omni and Veo 3.** Any video model, in either supported ratio:

- Omni 1.1 Flash
- Veo 3.1 — Lite, Fast, or Quality
- 16:9 and 9:16

**Any format.** Results land on disk as whatever the model produced — JPEG, PNG, MP4 — named from your prompt, ready to use. Nothing is re-encoded or downscaled on the way through.

## Why it works

Google Flow is a browser app. The generation happens in your own Chrome or Edge session, against your own account. This project drives that session instead of replacing it, which is what makes it unlimited: there is no metered API in the path, only the UI you already have access to.

## Install

Three pieces: a browser extension, a local server, and an MCP server for agent access. The extension is **not** installed by npm — browsers only allow that manually.

**1. Load the extension**

```
Chrome/Edge → Extensions → Developer mode → Load unpacked
```

Select the `veo-automation-extension/` folder from the [repository](https://github.com/vakandi/google-flow-mcp).

**2. Start the server**

```bash
python3 server.py
```

Python standard library only — no pip install, no dependencies. It listens on port `9876`.

**3. Turn on server mode**

Click the extension icon in your toolbar. The popup has the server toggle, live status, endpoint, and your active task queue. The full side panel is one button away.

The extension picks up your Flow project URL from the panel, so it works on any project you own.

**4. Add the MCP server** (optional — only for agent use)

```bash
npx @vakandi/google-flow-mcp
```

Register it with your client:

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "npx",
      "args": ["google-flow-mcp"]
    }
  }
}
```

For OpenCode or Claude Code:

```bash
claude mcp add google-flow --scope user -- npx @vakandi/google-flow-mcp
```

Check the wiring end to end:

```bash
curl http://localhost:9876/api/health
```

`"extension_connected": true` means the browser side is alive and picking up work.

## Use it

### Image-to-image

Give the prompt and a local image. The image becomes Flow's visual reference.

```bash
curl -X POST http://localhost:9876/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "this logo, reimagined as a neon sign in a rainy alley",
    "mode": "textToImage",
    "model": "Nano Banana 2.1",
    "aspectRatio": "16:9",
    "imagePath": "/absolute/path/to/reference.png"
  }'
```

From an agent, the same thing with `image_path`:

```
flow_generate_image(
  prompt="this logo, reimagined as a neon sign in a rainy alley",
  image_path="/absolute/path/to/reference.png",
  model="Nano Banana 2.1",
  aspect_ratio="16:9"
)
```

The reference is uploaded once per task. If the run retries, it is not uploaded twice.

### Text-to-image

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

### Video

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

Results are written to `results/{task_id}/` as they finish.

## MCP tools

| Tool | What it does |
|------|--------------|
| `flow_generate_image` | Generate images, optionally from a local reference image |
| `flow_generate_video` | Generate video from a prompt |
| `flow_task_status` | Status, progress and downloaded files for one task |
| `flow_list_tasks` | Every task the server knows about |
| `flow_cancel_task` | Cancel a queued or running task |
| `flow_list_results` | Files already written to disk |
| `flow_health` | Whether the extension is connected and polling |

## How it fits together

- `server.py` — REST API and task queue. Threaded, standard library only.
- `veo-automation-extension/` — MV3 extension: toolbar popup, side panel, and the service worker that drives Flow.
- `mcp_server.py` — MCP tools wrapping the API for agent use. Also pure standard library.
- `scripts/` — shell helpers used while developing the extension.

The background-operation details, the message contract between popup and worker, and the MV3 constraints that shaped the code are documented in `veo-automation-extension/AGENTS.md`.

## Troubleshooting

**The extension is idle.** `curl http://localhost:9876/api/health` shows `"extension_connected": false`. Server mode is probably off — click the extension icon and turn it on.

**The task stays `processing`.** The Flow tab was in the background. Chrome throttles background tabs, so a generation makes no progress until the tab is visible. The extension brings its own window forward when a task starts; if you moved away, bring it back. A task that never reports back is failed automatically after 8 minutes rather than hanging forever.

**"Sorry, this image failed to generate."** Flow refuses some first attempts. The extension detects that card and clicks its **Retry** button once by itself; the task is only reported failed if the retry fails too.

**Nothing downloaded, but Flow generated something.** The tile diff needs the media grid to have rendered before the run starts. Reload the Flow tab manually once and run again.

**Logs.** The extension mirrors its step log to the local server, so you can read exactly where a run stopped without opening browser devtools:

```bash
curl http://localhost:9876/api/log
```

## Notes

Keep Edge or Chrome open with the extension loaded and a Flow project tab available. Starting a task brings the Flow window to the front — Chrome throttles background tabs, and a generation nobody is watching never finishes. This is deliberate.

Model names and available ratios come from the Flow UI and can change over time. If a model disappears from Flow, it stops working here too.

## License

MIT.