import { g as e } from "./remoteConfig-CbIdrXch.js";
let t = "/";
let a = "";
let s = true;
const o = new Map();
let r = null;
const n = new Set();

// ── Server Mode State ──────────────────────────────────────
let serverPollTimer = null;
let processingTaskId = null;
let taskDeadlineTimer = null;
const TASK_DEADLINE_MS = 8 * 60 * 1000;
let lastProcessedTaskId = null;
// Literal loopback IP, not "localhost": on macOS localhost also resolves to ::1, but the
// server binds IPv4 only, so a client that prefers IPv6 gets connection-refused. Curl falls
// back silently; the browser is not obliged to, which strands queued tasks at "pending".
const SERVER_URL = "http://127.0.0.1:9876";

// ── Google Flow location ───────────────────────────────────
// labs.google.com/fx/tools/flow is a hard 404; Flow now lives on flow.google.com.
const FLOW_URL = "https://flow.google.com/project/97bfb91d-2885-4b40-bba2-2d80b25e3e33";
const FLOW_TAB_PATTERNS = ["*://flow.google.com/*", "*://labs.google.com/*", "*://labs.google/*"];

let _pendingDownloadFiles = [];

function safeFilename(url, fallback) {
  const named = url.match(/[?&]name=([^&]+)/);
  let base = named ? named[1] : (url.match(/\/([^/]+?)(?:\?|$)/) || [])[1] || fallback;
  base = decodeURIComponent(base).replace(/=mm,[^=]*$/, "").replace(/\.[a-z0-9]{2,4}$/i, "");
  base = base.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  if (base.length > 60) base = base.slice(0, 60);
  return base || fallback;
}
let _pendingTimer = null;

async function flushPendingDownloads() {
  const batch = _pendingDownloadFiles.splice(0);
  for (const f of batch) {
    try {
      const r = await fetch(f.url);
      if (!r.ok) continue;
      const b = await r.blob();
      const fn = f.filename || `result_${f.ts}.bin`;
      await fetch(`${SERVER_URL}/api/results/${f.taskId}/upload/${encodeURIComponent(fn)}`, {
        method: "PUT", body: b
      });
    } catch (_) {}
  }
  if (_pendingDownloadFiles.length === 0 && _pendingTimer !== null) {
    clearInterval(_pendingTimer);
    _pendingTimer = null;
  }
}

async function serverFetch(path, opts = {}) {
  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    // Swallowing this made every network failure look identical to "no work", which is how a
    // missing host permission hid for hours. Surface it in the service worker console.
    console.log(`[SW] ${path} failed:`, e && e.message ? e.message : String(e));
    return null;
  }
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);

    // The window must be focused even when the tab is already active: an active tab in a
    // background window is still throttled by Chrome, so the task would stall forever.
    if (!win.focused) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
    }
    return true;
  } catch (e) {
    console.log("[SW] focusTab failed:", tabId, String(e));

    return false;

  }
}

