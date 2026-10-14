#!/usr/bin/env python3
"""MCP server exposing the Google Flow (Veo) generation REST API as MCP tools.

Pure stdlib — JSON-RPC 2.0 over stdio, no pip deps. Mirrors the repo convention
in AGENTS.md ("Python: stdlib-only").

Prerequisite: the Chrome extension must be loaded and polling `server.py`.
This server auto-starts `server.py` on first use if the port is closed.

Environment:
    FLOW_API_URL — base URL of the Flow REST server (default http://localhost:9876)
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_URL = os.environ.get("FLOW_API_URL", "http://localhost:9876").rstrip("/")
REPO_DIR = Path(__file__).resolve().parent
SERVER_SCRIPT = REPO_DIR / "server.py"
RESULTS_DIR = REPO_DIR / "results"

PROTOCOL_VERSION = "2024-11-05"
_server_proc: subprocess.Popen | None = None


# ── REST client ──────────────────────────────────────────────────────────────
def _request(method: str, path: str, body: dict | None = None, timeout: int = 15):
    """Call the Flow REST API. Returns (status_code, parsed_json_or_None)."""
    data = json.dumps(body).encode() if body is not None else None
    sep = "&" if "?" in path else "?"
    req = urllib.request.Request(
        f"{BASE_URL}{path}{sep}probe=1",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw.decode("utf-8", "replace")}
    except Exception as e:
        return 0, {"error": str(e)}


def is_up() -> bool:
    status, _ = _request("GET", "/api/health?probe=1", timeout=3)
    return status == 200


def ensure_server() -> tuple[bool, str]:
    """Start server.py if it is not listening. Returns (ok, detail)."""
    global _server_proc
    if is_up():
        return True, "already running"
    if not SERVER_SCRIPT.is_file():
        return False, f"server.py not found at {SERVER_SCRIPT}"
    try:
        _server_proc = subprocess.Popen(
            [sys.executable, str(SERVER_SCRIPT)],
            cwd=str(REPO_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as e:
        return False, f"failed to spawn: {e}"
    for _ in range(20):
        if is_up():
            return True, "started"
        time.sleep(0.5)
    return False, "spawned but port never opened"


# ── Tool implementations ─────────────────────────────────────────────────────
def tool_health(_args: dict) -> dict:
    status, data = _request("GET", "/api/health?probe=1", timeout=5)
    if status != 200:
        started, detail = ensure_server()
        if not started:
            return {"ok": False, "api_url": BASE_URL, "error": detail}
        status, data = _request("GET", "/api/health?probe=1", timeout=5)
    connected = data.get("extension_connected")
    state = data.get("client_state", "unknown")
    # The server distinguishes three situations that all look identical from the outside:
    # nothing is talking at all, something is talking but never polls, or it polls properly.
    guidance = {
        "no_contact": (
            "No extension has ever reached this server. The extension is not loaded, or its "
            "service worker is dead. Reload it in Chrome/Edge and open the side panel once."
        ),
        "reachable_but_not_polling": (
            "The extension is talking to the server but never polls, so server mode is off. "
            "Open the side panel and switch the server toggle ON."
        ),
        "polling": "Extension is polling. Queued tasks are picked up automatically.",
    }
    return {
        "ok": status == 200,
        "api_url": BASE_URL,
        "tasks_total": data.get("tasks_total"),
        "uptime_seconds": data.get("uptime_seconds"),
        "extension_connected": connected,
        "client_state": state,
        "note": guidance.get(state, "Unknown client state."),
    }


def _wait_for_task(task_id: str, timeout: int) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        status, task = _request("GET", f"/api/queue/{task_id}")
        if status != 200:
            return {"ok": False, "error": task.get("error", "task not found")}
        last = task
        state = task.get("status")
        if state in ("completed", "failed", "cancelled"):
            break
        time.sleep(3)
    else:
        # A task stuck at "pending" means no extension ever claimed it. Say so precisely:
        # a blind "timed out" sends people hunting the wrong layer (selectors, clicks, prompts)
        # when the real cause is that the extension is not talking to the server at all.
        stalled_pending = bool(last and last.get("status") == "pending")
        _, health = _request("GET", "/api/health?probe=1", timeout=5)
        out = {
            "ok": False,
            "status": last.get("status") if last else "unknown",
            "error": f"timed out after {timeout}s",
            "task_id": task_id,
        }
        if stalled_pending and not health.get("extension_connected"):
            out["error"] = (
                "No extension has polled this server, so the task was never picked up. "
                "Reload the Chrome/Edge extension and switch server mode ON."
            )
            out["cause"] = "extension_not_connected"
            out["extension_connected"] = False
        elif stalled_pending:
            out["cause"] = "extension_connected_but_idle"
            out["extension_connected"] = True
        if stalled_pending:
            _request("DELETE", f"/api/queue/{task_id}", timeout=5)
            out["cancelled_orphan"] = True
        return out

    files = sorted(
        p.name for p in (RESULTS_DIR / task_id).iterdir()
        if (RESULTS_DIR / task_id).is_dir() and p.is_file()
    ) if (RESULTS_DIR / task_id).is_dir() else []
    return {
        "ok": last.get("status") == "completed",
        "task_id": task_id,
        "status": last.get("status"),
        "progress": last.get("progress"),
        "error": last.get("error"),
        "files": files,
        "files_dir": str(RESULTS_DIR / task_id),
        "result_urls": last.get("result_urls", []),
    }


def _generate(args: dict, default_mode: str) -> dict:
    prompt = (args.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "prompt is required"}

    started, detail = ensure_server()
    if not started:
        return {"ok": False, "error": f"Flow REST server unavailable: {detail}"}

    prompts = [p.strip() for p in prompt.split("\n") if p.strip()]
    mode = args.get("mode") or default_mode
    # The server's default model is a video model, so an image request inherited "Veo 3.1 - Fast"
    # and Flow produced nothing usable. Pick a model that matches the mode unless one is given.
    default_model = "Nano Banana 2.1" if mode == "textToImage" else "Veo 3.1 - Fast"
    payload = {
        "prompts": prompts,
        "mode": mode,
        "model": args.get("model") or default_model,
        "aspectRatio": args.get("aspect_ratio") or "16:9",
        "outputCount": int(args.get("count") or 1),
    }
    if args.get("duration"):
        payload["videoOption"] = args["duration"]
    if args.get("image_path"):
        try:
            raw = Path(args["image_path"]).expanduser().read_bytes()
        except Exception as e:
            return {"ok": False, "error": f"cannot read image_path: {e}"}
        payload["imageBase64"] = base64.b64encode(raw).decode("ascii")
        payload["imageName"] = Path(args["image_path"]).name
    if args.get("wait", True):
        payload["_mcp_wait"] = True

    status, task = _request("POST", "/api/generate", payload)
    if status not in (200, 201):
        return {"ok": False, "error": task.get("error", f"HTTP {status}")}

    task_id = task.get("id")
    if not args.get("wait", True):
        return {
            "ok": True,
            "task_id": task_id,
            "status": task.get("status"),
            "prompts_queued": len(prompts),
            "note": "Not waiting. Poll with flow_task_status.",
        }

    result = _wait_for_task(task_id, int(args.get("timeout") or 900))
    result["prompts_queued"] = len(prompts)
    return result


def tool_generate_video(args: dict) -> dict:
    """mode defaults to textToVideo."""
    return _generate(args, "textToVideo")


def tool_generate_image(args: dict) -> dict:
    """mode defaults to textToImage."""
    return _generate(args, "textToImage")


def tool_task_status(args: dict) -> dict:
    task_id = args.get("task_id")
    if not task_id:
        return {"ok": False, "error": "task_id is required"}
    status, task = _request("GET", f"/api/queue/{task_id}")
    if status != 200:
        return {"ok": False, "error": task.get("error", "task not found")}
    task_dir = RESULTS_DIR / task_id
    files = sorted(p.name for p in task_dir.iterdir() if p.is_file()) if task_dir.is_dir() else []
    return {
        "ok": True,
        "task_id": task_id,
        "status": task.get("status"),
        "progress": task.get("progress"),
        "error": task.get("error"),
        "files": files,
        "files_dir": str(task_dir),
    }


def tool_list_tasks(_args: dict) -> dict:
    status, data = _request("GET", "/api/queue")
    if status != 200:
        return {"ok": False, "error": data.get("error", f"HTTP {status}")}
    return {
        "ok": True,
        "count": len(data.get("tasks", [])),
        "tasks": [
            {
                "id": t.get("id"),
                "status": t.get("status"),
                "progress": t.get("progress"),
                "mode": t.get("mode"),
                "prompts": t.get("prompts", [])[:3],
            }
            for t in data.get("tasks", [])
        ],
    }


def tool_cancel_task(args: dict) -> dict:
    task_id = args.get("task_id")
    if not task_id:
        return {"ok": False, "error": "task_id is required"}
    status, data = _request("DELETE", f"/api/queue/{task_id}")
    _request("POST", "/api/result", {"task_id": task_id, "status": "cancelled"})
    return {"ok": status == 200, "task_id": task_id, "detail": data}


def tool_list_results(args: dict) -> dict:
    """List finished media files on disk."""
    task_id = args.get("task_id")
    root = RESULTS_DIR / task_id if task_id else RESULTS_DIR
    if not root.is_dir():
        return {"ok": False, "error": f"no results directory at {root}"}
    out = []
    for d in sorted(root.iterdir()) if root == RESULTS_DIR else [root]:
        if not d.is_dir():
            continue
        for f in sorted(d.iterdir()):
            if f.is_file():
                out.append({"task_id": d.name, "file": f.name, "path": str(f),
                            "size": f.stat().st_size})
    return {"ok": True, "count": len(out), "results": out}


# ── MCP tool registry ─────────────────────────────────────────────────────────
TOOLS = [
    {
        "name": "flow_generate_video",
        "description": "Generate videos on Google Flow (Veo) via the Flow Automation Chrome extension. Blocks until the task completes and returns local file paths.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Prompt text. Use \\n to submit several prompts as a batch."},
                "count": {"type": "integer", "description": "Outputs per prompt (default 1).", "default": 1},
                "aspect_ratio": {"type": "string", "description": "Video mode offers only '16:9' and '9:16'. The other three are image-only.", "default": "16:9"},
                "duration": {"type": "string", "description": "Currently accepted but NOT applied: Flow exposes no duration control, so this is ignored."},
                "model": {"type": "string", "description": "One of: 'Omni 1.1 Flash', 'Veo 3.1 - Lite', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality'.", "default": "Veo 3.1 - Fast"},
                "mode": {"type": "string", "description": "Override mode (default textToVideo)."},
                "wait": {"type": "boolean", "description": "Block until done (default true).", "default": True},
                "timeout": {"type": "integer", "description": "Seconds to wait (default 900).", "default": 900},
            },
            "required": ["prompt"],
        },
        "handler": tool_generate_video,
    },
    {
        "name": "flow_generate_image",
        "description": "Generate images on Google Flow via the Flow Automation Chrome extension. Blocks until complete and returns local file paths.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Prompt text. Use \\n to submit several prompts as a batch."},
                "image_path": {"type": "string", "description": "Absolute path to a local image to upload as the generation reference (image-to-image). The upload is awaited before the prompt is submitted."},
                "count": {"type": "integer", "description": "Images per prompt (default 1).", "default": 1},
                "aspect_ratio": {"type": "string", "description": "Any of '16:9', '9:16', '1:1', '4:3', '3:4'.", "default": "16:9"},
                "model": {"type": "string", "description": "One of: 'Nano Banana Pro', 'Nano Banana 2 Lite', 'Nano Banana 2.1'.", "default": "Nano Banana 2.1"},
                "mode": {"type": "string", "description": "Override mode (default textToImage)."},
                "wait": {"type": "boolean", "description": "Block until done (default true).", "default": True},
                "timeout": {"type": "integer", "description": "Seconds to wait (default 900).", "default": 900},
            },
            "required": ["prompt"],
        },
        "handler": tool_generate_image,
    },
    {
        "name": "flow_task_status",
        "description": "Get status, progress and downloaded files for one Flow task.",
        "inputSchema": {
            "type": "object",
            "properties": {"task_id": {"type": "string"}},
            "required": ["task_id"],
        },
        "handler": tool_task_status,
    },
    {
        "name": "flow_list_tasks",
        "description": "List all queued/finished Flow tasks with status and progress.",
        "inputSchema": {"type": "object", "properties": {}},
        "handler": tool_list_tasks,
    },
    {
        "name": "flow_cancel_task",
        "description": "Cancel a queued Flow task.",
        "inputSchema": {
            "type": "object",
            "properties": {"task_id": {"type": "string"}},
            "required": ["task_id"],
        },
        "handler": tool_cancel_task,
    },
    {
        "name": "flow_list_results",
        "description": "List generated media files on disk. Optionally filter to one task_id.",
        "inputSchema": {
            "type": "object",
            "properties": {"task_id": {"type": "string"}},
        },
        "handler": tool_list_results,
    },
    {
        "name": "flow_health",
        "description": "Check the Flow REST server is reachable and report task counts.",
        "inputSchema": {"type": "object", "properties": {}},
        "handler": tool_health,
    },
]

TOOL_INDEX = {t["name"]: t for t in TOOLS}


# ── JSON-RPC stdio transport ──────────────────────────────────────────────────
def _write(msg: dict):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _result(req_id, result):
    _write({"jsonrpc": "2.0", "id": req_id, "result": result})


def _error(req_id, code, message):
    _write({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def handle(msg: dict):
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        _result(req_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "google-flow-mcp", "version": "1.0.0"},
        })
        return

    if method in ("notifications/initialized", "notifications/cancelled"):
        return

    if method == "ping":
        _result(req_id, {})
        return

    if method == "tools/list":
        _result(req_id, {"tools": [
            {k: v for k, v in t.items() if k != "handler"} for t in TOOLS
        ]})
        return

    if method == "tools/call":
        name = params.get("name")
        tool = TOOL_INDEX.get(name)
        if not tool:
            _error(req_id, -32602, f"Unknown tool: {name}")
            return
        try:
            out = tool["handler"](params.get("arguments") or {})
        except Exception as e:
            import traceback
            out = {"ok": False, "error": f"{type(e).__name__}: {e}",
                   "trace": traceback.format_exc()[-800:]}
        _result(req_id, {
            "content": [{"type": "text", "text": json.dumps(out, indent=2)}],
            "isError": not out.get("ok", True),
        })
        return

    if req_id is not None:
        _error(req_id, -32601, f"Method not found: {method}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception as e:
            sys.stderr.write(f"[flow-mcp] {type(e).__name__}: {e}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()