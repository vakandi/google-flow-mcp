(function () {
  "use strict";

  // Display/copy only — the panel never fetches; the service worker does, via sendMessage.
  // Keep this in sync with SERVER_URL in the service worker.
  const SERVER_HTTP_URL = "http://127.0.0.1:9876";
  const PROJECT_URL_KEY = "flowProjectUrl";
  let injectAttempts = 0;
  let pollTimer = null;
  let queueTimer = null;
  let injected = false;

  /* ── Styles ─────────────────────────────────────────────── */

  const STYLE_ID = "server-mode-injected-css";

  const styles =
    "#server-mode-section{margin-top:16px;padding-top:16px;border-top:1px solid var(--p-content-border-color,#e5e7eb)}" +
    "#server-mode-section h3{font-size:14px;font-weight:600;margin:0 0 12px 0;display:flex;align-items:center;gap:6px;color:var(--p-text-color,#111827)}" +
    ".server-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0}" +
    ".server-label{font-size:13px;color:var(--p-text-color,#374151)}" +
    ".server-status{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500}" +
    ".server-status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}" +
    ".server-status-dot.running{background:#22c55e}" +
    ".server-status-dot.stopped{background:#ef4444}" +
    ".server-status-dot.connecting{background:#f59e0b}" +
    ".server-status-dot.unknown{background:#9ca3af}" +
    ".server-url-box{display:flex;align-items:center;gap:6px;background:var(--p-surface-100,#f3f4f6);border:1px solid var(--p-content-border-color,#e5e7eb);border-radius:6px;padding:6px 10px;font-family:monospace;font-size:12px;color:var(--p-text-color,#374151)}" +
    ".server-url-box .url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".server-copy-btn{cursor:pointer;background:none;border:none;font-size:14px;padding:2px 6px;border-radius:4px;color:var(--p-text-secondary-color,#6b7280)}" +
    ".server-copy-btn:hover{background:var(--p-surface-200,#e5e7eb)}" +
    ".server-toggle{position:relative;width:40px;height:22px;background:#d1d5db;border-radius:11px;cursor:pointer;transition:background .2s;border:none;padding:0}" +
    ".server-toggle.active{background:var(--p-primary-color,#3b82f6)}" +
    ".server-toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 2px rgba(0,0,0,.15)}" +
    ".server-toggle.active::after{transform:translateX(18px)}" +
    ".server-toggle:disabled{opacity:.5;cursor:not-allowed}" +
    ".server-project-input{flex:1;min-width:0;margin-left:8px;padding:5px 8px;font-size:11px;font-family:monospace;border:1px solid var(--p-content-border-color,#e5e7eb);border-radius:5px;background:var(--p-surface-50,#f9fafb);color:var(--p-text-color,#374151)}" +
    ".server-project-input:focus{outline:none;border-color:var(--p-primary-color,#3b82f6);background:#fff}" +
    ".server-project-input.saved{border-color:#22c55e}" +
    ".server-queue-section{margin-top:12px}" +
    ".server-queue-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}" +
    ".server-queue-header span{font-size:13px;font-weight:500;color:var(--p-text-color,#374151)}" +
    ".server-refresh-btn{font-size:11px;padding:2px 8px;border:1px solid var(--p-content-border-color,#e5e7eb);border-radius:4px;background:var(--p-surface-50,#f9fafb);cursor:pointer;color:var(--p-text-secondary-color,#6b7280)}" +
    ".server-refresh-btn:hover{background:var(--p-surface-100,#f3f4f6)}" +
    ".server-task-item{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:4px;font-size:12px;margin-bottom:4px;background:var(--p-surface-50,#f9fafb);border:1px solid var(--p-content-border-color,#e5e7eb)}" +
    ".server-task-id{font-family:monospace;font-size:11px;color:var(--p-text-secondary-color,#6b7280);min-width:70px}" +
    ".server-task-mode{font-size:11px;color:var(--p-text-color,#374151);flex:1;padding:0 8px}" +
    ".server-task-status{font-size:11px;font-weight:500}" +
    ".server-task-status.queued{color:#6b7280}" +
    ".server-task-status.processing{color:#3b82f6}" +
    ".server-task-status.completed{color:#22c55e}" +
    ".server-task-status.failed{color:#ef4444}" +
    ".server-task-status.cancelled{color:#9ca3af}" +
    ".server-task-progress{font-size:11px;color:var(--p-text-secondary-color,#6b7280);min-width:32px;text-align:right}" +
    ".server-empty-queue{font-size:12px;color:var(--p-text-secondary-color,#9ca3af);padding:12px 0;text-align:center}" +
    ".server-close-btn{font-size:11px;padding:2px 8px;border:1px solid var(--p-content-border-color,#e5e7eb);border-radius:4px;background:var(--p-surface-50,#f9fafb);cursor:pointer;color:var(--p-text-secondary-color,#6b7280)}" +
    ".server-close-btn:hover{background:var(--p-surface-100,#f3f4f6)}" +
    ".server-close-bar{position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;background:var(--p-surface-0,#fff);border-bottom:1px solid var(--p-content-border-color,#e5e7eb);box-shadow:0 1px 4px rgba(0,0,0,.08)}" +
    ".server-error{font-size:11px;color:#ef4444;padding:2px 0;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";

  /* ── Inject styles ─────────────────────────────────────── */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = styles;
    document.head.appendChild(s);
  }

  /* ── Find Settings injection anchor ─────────────────────── */
  /* Instead of looking for a specific ID or role, we find the Save/Reset
     buttons at the bottom of the Settings tab and insert BEFORE them. */

  function findSettingsAnchor() {
    var keywords = ["Enregistrer", "Save", "Réinitialiser", "Reset"];
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var text = buttons[i].textContent || "";
      for (var k = 0; k < keywords.length; k++) {
        if (text.indexOf(keywords[k]) !== -1) {
          /* Walk up to find the wrapping div with justify-end+flex-wrap */
          var el = buttons[i].parentElement;
          for (var j = 0; j < 6 && el; j++) {
            var cls = el.className || "";
            if (typeof cls === "string" && cls.indexOf("justify-end") !== -1 && cls.indexOf("flex-wrap") !== -1) {
              return el.parentElement;
            }
            el = el.parentElement;
          }
          return buttons[i].parentElement.parentElement;
        }
      }
    }
    return null;
  }

  /* ── Create UI elements ────────────────────────────────── */

  function createCloseButton() {
    var bar = document.createElement("div");
    bar.id = "server-close-bar";
    bar.className = "server-row";
    bar.innerHTML = '<span class="server-label">Panel</span>' +
      '<button class="server-close-btn" id="server-close-btn" title="Close side panel">Close</button>';

    bar.querySelector("#server-close-btn").addEventListener("click", async function () {
      try {
        if (chrome.sidePanel && chrome.sidePanel.setOptions) {
          await chrome.sidePanel.setOptions({ enabled: false });
        }
      } catch (e) {}
      try { window.close(); } catch (e) {}
    });

    return bar;
  }

  function createUI() {
    var container = document.createElement("div");
    container.id = "server-mode-section";

    container.appendChild(createCloseButton());

    var row1 = document.createElement("div");
    row1.className = "server-row";
    row1.innerHTML = '<span class="server-label">Status</span>' +
      '<span class="server-status" id="server-status-label">' +
      '<span class="server-status-dot stopped" id="server-status-dot"></span>' +
      '<span id="server-status-text">Stopped</span></span>';

    var rowProj = document.createElement("div");
    rowProj.className = "server-row";
    rowProj.innerHTML = '<span class="server-label">Project</span>' +
      '<input class="server-project-input" id="server-project-url" type="url" ' +
      'placeholder="https://flow.google.com/project/..." spellcheck="false" />';

    /* Toggle row */
    var row2 = document.createElement("div");
    row2.className = "server-row";
    row2.innerHTML = '<span class="server-label">Server</span><button class="server-toggle" id="server-toggle-btn" title="Start/Stop Server"></button>';

    /* URL box */
    var row3 = document.createElement("div");
    row3.className = "server-row";
    row3.innerHTML = '<div class="server-url-box" id="server-url-box" style="display:none">' +
      '<span class="url">' + SERVER_HTTP_URL + '</span>' +
      '<button class="server-copy-btn" id="server-copy-btn" title="Copy URL">📋</button></div>';

    /* Queue section */
    var queue = document.createElement("div");
    queue.className = "server-queue-section";
    queue.id = "server-queue-section";
    queue.style.display = "none";
    queue.innerHTML = '<div class="server-queue-header">' +
      '<span>Active Tasks</span>' +
      '<button class="server-refresh-btn" id="server-refresh-btn">⟳ Refresh</button></div>' +
      '<div id="server-task-list"></div>';

    container.appendChild(row1);
    container.appendChild(rowProj);
    container.appendChild(row2);
    container.appendChild(row3);
    container.appendChild(queue);

    return container;
  }

  /* ── State ──────────────────────────────────────────────── */

  var serverRunning = false;

  /* ── Events ─────────────────────────────────────────────── */

  function bindEvents() {
    var toggle = document.getElementById("server-toggle-btn");
    if (!toggle) return;

    toggle.addEventListener("click", function () {
      if (toggle.disabled) return;
      toggle.disabled = true;
      if (!serverRunning) {
        chrome.runtime.sendMessage({ type: "SERVER_START" }, function (resp) {
          toggle.disabled = false;
          if (resp && resp.success) {
            serverRunning = true;
            updateUI(true);
            document.getElementById("server-url-box").style.display = "flex";
            startQueuePolling();
          }
        });
      } else {
        chrome.runtime.sendMessage({ type: "SERVER_STOP" }, function (resp) {
          toggle.disabled = false;
          if (resp && resp.success) {
            serverRunning = false;
            updateUI(false);
            document.getElementById("server-url-box").style.display = "none";
            stopQueuePolling();
          }
        });
      }
    });

    var projInput = document.getElementById("server-project-url");
    if (projInput) {
      chrome.storage.local.get(PROJECT_URL_KEY, function (stored) {
        if (stored && stored[PROJECT_URL_KEY]) projInput.value = stored[PROJECT_URL_KEY];
      });
      var saveProject = function () {
        var v = (projInput.value || "").trim();
        if (!/^https:\/\/flow\.google\.com\/project\/[0-9a-f-]+/i.test(v)) return;
        chrome.storage.local.set({ [PROJECT_URL_KEY]: v }, function () {
          projInput.classList.add("saved");
          setTimeout(function () { projInput.classList.remove("saved"); }, 900);
        });
      };
      projInput.addEventListener("change", saveProject);
      projInput.addEventListener("blur", saveProject);
    }

    var copyBtn = document.getElementById("server-copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        navigator.clipboard.writeText(SERVER_HTTP_URL);
        copyBtn.textContent = "✅";
        setTimeout(function () { copyBtn.textContent = "📋"; }, 2000);
      });
    }

    document.getElementById("server-refresh-btn").addEventListener("click", refreshQueue);
  }

  /* ── UI updates ────────────────────────────────────────── */

  function updateUI(running) {
    var toggle = document.getElementById("server-toggle-btn");
    var dot = document.getElementById("server-status-dot");
    var text = document.getElementById("server-status-text");
    var queue = document.getElementById("server-queue-section");
    if (toggle) toggle.className = "server-toggle" + (running ? " active" : "");
    if (dot) dot.className = "server-status-dot " + (running ? "running" : "stopped");
    if (text) text.textContent = running ? "Running on port 9876" : "Stopped";
    if (queue) queue.style.display = running ? "block" : "none";
  }

  /* ── Queue ──────────────────────────────────────────────── */

  function refreshQueue() {
    var list = document.getElementById("server-task-list");
    if (!list) return;
    chrome.runtime.sendMessage({ type: "QUEUE_GET" }, function (resp) {
      var tasks = (resp && resp.tasks) || [];
      if (tasks.length === 0) {
        list.innerHTML = '<div class="server-empty-queue">No tasks yet. Submit via API.</div>';
        return;
      }
      var html = "";
      for (var i = 0; i < Math.min(tasks.length, 10); i++) {
        var t = tasks[i];
        var pt = t.status === "completed" ? "100%" : t.status === "queued" ? "—" : (t.progress || 0) + "%";
        html += '<div class="server-task-item">' +
          '<span class="server-task-id">#' + t.id + '</span>' +
          '<span class="server-task-mode">' + t.mode + '</span>' +
          '<span class="server-task-status ' + t.status + '">' + t.status + '</span>' +
          '<span class="server-task-progress">' + pt + '</span>' +
          (t.error ? '<span class="server-error" title="' + t.error.replace(/"/g, "&quot;") + '">' + t.error + '</span>' : "") +
          '</div>';
      }
      list.innerHTML = html;
    });
  }

  function startQueuePolling() {
    stopQueuePolling();
    refreshQueue();
    queueTimer = setInterval(refreshQueue, 3000);
  }

  function stopQueuePolling() {
    if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
  }

  /* ── Injection ──────────────────────────────────────────── */

  function inject() {
    if (injected) return;
    if (injectAttempts > 60) return;
    injectAttempts++;

    var anchor = findSettingsAnchor();
    injectStyles();

    /* findSettingsAnchor only matches while Vue's settings dialog is open, so anchoring
       there meant the whole panel -- including the close button -- never appeared.
       Fall back to body so the UI exists regardless of dialog state. */
    if (anchor) {
      anchor.insertBefore(createUI(), anchor.firstChild);
    } else if (!injected) {
      document.body.appendChild(createUI());
    } else {
      return;
    }
    injected = true;

    setTimeout(bindEvents, 50);

    chrome.runtime.sendMessage({ type: "SERVER_STATUS" }, function (resp) {
      if (resp) {
        var dot = document.getElementById("server-status-dot");
        var text = document.getElementById("server-status-text");
        if (resp.connected) {
          if (dot) dot.className = "server-status-dot connecting";
          if (text) text.textContent = "Companion server reachable — toggle to start";
        }
        serverRunning = resp.running;
        updateUI(resp.running);
        if (resp.connected) document.getElementById("server-url-box").style.display = "flex";
        if (resp.running) startQueuePolling();
      }
    });
  }

  /* ── Init ────────────────────────────────────────────────── */

  function init() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
      return;
    }
    inject();
  }

  init();
})();