async function processTask(task) {
  if (!task || task.empty || processingTaskId) return;
  if (task.id === lastProcessedTaskId) return;
  processingTaskId = task.id;
  // A task with no terminal status from the content script leaves every wait=true caller
  // hanging forever, so the run is closed from this side after TASK_DEADLINE_MS.
  clearTimeout(taskDeadlineTimer);
  taskDeadlineTimer = setTimeout(async () => {
    if (processingTaskId !== task.id) return;
    console.log("[SW] deadline hit for", task.id, "- reporting failure");
    processingTaskId = null;
    await serverFetch("/api/result", {
      method: "POST",
      body: JSON.stringify({
        task_id: task.id,
        status: "failed",
        error: "Flow produced no image and the automation never reported back within " + Math.round(TASK_DEADLINE_MS / 60000) + " min."
      })
    });
  }, TASK_DEADLINE_MS);
  const PROJECT_URL_KEY = "flowProjectUrl";
  async function getTargetProjectUrl() {
    const stored = await chrome.storage.local.get(PROJECT_URL_KEY);
    const url = stored && stored[PROJECT_URL_KEY];
    return typeof url === "string" && /^https:\/\/flow\.google\.com\/project\/[0-9a-f-]+/i.test(url.trim()) ? url.trim() : FLOW_URL;
  }
  let tabs = (await chrome.tabs.query({ url: FLOW_TAB_PATTERNS })).filter(t => t.url && t.url.includes("flow.google.com"));
  const projectUrl = await getTargetProjectUrl();
  const onTarget = tabs.filter(t => t.url.replace(/\/+$/, "") === projectUrl.replace(/\/+$/, ""));
  if (onTarget.length > 0) tabs = onTarget;
  else if (tabs.length > 0) { await chrome.tabs.update(tabs[0].id, { url: projectUrl }); tabs = [tabs[0]]; }
  else tabs = [await chrome.tabs.create({ url: projectUrl, active: false })];
  const tabId = tabs[0].id;
  try {
    // Force the Flow tab to the front. Google throttles a background tab, so a task makes no
    // progress until the tab is actually visible; running quietly is not an option here.
    await focusTab(tabId);
    await chrome.tabs.reload(tabId);
    await new Promise(r => {
      const handler = (tId, info) => { if (tId === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(handler); r(); } };
      chrome.tabs.onUpdated.addListener(handler);
      setTimeout(r, 10000);
    });
    await focusTab(tabId);

    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "AUTO_FILL_FLOW",
        payloads: task.prompts.map(p => ({
          taskId: task.id, promptIndex: task.prompts.indexOf(p),
          prompt: p, mode: task.mode, model: task.model, aspectRatio: task.aspectRatio,
          videoOption: task.videoOption, outputCount: task.outputCount,
          characters: task.characters || [], speaker: task.speaker || null,
          images: task.imageBase64
            ? [{ base64: task.imageBase64, name: task.imageName || "reference.png" }]
            : task.images || []
        })),
        groupId: task.id,
        concurrentPrompts: task.concurrentPrompts || 1,
        promptDelaySecondsMin: task.promptDelaySecondsMin || 0,
        promptDelaySecondsMax: task.promptDelaySecondsMax || 0
      });
    } catch (e) {
      processingTaskId = null;
      serverFetch("/api/result", {
        method: "POST", body: JSON.stringify({ task_id: task.id, status: "failed", error: "Content script unavailable" })
      });
    }
  } catch (e) {
    processingTaskId = null;
    serverFetch("/api/result", {
      method: "POST", body: JSON.stringify({ task_id: task.id, status: "failed", error: String(e) })
    });
  }
}

async function pollServer() {
  if (processingTaskId) return;
  console.log("[SW] polling", SERVER_URL);
  const task = await serverFetch("/api/poll");
  if (task && !task.empty) {
    console.log("[SW] got task", task.id, "mode", task.mode);
    processTask(task);
  }
}

const FLOW_POLL_ALARM = "flowServerPoll";

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === FLOW_POLL_ALARM) pollServer();
});

function startServerMode() {
  if (serverPollTimer) return { success: true, url: SERVER_URL };
  // chrome.alarms, not setInterval: MV3 suspends the service worker after ~30s idle, which
  // silently kills a setInterval and leaves the extension looking alive while it no longer
  // picks up queued tasks. An alarm both survives suspension and wakes the worker to poll.
  try {
    chrome.alarms.create(FLOW_POLL_ALARM, { delayInMinutes: 0.1, periodInMinutes: 0.5 });
  } catch (e) {
    console.log("[SW] alarm create failed, falling back to interval:", String(e));
    serverPollTimer = setInterval(pollServer, 10000);
    return { success: true, url: SERVER_URL };
  }
  serverPollTimer = true;
  pollServer();
  return { success: true, url: SERVER_URL };
}

function stopServerMode() {
  try {
    chrome.alarms.clear(FLOW_POLL_ALARM);
  } catch (e) {}
  if (typeof serverPollTimer === "number") clearInterval(serverPollTimer);
  serverPollTimer = null;
  return { success: true };
}

function isServerRunning() {
  return serverPollTimer !== null;
}

const SERVER_MODE_KEY = "flowServerModeEnabled";
// MV3 kills the service worker on idle, which tears down serverPollTimer. Re-arm on every
// worker start so queued tasks are picked up without touching the toggle. Defaults to ON and
// only stays off if the user explicitly turned it off.
async function autoStartServerMode() {
  try {
    const stored = await chrome.storage.local.get(SERVER_MODE_KEY);
    if (stored[SERVER_MODE_KEY] !== false) startServerMode();
  } catch (e) {
    startServerMode();
  }
}
autoStartServerMode();

