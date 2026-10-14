const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
const $ = (id) => document.getElementById(id);

let serverRunning = false;

function renderStatus(running, connected) {
  serverRunning = running;
  const toggle = $("toggle");
  toggle.classList.toggle("active", running);
  toggle.disabled = false;

  const dot = $("dot");
  const text = $("status-text");
  dot.className = "dot " + (running ? (connected ? "running" : "connecting") : "stopped");
  text.textContent = running ? (connected ? "Running" : "Waiting for extension") : "Stopped";
}

async function refreshStatus() {
  const resp = await send({ type: "SERVER_STATUS" });
  if (resp) renderStatus(!!resp.running, !!resp.connected);
}

async function refreshTasks() {
  const resp = await send({ type: "QUEUE_GET" });
  const tasks = (resp && resp.tasks) || [];
  const list = $("task-list");
  list.textContent = "";
  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No tasks";
    list.appendChild(empty);
    return;
  }
  for (const t of tasks) {
    const row = document.createElement("div");
    row.className = "task";

    const id = document.createElement("span");
    id.className = "task-id";
    id.textContent = String(t.id || "").slice(0, 10);

    const mode = document.createElement("span");
    mode.className = "task-mode";
    mode.textContent = (t.prompts && t.prompts[0]) || t.mode || "";

    const status = document.createElement("span");
    const s = t.status || "pending";
    status.className = "task-status " + s;
    status.textContent = s;

    row.append(id, mode, status);
    list.appendChild(row);
  }
}

function init() {
  chrome.runtime.getManifest && $("ver") &&
    ($("ver").textContent = chrome.runtime.getManifest().version_name || "");

  const toggle = $("toggle");
  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    const resp = serverRunning
      ? await send({ type: "SERVER_STOP" })
      : await send({ type: "SERVER_START" });
    if (resp && resp.success !== false) {
      serverRunning = !serverRunning;
      toggle.classList.toggle("active", serverRunning);
      setTimeout(refreshStatus, 400);
    } else {
      toggle.disabled = false;
    }
  });

  $("refresh").addEventListener("click", () => {
    refreshTasks();
    refreshStatus();
  });

  const sideBtn = $("open-side");
  const SIDE_KEY = "flowSidePanelOpen";
  let panelIsOpen = false;

  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise((r) => setTimeout(() => r(fallback), ms))
    ]);
  }

  function flagStored() {
    return withTimeout(
      new Promise((r) => {
        try {
          chrome.storage.local.get(SIDE_KEY, (v) => r(!!v[SIDE_KEY]));
        } catch (_) {
          r(false);
        }
      }),
      400,
      false
    );
  }

  function setFlag(v) {
    return withTimeout(
      new Promise((r) => {
        try {
          chrome.storage.local.set({ [SIDE_KEY]: v }, () => r());
        } catch (_) {
          r();
        }
      }),
      400,
      undefined
    );
  }

  async function panelState() {
    // Edge does not populate getOptions().open, so the stored flag is the source of truth;
    // getOptions() is only a fallback for a panel this popup did not open.
    let open = await flagStored();
    if (!open) {
      try {
        const win = await chrome.windows.getCurrent();
        const opt = await chrome.sidePanel.getOptions({ windowId: win.id });
        open = !!(opt && opt.open);
      } catch (_) {}
    }
    return open;
  }

  async function syncSideButton() {
    panelIsOpen = await panelState();
    sideBtn.textContent = panelIsOpen ? "Close side panel" : "Open side panel";
  }

  sideBtn.addEventListener("click", function () {
    if (panelIsOpen) {
      closePanel();
      return;
    }

    // Must be the FIRST statement: chrome.sidePanel.open() is only honoured while the user
    // gesture is still live. Awaiting anything first (even a storage read) voids it and the
    // call rejects, which is why clicking did nothing.
    var opening;
    try {
      opening = chrome.sidePanel.open();
    } catch (_) {
      opening = Promise.reject(new Error("open unavailable"));
    }

    opening.then(
      function () {
        panelIsOpen = true;
        setFlag(true);
        sideBtn.textContent = "Close side panel";
        window.close();
      },
      function () {
        chrome.windows.getCurrent().then(function (win) {
          return chrome.sidePanel.open({ windowId: win.id });
        }).then(
          function () {
            panelIsOpen = true;
            setFlag(true);
            window.close();
          },
          function () {
            chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/side-panel/index.html") }).then(
              function () { panelIsOpen = true; setFlag(true); window.close(); },
              function () { sideBtn.textContent = "Side panel unavailable"; }
            );
          }
        );
      }
    );
  });

  async function closePanel() {
    panelIsOpen = false;
    sideBtn.textContent = "Open side panel";
    await setFlag(false);

    try {
      await chrome.sidePanel.setOptions({ enabled: false });
      window.close();
      return;
    } catch (_) {}

    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.setOptions({ windowId: win.id, enabled: false });
      window.close();
      return;
    } catch (_) {}

    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.setOptions({
        windowId: win.id,
        path: "src/ui/side-panel/index.html",
        enabled: false
      });
      window.close();
    } catch (_) {
      sideBtn.textContent = "Could not close";
    }
  }

  syncSideButton();

  refreshStatus();
  refreshTasks();
  setInterval(refreshTasks, 3000);
  setInterval(syncSideButton, 2000);
}

document.addEventListener("DOMContentLoaded", init);