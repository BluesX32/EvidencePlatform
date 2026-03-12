/**
 * EvidencePlatform PDF Capture — Background Service Worker (Manifest V3)
 *
 * MV3 service workers are ephemeral: they can be suspended (and their
 * in-memory state lost) at any time.  We persist the watch state in
 * chrome.storage.session, which survives service-worker restarts within
 * the same browser session.
 */

// ── Watch state helpers (chrome.storage.session) ──────────────────────────────

const WATCH_KEY = "ep_watch_state";

async function getWatchState() {
  const data = await chrome.storage.session.get(WATCH_KEY);
  const state = data[WATCH_KEY];
  if (!state || Date.now() > state.expiresAt) {
    await chrome.storage.session.remove(WATCH_KEY);
    return null;
  }
  return state;
}

async function saveWatchState(state) {
  await chrome.storage.session.set({ [WATCH_KEY]: state });
}

async function clearWatchState() {
  await chrome.storage.session.remove(WATCH_KEY);
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

// ── Download interception ─────────────────────────────────────────────────────

chrome.downloads.onCreated.addListener(async (item) => {
  const state = await getWatchState();
  if (!state) return;

  const looksLikePdf =
    (item.mime && item.mime.includes("pdf")) ||
    (item.filename && item.filename.toLowerCase().endsWith(".pdf")) ||
    (item.url && item.url.toLowerCase().includes(".pdf"));
  if (!looksLikePdf) return;

  // Clear immediately — one capture per watch
  await clearWatchState();

  // Pause the browser download while we handle it
  try { await chrome.downloads.pause(item.id); } catch (_) {}

  try {
    const pdfBlob = await _fetchPdf(item.url, item.referrer);
    const filename = _basename(item.filename || item.url || "document.pdf");
    await _uploadToEP(state, pdfBlob, filename);

    // Cancel the now-redundant browser download
    chrome.downloads.cancel(item.id).catch(() => {});
    chrome.downloads.erase({ id: item.id }).catch(() => {});

    _notifyTab(state.sourceTabId, { type: "EP_CAPTURE_SUCCESS" });
    _showNotification("PDF Captured", "The PDF has been saved to EvidencePlatform.");
  } catch (err) {
    console.error("[EP] Capture failed:", err.message);
    chrome.downloads.resume(item.id).catch(() => {}); // give the user their file back
    _notifyTab(state.sourceTabId, { type: "EP_CAPTURE_ERROR", error: err.message });
    _showNotification(
      "PDF Capture Failed",
      `Auto-capture failed: ${err.message}. Please upload the file manually.`
    );
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Re-fetch the PDF at `url` using the user's cookies for that domain.
 *
 * Extension service workers with host_permissions bypass CORS, so even
 * cross-origin fetches succeed regardless of the server's CORS policy.
 * chrome.cookies.getAll reads the *user's* cookie jar (not the extension's),
 * so institutional SSO session cookies are included.
 */
async function _fetchPdf(url, referrer) {
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
