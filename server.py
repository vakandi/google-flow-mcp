#!/usr/bin/env python3
"""Flow Automation REST API — stdlib only, zero pip dependencies.
Extension polls this server for tasks; external tools (curl, Python) submit via HTTP.
"""
import json, os, time, uuid, threading, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

PORT = 9876
RESULTS_DIR = Path(__file__).parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)
_start_time = time.time()


class TaskStore:
    _lock = threading.Lock()
    _tasks: list = []
    _poll_times: list = []
    _last_poll_at: float | None = None
    _last_seen_at: float | None = None

    _RECENT_WINDOW = 90.0
    _MIN_RECENT_POLLS = 2

    @classmethod
    def note_seen(cls) -> None:
        with cls._lock:
            cls._last_seen_at = time.time()

    @classmethod
    def last_seen_at(cls) -> float | None:
        return cls._last_seen_at

    @classmethod
    def client_state(cls) -> str:
        now = time.time()
        seen = cls._last_seen_at
        # Chrome caps alarms at one per 30s and may delay them arbitrarily, so a single
        # poll can be minutes old while the extension is perfectly healthy. Requiring
        # repeated polls inside a window distinguishes a running alarm from one stale
        # hit, without either false-alarming on jitter or false-clearing on a leftover.
        cutoff = now - cls._RECENT_WINDOW
        recent = len([t for t in cls._poll_times if t >= cutoff])
        if recent >= cls._MIN_RECENT_POLLS:
            return "polling"
        if seen and (now - seen) < 300:
            return "reachable_but_not_polling"
        return "no_contact"

    @classmethod
    def add(cls, task: dict) -> dict:
        with cls._lock:
            task["created_at"] = time.time()
            task.setdefault("started_at", None)
            task.setdefault("completed_at", None)
            task.setdefault("result_urls", [])
            task.setdefault("result_files", [])
            cls._tasks.insert(0, task)
        return task

    @classmethod
    def get(cls, task_id: str) -> dict | None:
        with cls._lock:
            for t in cls._tasks:
                if t["id"] == task_id:
                    return dict(t)

    @classmethod
    def poll(cls) -> dict | None:
        with cls._lock:
            now = time.time()
            cls._last_poll_at = now
            cls._poll_times.append(now)
            cutoff = now - cls._RECENT_WINDOW
            if len(cls._poll_times) > 64:
                cls._poll_times = [t for t in cls._poll_times if t >= cutoff]
            for t in cls._tasks:
                if t.get("status") == "pending":
                    t["status"] = "processing"
                    t["started_at"] = time.time()
                    return dict(t)

    @classmethod
    def last_poll_at(cls) -> float | None:
        return cls._last_poll_at

    @classmethod
    def update(cls, task_id: str, updates: dict) -> dict | None:
        with cls._lock:
            for t in cls._tasks:
                if t["id"] == task_id:
                    t.update(updates)
                    task = dict(t)
                    break
            else:
                return None
        # Auto-download result files in background
        if updates.get("status") == "completed" and updates.get("result_urls"):
            threading.Thread(target=cls._download_files, args=(task_id, updates["result_urls"]), daemon=True).start()
        return task

    @classmethod
    def _download_files(cls, task_id: str, urls: list):
        task_dir = RESULTS_DIR / task_id
        task_dir.mkdir(parents=True, exist_ok=True)
        saved = []
        for i, url in enumerate(urls):
            try:
                filename = url.rstrip("/").split("/")[-1].split("?")[0] or f"result_{i}.mp4"
                if not filename or "." not in filename:
                    filename = f"result_{i}.mp4"
                filepath = task_dir / filename
                urllib.request.urlretrieve(url, filepath)
                # Flow asset URLs that require the browser session 302 to a Google login page.
                # urlretrieve happily writes that HTML to disk under a .jpg/.mp4 name, so the
                # task looks successful while the artifact is a sign-in form. Reject non-media
                # responses rather than reporting a download that cannot be opened.
                head = filepath.open("rb").read(512)
                if head[:5] == b"<!doc" or head[:14].lower().startswith(b"<!doctype"):
                    filepath.unlink(missing_ok=True)
                    print(f"[Download] Rejected {filename} for task {task_id}: got HTML login page, not media")
                    continue
                saved.append(filename)
                print(f"[Download] Saved {filename} ({filepath.stat().st_size}B) for task {task_id}")
            except Exception as e:
                print(f"[Download] Failed URL #{i} for task {task_id}: {e}")
        if saved:
            with cls._lock:
                for t in cls._tasks:
                    if t["id"] == task_id:
                        t.setdefault("result_files", []).extend(saved)
                        break

    @classmethod
    def all(cls) -> list:
        with cls._lock:
            return list(cls._tasks)

    @classmethod
    def delete(cls, task_id: str) -> bool:
        with cls._lock:
            for i, t in enumerate(cls._tasks):
                if t["id"] == task_id:
                    cls._tasks.pop(i)
                    return True
        return False