chrome.tabs.onRemoved.addListener(e => {
  n.delete(e);
});
chrome.debugger.onDetach.addListener(e => {
  if (e.tabId !== undefined) {
    n.delete(e.tabId);
  }
});
const c = (e, r) => {
  const n = e.url.includes("google");
  const c = !e.byExtensionId || e.byExtensionId === chrome.runtime.id;
  if (n && c) {
    const bn = /\.(mp4)$/i.test(e.filename || e.url);
    const bi = /\.(jpg|jpeg|png|gif|webp|bmp|svg|jfif)$/i.test(e.filename || e.url);
    if (bn || bi) {
      if (!s) {
        return;
      }
      if (o.has(e.url)) {
        r({
          filename: o.get(e.url)
        });
        o.delete(e.url);
      } else {
        const s = e.filename;
        const o = s.split("/").pop() || s;
        r({
          filename: `${t}${a}${o}`
        });
      }
    }
    if (isServerRunning()) {
      const fn = e.filename ? e.filename.split("/").pop() || e.filename : `dl_${Date.now()}.bin`;
      _pendingDownloadFiles.push({ url: e.url, filename: fn, taskId: "", ts: Date.now() });
    }
  }
};
const i = async () => {
  if (chrome.sidePanel) {
    try {
      await chrome.sidePanel.setOptions({
        path: "src/ui/side-panel/index.html",
        enabled: true
      });
      // Chrome persists openPanelOnActionClick per profile: absence is NOT false, so this must
      // be set explicitly or the toolbar icon keeps opening the side panel instead of default_popup.
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    } catch (e) {}
  }
};
i();
chrome.runtime.onInstalled.addListener(async e => {
  await i();
  if (e.reason === "install") {
    await (async e => {
      try {
        const t = await chrome.tabs.query({
          url: [`*://kylenguyen.me/*?${e}`]
        });
        if (t.length > 0 && typeof t[0].id == "number") {
          const e = t[0];
          if (typeof e.windowId == "number") {
            await chrome.windows.update(e.windowId, {
              focused: true
            });
          }
          await chrome.tabs.update(e.id, {
            active: true
          });
        } else {
          await chrome.tabs.create({
            url: `https://kylenguyen.me?${e}`
          });
        }
      } catch (t) {}
    })("new-version-installed=true");
    await (async () => {
      try {
        const t = (await chrome.tabs.query({
          url: FLOW_TAB_PATTERNS
        })).filter(e => e.url && e.url.includes("flow"));
        for (const a of t) {
          if (a.id) {
            try {
              await chrome.tabs.reload(a.id);
            } catch (e) {}
          }
        }
        t.length;
      } catch (e) {}
    })();
  } else {
    e.reason;
  }
});
self.onerror = function (e, t, a, s, o) {};
chrome.action.onClicked.addListener(async e => {
  if (chrome.sidePanel && e.id !== undefined) {
    try {
      await chrome.sidePanel.open({
        tabId: e.id
      });
    } catch (t) {}
  }
});
chrome.runtime.onMessage.addListener((i, d, m) => {
  switch (i.type) {
    case "GET_REMOTE_CONFIG":
      e().then(e => m(e)).catch(() => m(null));
      return true;
    case "SET_ZOOM":
      {
        const {
          zoomFactor: e
        } = i;
        if (d.tab?.id) {
          chrome.tabs.setZoom(d.tab.id, e);
          m({
            success: true
          });
        } else {
          m({
            success: false,
            error: "Tab ID not found"
          });
        }
      }
      break;
    case "DOWNLOAD_VIDEO":
      {
        const {
          url: e,
          filename: t,
          folder: a,
          autoChangeFileName: s,
          _downloadRef: d
        } = i;
        if (!d && s !== false) {
          const s = a ? `${a}/${t}` : t;
          o.set(e, s);
          chrome.downloads.download({
            url: e,
            filename: s,
            saveAs: false
          }, e => {
            const t = chrome.runtime?.lastError;
            m(!t && e ? {
              success: true,
              downloadId: e
            } : {
              success: false,
              error: t?.message || "Failed to start download"
            });
          });
        } else if (!d) {
          chrome.downloads.download({
            url: e,
            saveAs: false
          }, e => {
            const t = chrome.runtime?.lastError;
            m(!t && e ? {
              success: true,
              downloadId: e
            } : {
              success: false,
              error: t?.message || "Failed to start download"
            });
          });
        }
        if (d) {
          _pendingDownloadFiles.push({ url: e, filename: t, taskId: d, ts: Date.now() });
        }
        if (_pendingTimer === null) {
          _pendingTimer = setInterval(flushPendingDownloads, 5000);
        }
        return true;
      }
    case "UPLOAD_FILE_BYTES":
      {
        const { filename: fn, data: b64, mimeType: mt, _downloadRef: ref } = i;
        console.log("[SW] UPLOAD_FILE_BYTES:", fn, "ref:", ref, "size:", b64 ? b64.length : 0);
        if (!b64 || !ref) { console.log("[SW] UPLOAD_FILE_BYTES: missing data or ref"); return true; }
        (async () => {
          try {
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const blob = new Blob([arr], { type: mt || 'image/png' });
            const resp = await fetch(`${SERVER_URL}/api/results/${ref}/upload/${encodeURIComponent(fn || `result_${Date.now()}.bin`)}`, {
              method: "PUT", body: blob
            });
            console.log("[SW] UPLOAD_FILE_BYTES result:", resp.status);
          } catch (err) {
            console.log("[SW] UPLOAD_FILE_BYTES error:", err.message);
          }
        })();
        return true;
      }
    case "SET_FOLDER_NAME":
      {
        const {
          folderName: e,
          prefix: o,
          autoChangeFileName: n
        } = i;
        if (typeof e == "string") {
          t = e.trim() ? `${e.trim()}/` : "";
        }
        if (typeof o == "string") {
          a = o.trim();
        }
        if (typeof n == "boolean") {
          s = n;
        }
        if (s) {
          if (r !== null) {
            clearTimeout(r);
            r = null;
          }
          if (!chrome.downloads.onDeterminingFilename.hasListener(c)) {
            chrome.downloads.onDeterminingFilename.addListener(c);
          }
        } else {
          if (r !== null) {
            clearTimeout(r);
            r = null;
          }
          if (chrome.downloads.onDeterminingFilename.hasListener(c)) {
            chrome.downloads.onDeterminingFilename.removeListener(c);
          }
        }
        m({
          success: true
        });
      }
      break;
    case "PROMPT_GROUP_STATUS":
      {
        const { data: e } = i;
        const t = e?.status;
        const taskId = e?.id || e?.groupId;
        if (taskId && isServerRunning()) {
          if (t === "completed") {
            lastProcessedTaskId = taskId;
            processingTaskId = null;
            (async () => {
              console.log("[SW] completed handler for", taskId, "resultUrls:", (e.resultUrls || []).length, "pending:", _pendingDownloadFiles.length);
              let uploaded = 0;
              const urls = e.resultUrls || [];
              for (const url of urls) {
                try {
                  const resp = await fetch(url);
                  console.log("[SW] fetch resultUrl:", url.substring(0,80), resp.status);
                  if (!resp.ok) continue;
                  const blob = await resp.blob();
                  let filename = safeFilename(url, `result_${Date.now()}`);
                  const ct = resp.headers.get("content-type") || "";
                  if (ct.startsWith("image/jpeg") && !filename.endsWith(".jpg")) filename += ".jpg";
                  else if (ct.startsWith("image/png") && !filename.endsWith(".png")) filename += ".png";
                  else if (ct.startsWith("video/mp4") && !filename.endsWith(".mp4")) filename += ".mp4";
                  else if (ct.startsWith("image/webp") && !filename.endsWith(".webp")) filename += ".webp";
                  else if (ct.startsWith("image/gif") && !filename.endsWith(".gif")) filename += ".gif";
                  const uploadResp = await fetch(`${SERVER_URL}/api/results/${taskId}/upload/${filename}`, {
                    method: "PUT", body: blob
                  });
                  if (uploadResp.ok) uploaded++;
                  console.log("[SW] uploaded via resultUrl:", filename, uploadResp.status);
                } catch (err) {
                  console.log("[SW] fetch/upload error:", err.message);
                }
              }
              const taskFiles = _pendingDownloadFiles.filter(f => f.taskId === taskId);
              const recentUntagged = _pendingDownloadFiles.filter(f => !f.taskId && (Date.now() - f.ts) < 60000);
              _pendingDownloadFiles = _pendingDownloadFiles.filter(f => f.taskId !== taskId && !(!f.taskId && (Date.now() - f.ts) < 60000));
              taskFiles.push(...recentUntagged);
              console.log("[SW] pending files for this task:", taskFiles.length, "(tagged:", taskFiles.length - recentUntagged.length, ", untagged:", recentUntagged.length, ")");
              for (const f of taskFiles) {
                try {
                  const r = await fetch(f.url);
                  console.log("[SW] fetch pending:", f.filename, r.status);
                  if (!r.ok) continue;
                  const b = await r.blob();
                  const fn = f.filename || `result_${f.ts}.bin`;
                  const uploadResp = await fetch(`${SERVER_URL}/api/results/${taskId}/upload/${encodeURIComponent(fn)}`, {
                    method: "PUT", body: b
                  });
                  if (uploadResp.ok) uploaded++;
                  console.log("[SW] uploaded pending:", fn, uploadResp.status);
                } catch (err) {
                  console.log("[SW] pending upload error:", err.message);
                }
              }
              let onServer = [];
              try {
                const seen = await fetch(`${SERVER_URL}/api/queue/${taskId}?probe=1`);
                if (seen.ok) {
                  const t2 = await seen.json();
                  onServer = t2 && Array.isArray(t2.result_files) ? t2.result_files : [];
                }
              } catch (_) {}
              const totalFiles = uploaded + onServer.length;
              // A prompt Flow itself refused carries its own reason; the generic "nothing
              // downloaded" text hides it and leaves the caller with nothing to retry on.
              const flowReason = (Array.isArray(e.results) ? e.results : [])
                .map(r => (r && r.success === false ? r.error : null))
                .filter(Boolean)
                .join(" | ");
              serverFetch("/api/result", {
                method: "POST",
                body: JSON.stringify(totalFiles > 0
                  ? { task_id: taskId, status: "completed", progress: 100 }
                  : {
                      task_id: taskId,
                      status: "failed",
                      error: flowReason || `Flow finished the prompt but nothing downloaded (${urls.length} result url(s), ${taskFiles.length} pending file(s), ${onServer.length} already on server). Open the Flow tab to see where it stopped.`
                    })
              });
              console.log("[SW] completed handler done for", taskId, "uploaded:", uploaded, "alreadyOnServer:", onServer.length);
            })();
          } else if (t === "error") {
            lastProcessedTaskId = taskId;
            processingTaskId = null;
            serverFetch("/api/result", {
              method: "POST",
              body: JSON.stringify({ task_id: taskId, status: "failed", error: e.error || "Unknown error" })
            });
          } else if (t === "cancelled") {
            processingTaskId = null;
          } else if (t === "processing") {
            serverFetch("/api/result", {
              method: "POST",
              body: JSON.stringify({ task_id: taskId, status: "processing", progress: e.progress || 0 })
            });
          }
        }
        if (t === "completed" || t === "cancelled" || t === "error") {
          if (r !== null) {
            clearTimeout(r);
          }
          r = setTimeout(() => {
            r = null;
            if (chrome.downloads.onDeterminingFilename.hasListener(c)) {
              chrome.downloads.onDeterminingFilename.removeListener(c);
            }
          }, 300000);
        }
      }
      break;
    case "SERVER_START":
      chrome.storage.local.set({ [SERVER_MODE_KEY]: true }).catch(() => {});
      m(startServerMode());
      break;
    case "SERVER_STOP":
      chrome.storage.local.set({ [SERVER_MODE_KEY]: false }).catch(() => {});
      m(stopServerMode());
      break;
    case "SERVER_STATUS":
      (async () => {
        const health = await serverFetch("/api/health");
        m({
          running: isServerRunning(),
          connected: health !== null,
          queue: health?.tasks_total || 0
        });
      })();
      return true;
    case "QUEUE_GET":
      (async () => {
        const data = await serverFetch("/api/queue");
        m({ tasks: data?.tasks || [] });
      })();
      return true;
    case "QUEUE_CANCEL":
      (async () => {
        const { task_id: e } = i;
        await serverFetch(`/api/queue/${e}`, { method: "DELETE" });
        m({ success: true });
      })();
      return true;
    case "CHECK_BANNER":
      (async () => {
        try {
          let tabs = await chrome.tabs.query({ url: FLOW_TAB_PATTERNS });
          tabs = tabs.filter(t => t.url && t.url.includes("flow"));
          if (tabs.length === 0 || !tabs[0].id) {
            m({ bannerDetected: null, error: "No Flow tab" });
            return;
          }
          const tabId = tabs[0].id;
          const dbg = { tabId: tabId };
          if (!n.has(tabId)) {
            try {
              await chrome.debugger.attach(dbg, "1.3");
              n.add(tabId);
            } catch (e) {
              if (String(e).indexOf("already attached") === -1) throw e;
              n.add(tabId);
            }
          }
          const result = await chrome.debugger.sendCommand(dbg, "Runtime.evaluate", {
            expression: "!!document.querySelector('.sc-229e86f5-1') || (document.body.innerText||'').toLowerCase().indexOf('high demand') !== -1",
            returnByValue: true
          });
          m({ bannerDetected: result && result.result && result.result.value === true });
        } catch (e) {
          m({ bannerDetected: null, error: String(e) });
        }
      })();
      return true;
    case "CS":
      (async () => {
        const e = d.tab?.id;
        try {
          await (async () => {
            const e = ["__Secure", "SID", "SSID", "HSID", "APISID", "SAPISID", "LSID", "NID", "1P_JAR"];
            const t = (await chrome.cookies.getAll({
              domain: "flow.google.com"
            })).filter(t => !e.some(e => t.name.startsWith(e)));
            await Promise.all(t.map(e => chrome.cookies.remove({
              url: `https://${e.domain.replace(/^\./, "")}${e.path}`,
              name: e.name
            })));
          })();
          if (e) {
            await (async e => {
              const t = {
                tabId: e
              };
              if (!n.has(e)) {
                await chrome.debugger.attach(t, "1.3");
                n.add(e);
              }
              await chrome.debugger.sendCommand(t, "Storage.clearDataForOrigin", {
                origin: "https://flow.google.com",
                storageTypes: "local_storage"
              });
            })(e);
          }
          m({
            success: true
          });
        } catch (t) {
          m({
            success: false,
            error: String(t)
          });
        }
      })();
      return true;
    case "CA":
      {
        const e = d.tab?.id;
        if (!e) {
          m({
            success: false,
            error: "No tab ID"
          });
          break;
        }
        (async () => {
          const t = {
            tabId: e
          };
          try {
            await chrome.debugger.attach(t, "1.3");
            n.add(e);
          } catch (a) {
            const t = a instanceof Error ? a.message : String(a);
            if (!t.includes("already attached")) {
              m({
                success: false,
                error: t
              });
              return;
            }
            n.add(e);
          }
          try {
            await (async e => {
              const t = {
                tabId: e
              };
              await chrome.debugger.sendCommand(t, "Network.enable", {});
              await chrome.debugger.sendCommand(t, "Network.setCacheDisabled", {
                cacheDisabled: true
              });
            })(e);
          } catch (a) {}
          m({
            success: true
          });
        })();
        return true;
      }
    case "CD":
      {
        const e = d.tab?.id;
        if (!e) {
          m({
            success: false,
            error: "No tab ID"
          });
          break;
        }
        (async () => {
          const t = {
            tabId: e
          };
          try {
            if (n.has(e)) {
              await chrome.debugger.detach(t);
              n.delete(e);
            }
            m({
              success: true
            });
          } catch (a) {
            n.delete(e);
            m({
              success: false,
              error: String(a)
            });
          }
        })();
        return true;
      }
    case "CIT":
      {
        const {
          text: e
        } = i;
        const t = d.tab?.id;
        if (!t) {
          m({
            success: false,
            error: "No tab ID"
          });
          break;
        }
        (async () => {
          const a = {
            tabId: t
          };
          try {
            if (!n.has(t)) {
              await chrome.debugger.attach(a, "1.3");
              n.add(t);
            }
            await chrome.debugger.sendCommand(a, "Input.insertText", {
              text: e
            });
            m({
              success: true
            });
          } catch (s) {
            m({
              success: false,
              error: String(s)
            });
          }
        })();
        return true;
      }
    case "CK":
      {
        const {
          key: e,
          keyCode: t,
          code: a,
          text: s,
          modifiers: o,
          keyType: r
        } = i;
        const c = d.tab?.id;
        if (!c) {
          m({
            success: false,
            error: "No tab ID"
          });
          break;
        }
        (async () => {
          const i = {
            tabId: c
          };
          try {
            if (!n.has(c)) {
              await chrome.debugger.attach(i, "1.3");
              n.add(c);
            }
            const d = {
              key: e,
              code: a,
              windowsVirtualKeyCode: t,
              nativeVirtualKeyCode: t
            };
            if (s !== undefined) {
              d.text = s;
              d.unmodifiedText = s;
            }
            if (o !== undefined) {
              d.modifiers = o;
            }
            if (r) {
              await chrome.debugger.sendCommand(i, "Input.dispatchKeyEvent", {
                type: r,
                ...d
              });
            } else {
              await chrome.debugger.sendCommand(i, "Input.dispatchKeyEvent", {
                type: "keyDown",
                ...d
              });
              await chrome.debugger.sendCommand(i, "Input.dispatchKeyEvent", {
                type: "keyUp",
                ...d
              });
            }
            m({
              success: true
            });
          } catch (d) {
            m({
              success: false,
              error: String(d)
            });
          }
        })();
        return true;
      }
    case "CH":
      {
        const {
          x: e,
          y: t
        } = i;
        const a = d.tab?.id;
        if (!a) {
          m({
            success: false,
            error: "No tab ID"
          });
          break;
        }
        const s = {
          tabId: a
        };
        (async () => {
          try {
            if (!n.has(a)) {
              await chrome.debugger.attach(s, "1.3");
              n.add(a);
            }
            await chrome.debugger.sendCommand(s, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: e,
              y: t,
              button: "none",
              modifiers: 0
            });
            m({
              success: true
            });
          } catch (o) {
            const e = o instanceof Error ? o.message : String(o);
            m({
              success: false,
              error: e
            });
          }
        })();
        return true;
      }
    case "FOCUS_FLOW_TAB":
      {
        // Chrome throttles a background tab, so a generation that stalls until it is foregrounded
        // never recovers on its own.
        (async () => {
          try {
            const tabs = await chrome.tabs.query({ url: FLOW_TAB_PATTERNS });
            if (tabs.length > 0 && typeof tabs[0].id === "number") {
              await focusTab(tabs[0].id);
              m({ success: true });
            } else {
              m({ success: false, error: "No Flow tab" });
            }
          } catch (err) {
            m({ success: false, error: String(err) });
          }
        })();
        return true;
      }
    case "TRUSTED_CLICK":
      {
        const {
          x: e,
          y: t
        } = i;
        const a = d.tab?.id;
        if (!a) {
          m({
            success: false,
            error: "No tab ID"
          });
          break;
        }
        const s = {
          tabId: a
        };
        (async () => {
          try {
            if (!n.has(a)) {
              await chrome.debugger.attach(s, "1.3");
              n.add(a);
            }
            // Angular Material buttons ignore el.click() and synthetic MouseEvents; they only
            // react to a genuine press/release pair, which CH's hover-only dispatch does not send.
            await chrome.debugger.sendCommand(s, "Input.dispatchMouseEvent", {
              type: "mouseMoved", x: e, y: t, button: "none", modifiers: 0
            });
            await chrome.debugger.sendCommand(s, "Input.dispatchMouseEvent", {
              type: "mousePressed", x: e, y: t, button: "left", clickCount: 1, modifiers: 0
            });
            await chrome.debugger.sendCommand(s, "Input.dispatchMouseEvent", {
              type: "mouseReleased", x: e, y: t, button: "left", clickCount: 1, modifiers: 0
            });
            m({ success: true });
          } catch (o) {
            m({
              success: false,
              error: o instanceof Error ? o.message : String(o)
            });
          }
        })();
        return true;
      }
    case "CC":
      {
        const {
          x: e,
          y: t
        } = i;
        const a = d.tab?.id;
        if (!a) {
          m({
            success: false,
            error: "No tab ID"
          });
          break;
        }
        const s = {
          tabId: a
        };
        const o = e;
        const r = t;
        const c = async () => {
          await chrome.debugger.sendCommand(s, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: o,
            y: r,
            button: "none",
            modifiers: 0
          });
          await chrome.debugger.sendCommand(s, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: o,
            y: r,
            button: "left",
            buttons: 1,
            clickCount: 1,
            modifiers: 0
          });
          await chrome.debugger.sendCommand(s, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: o,
            y: r,
            button: "left",
            buttons: 0,
            clickCount: 1,
            modifiers: 0
          });
        };
        (async () => {
          try {
            if (!n.has(a)) {
              await chrome.debugger.attach(s, "1.3");
              n.add(a);
            }
            await c();
            m({
              success: true
            });
          } catch (e) {
            const t = e instanceof Error ? e.message : String(e);
            m({
              success: false,
              error: t
            });
          }
        })();
        return true;
      }
  }
  return false;
});