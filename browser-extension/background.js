/**
 * EvidencePlatform PDF Capture — Background Service Worker (Manifest V3)
 *
 * Design: tag downloads on onCreated (no interruption), then re-fetch on
 * onChanged(state=complete) using item.finalUrl — the URL after all publisher
 * redirect chains. This is far more reliable than re-fetching item.url, which
 * is the redirect initiator and often returns an auth HTML page instead of
 * the actual PDF bytes.
 *
 * The browser download always completes normally. If auto-capture fails, we
 * notify the EP tab so the user can attach the already-downloaded file.
 */

// ── Storage helpers ───────────────────────────────────────────────────────────

async function getWatchState() {
  const { ep_watch } = await chrome.storage.session.get("ep_watch");
  if (!ep_watch || Date.now() > ep_watch.expiresAt) {
    await chrome.storage.session.remove("ep_watch");
    return null;
  }
  return ep_watch;
}

async function saveWatchState(state) {
  await chrome.storage.session.set({ ep_watch: state });
}

async function clearWatchState() {
  await chrome.storage.session.remove("ep_watch");
}

// Per-download association — survives service-worker restarts
async function savePendingDownload(downloadId, state) {
  await chrome.storage.session.set({ [`ep_dl_${downloadId}`]: state });
}

async function consumePendingDownload(downloadId) {
  const key = `ep_dl_${downloadId}`;
  const data = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);
  return data[key] || null;
}

// ── On first install: inject content script into already-open tabs ─────────────
// Without this, users who had EP open before installing need a manual reload.

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      }).catch(() => {}); // ignore errors for restricted pages
    }
  });
});

// ── Message handler (from content scripts) ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "EP_WATCH_DOWNLOAD") {
    const state = {
      projectId: msg.projectId,
      recordId: msg.recordId || null,
      clusterId: msg.clusterId || null,
      token: msg.token,
      apiBase: msg.apiBase,
      sourceTabId: sender.tab?.id ?? null,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5-minute window
    };
    saveWatchState(state).then(() => {
      if (msg.targetUrl) chrome.tabs.create({ url: msg.targetUrl });
      sendResponse({ ok: true });
    });
    return true; // keep channel open for async sendResponse
  }

  if (msg.type === "EP_CANCEL_WATCH") {
    clearWatchState().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "EP_PING") {
    getWatchState().then((state) => {
      sendResponse({ ok: true, version: "1.0.0", watching: !!state });
    });
    return true;
  }
});

// ── Tag downloads on creation ─────────────────────────────────────────────────
// We tag the download and let Chrome proceed uninterrupted. We intentionally
// do NOT try to fetch the PDF here — item.url is the redirect initiator,
// not the final PDF delivery URL.

chrome.downloads.onCreated.addListener(async (item) => {
  const state = await getWatchState();
  if (!state) return;
  if (!_couldBeDocument(item)) return;

  await savePendingDownload(item.id, state);
  await clearWatchState(); // one download per watch session
  console.log(`[EP] Tagged download ${item.id}`);
});

// ── Capture on completion ─────────────────────────────────────────────────────
// After Chrome finishes downloading, re-fetch using item.finalUrl — the URL
// after all redirects — which delivers the actual PDF bytes.

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current !== "complete") return;

  const state = await consumePendingDownload(delta.id);
  if (!state) return;

  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item) return;

  const fetchUrl = item.finalUrl || item.url;
  const filename = _basename(item.filename || fetchUrl || "document.pdf");

  try {
    const blob = await _fetchWithCookies(fetchUrl, item.referrer || item.url);
    await _uploadToEP(state, blob, filename);
    _notifyTab(state.sourceTabId, { type: "EP_CAPTURE_SUCCESS" });
    _showNotification("PDF Captured", "The PDF has been saved to EvidencePlatform.");
  } catch (err) {
    console.error("[EP] Auto-capture failed:", err.message);
    // Send filename so the EP page can show a one-click manual upload prompt
    _notifyTab(state.sourceTabId, {
      type: "EP_CAPTURE_FAILED_MANUAL",
      filename,
      error: err.message,
    });
    _showNotification(
      "Return to EvidencePlatform",
      `Auto-capture failed. Click 'Upload: ${filename}' in the EP tab.`
    );
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Accept any download that could plausibly be a document. */
function _couldBeDocument(item) {
  const mime = (item.mime || "").toLowerCase();
  if (mime.startsWith("image/")) return false;
  if (mime.startsWith("video/")) return false;
  if (mime.startsWith("audio/")) return false;
  if (mime === "text/html" || mime === "text/css" || mime === "application/javascript") return false;
  return true; // includes application/pdf, application/octet-stream, unknown
}

/**
 * Fetch `url` using the user's cookies.
 * Extension service workers with <all_urls> host_permissions bypass CORS.
 * chrome.cookies.getAll reads the user's profile cookie jar, so SSO
 * session cookies are included automatically.
 */
async function _fetchWithCookies(url, referrer) {
  const cookies = await chrome.cookies.getAll({ url });
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const headers = { Accept: "application/pdf,*/*", Cookie: cookieHeader };
  if (referrer) headers["Referer"] = referrer;

  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from publisher`);

  const blob = await resp.blob();
  if (blob.size === 0) throw new Error("Server returned an empty response");
  return blob;
}

async function _uploadToEP(state, blob, filename) {
  const form = new FormData();
  form.append("file", blob, filename);
  if (state.recordId) form.append("record_id", state.recordId);
  if (state.clusterId) form.append("cluster_id", state.clusterId);

  const resp = await fetch(`${state.apiBase}/projects/${state.projectId}/fulltext`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.token}` },
    body: form,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => String(resp.status));
    throw new Error(`EP upload failed: ${text}`);
  }
  return resp.json();
}

function _notifyTab(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function _showNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon128.png",
    title,
    message,
  });
}

function _basename(path) {
  return path.split("/").pop().split("\\").pop().split("?")[0] || "document.pdf";
}