class LogStore:
    """Bounded ring of extension step logs.

    The content script's own logging goes to the service worker console, which is unreadable
    from outside the browser: an automation that stalls looks identical to one that never ran.
    """
    MAX = 800

    _lock = threading.Lock()
    _entries: list = []

    @classmethod
    def add(cls, entry: dict):
        entry = dict(entry)
        entry.setdefault("at", time.time())
        with cls._lock:
            cls._entries.append(entry)
            if len(cls._entries) > cls.MAX:
                del cls._entries[: len(cls._entries) - cls.MAX]

    @classmethod
    def since(cls, ts: float) -> list:
        with cls._lock:
            return [e for e in cls._entries if e.get("at", 0) > ts]


class Handler(BaseHTTPRequestHandler):
    def _send(self, data, status=200):
        # Every request produces exactly one _send, so this is the single place that can
        # record "something is talking to us" — which is what separates a dead service worker
        # from a live one that simply never entered server mode. Probes are excluded: the MCP
        # health check hits this same endpoint, and counting it would report the extension as
        # connected on the strength of our own request.
        if "probe" not in self._query_params():
            TaskStore.note_seen()
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def _send_file(self, filepath: Path):
        if not filepath.is_file():
            return self._send({"error": "file not found"}, 404)
        suffix = filepath.suffix.lower()
        mime = {"mp4": "video/mp4", "webm": "video/webm", "png": "image/png",
                "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
                "mp3": "audio/mpeg", "wav": "audio/wav", "zip": "application/zip",
                "json": "application/json"}.get(suffix.lstrip("."), "application/octet-stream")
        size = filepath.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f'attachment; filename="{filepath.name}"')
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        with open(filepath, "rb") as f:
            self.wfile.write(f.read())

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Without this Chrome silently drops the extension's fetch to loopback under Private
        # Network Access: no error, no request, no log line anywhere on either side.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def _parsed_path(self):
        from urllib.parse import urlparse
        return urlparse(self.path).path

    def _query_params(self):
        from urllib.parse import urlparse, parse_qs
        return parse_qs(urlparse(self.path).query)

    def do_GET(self):
        p = self._parsed_path()
        if p == "/api/health":
            return self._send({
                "status": "ok", "port": PORT,
                "tasks_total": len(TaskStore.all()),
                "uptime_seconds": int(time.time() - _start_time),
                "last_poll_at": TaskStore.last_poll_at(),
                "last_seen_at": TaskStore.last_seen_at(),
                "client_state": TaskStore.client_state(),
                # Derived from client_state so the two can never disagree; a second, looser
                # threshold here once reported "connected" while the poll was already dead.
                "extension_connected": TaskStore.client_state() == "polling"
            })
        if p == "/api/poll":
            task = TaskStore.poll()
            return self._send(task or {"empty": True})
        if p == "/api/queue":
            return self._send({"tasks": TaskStore.all()})
        if p == "/api/log":
            since = float(self._query_params().get("since", ["0"])[0] or 0)
            return self._send({"logs": LogStore.since(since)})
        if p.startswith("/api/results/") and p.endswith("/download"):
            parts = p.split("/")
            tid = parts[3]
            task = TaskStore.get(tid)
            if not task:
                return self._send({"error": "task not found"}, 404)
            task_dir = RESULTS_DIR / tid
            if not task_dir.is_dir():
                return self._send({"error": "no results"}, 404)
            qs = self._query_params()
            req_file = qs.get("file", [None])[0]
            if req_file:
                fp = task_dir / req_file
                if fp.is_file():
                    return self._send_file(fp)
                return self._send({"error": f"file '{req_file}' not found"}, 404)
            files = sorted(task_dir.iterdir())
            if not files:
                return self._send({"error": "no files"}, 404)
            return self._send_file(files[0])
        if p.startswith("/api/queue/"):
            tid = p.split("/")[-1]
            task = TaskStore.get(tid)
            if task:
                return self._send(task)
            return self._send({"error": "not found"}, 404)
        self._send({"error": "not found"}, 404)

    def do_POST(self):
        p = self._parsed_path()
        if p == "/api/log":
            entry = self._read_body()
            entries = entry if isinstance(entry, list) else [entry]
            for e in entries:
                if isinstance(e, dict):
                    LogStore.add(e)
            return self._send({"ok": True})
        if p == "/api/generate":
            body = self._read_body()
            prompts = body.get("prompts", [])
            if not prompts and body.get("prompt"):
                prompts = [body["prompt"]]
            if not prompts:
                return self._send({"error": "prompts or prompt required"}, 400)
            task = {
                "id": body.get("id", uuid.uuid4().hex[:12]),
                "prompts": prompts,
                "mode": body.get("mode", "textToVideo"),
                "model": body.get("model", "Veo 3.1 - Fast"),
                "aspectRatio": body.get("aspectRatio", "16:9"),
                "outputCount": body.get("outputCount", 1),
                "videoOption": body.get("videoOption", "6s"),
                "images": body.get("images", []),
                "imageBase64": body.get("imageBase64"),
                "imageName": body.get("imageName"),
                "characters": body.get("characters", []),
                "speaker": body.get("speaker"),
                "concurrentPrompts": body.get("concurrentPrompts", 1),
                "promptDelaySecondsMin": body.get("promptDelaySecondsMin", 0),
                "promptDelaySecondsMax": body.get("promptDelaySecondsMax", 0),
                "status": "pending",
                "progress": 0,
                "error": None,
            }
            TaskStore.add(task)
            return self._send(task, 201)
        if p == "/api/result":
            body = self._read_body()
            tid = body.get("task_id")
            if not tid:
                return self._send({"error": "task_id required"}, 400)
            updates = {k: body[k] for k in ("status", "progress", "result_urls", "result_files", "error") if k in body}
            if body.get("status") in ("completed", "failed", "cancelled"):
                updates["completed_at"] = time.time()
            TaskStore.update(tid, updates)
            return self._send({"success": True})
        self._send({"error": "not found"}, 404)

    def do_DELETE(self):
        p = self._parsed_path()
        if p.startswith("/api/queue/"):
            tid = p.split("/")[-1]
            if TaskStore.delete(tid):
                return self._send({"success": True})
            return self._send({"error": "not found"}, 404)
        self._send({"error": "not found"}, 404)

    def do_PUT(self):
        p = self._parsed_path()
        # PUT /api/results/<id>/upload/<filename>
        if p.startswith("/api/results/") and "/upload/" in p:
            parts = p.split("/")
            tid = parts[3]
            filename = "/".join(parts[5:])
            task_dir = RESULTS_DIR / tid
            task_dir.mkdir(parents=True, exist_ok=True)
            filepath = task_dir / filename
            length = int(self.headers.get("Content-Length", 0))
            if length == 0:
                return self._send({"error": "empty content"}, 400)
            with open(filepath, "wb") as f:
                f.write(self.rfile.read(length))
            with TaskStore._lock:
                for t in TaskStore._tasks:
                    if t["id"] == tid:
                        if filename not in t.setdefault("result_files", []):
                            t["result_files"].append(filename)
                        # A landed artifact IS completion. The worker sometimes uploads and
                        # then never reports a terminal status, which left the task stuck in
                        # processing forever and made every wait=true caller hang.
                        if t.get("status") == "processing":
                            t["status"] = "completed"
                            t["completed_at"] = time.time()
                            print(f"[Upload] Settled {tid} as completed from {filename}")
                        break
            print(f"[Upload] Saved {filename} ({length}B) for task {tid}")
            return self._send({"success": True, "filename": filename, "size": length})
        self._send({"error": "not found"}, 404)

    def log_message(self, fmt, *args):
        if len(args) >= 3:
            print(f"[Server] {args[0]} {args[1]} {args[2]}")


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[Server] Flow REST API running on http://127.0.0.1:{PORT}")
    print(f"[Server] Endpoints: POST /api/generate  GET /api/poll  GET /api/queue  POST /api/result  DELETE /api/queue/:id")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Server] Shutting down")
        server.server_close()


if __name__ == "__main__":
    main()
