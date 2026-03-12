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
 *
 * Key failure modes defended against:
 *  - One-time download tokens: publisher URL consumed by Chrome's download;
 *    our re-fetch gets an HTML page. Caught by Content-Type check + %PDF magic.
 *  - MIME type with charset param: "text/html; charset=utf-8" ≠ "text/html"
 *    (equality check). Fixed by using startsWith().
 *  - Empty / wrong blob: checked via magic bytes, not just blob.size.
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
      sendResponse({ ok: true, version: "1.1.0", watching: !!state });
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
  console.log(`[EP] Tagged download ${item.id} (mime: ${item.mime || "unknown"})`);
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

  // If Chrome itself tells us this is HTML after completion, bail immediately.
  const mime = (item.mime || "").toLowerCase();
  if (mime.startsWith("text/html") || mime.startsWith("text/css") || mime === "application/javascript") {
    console.log(`[EP] Download ${delta.id} is ${mime}, not a document — skipping`);
    _notifyTab(state.sourceTabId, {
      type: "EP_CAPTURE_FAILED_MANUAL",
      filename: _basename(item.filename || "document.pdf"),
      error: "Download was a web page, not a PDF. Try navigating directly to the PDF link.",
    });
    return;
  }

  const fetchUrl = item.finalUrl || item.url;
  const filename = _basename(item.filename || fetchUrl || "document.pdf");

  try {
    const blob = await _fetchWithCookies(fetchUrl, item.referrer || item.url);
    // Guard: verify the bytes we fetched are actually a PDF, not an HTML page
    await _assertIsPdf(blob, fetchUrl);
    await _uploadToEP(state, blob, _ensurePdfExt(filename));
    _notifyTab(state.sourceTabId, { type: "EP_CAPTURE_SUCCESS" });
    _showNotification("PDF Captured", "The PDF has been saved to EvidencePlatform.");
  } catch (err) {
    console.error("[EP] Auto-capture failed:", err.message);
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

/**
 * Reject known non-document MIME types at download creation time.
 * Uses startsWith so "text/html; charset=utf-8" is correctly rejected.
 */
function _couldBeDocument(item) {
  const mime = (item.mime || "").toLowerCase();
  if (mime.startsWith("image/")) return false;
  if (mime.startsWith("video/")) return false;
  if (mime.startsWith("audio/")) return false;
  if (mime.startsWith("text/html")) return false;   // was: === "text/html" (missed charset params)
  if (mime.startsWith("text/css")) return false;
  if (mime.startsWith("application/javascript")) return false;
  if (mime.startsWith("text/javascript")) return false;
  return true; // accept application/pdf, application/octet-stream, unknown
}

/**
 * Fetch `url` using the user's cookies.
 *
 * Two-stage validation:
 *  1. Content-Type header: reject HTML before downloading the full body.
 *  2. Caller must also run _assertIsPdf() on the returned blob.
 *
 * Extension service workers with <all_urls> host_permissions bypass CORS and
 * can set the Cookie header manually. chrome.cookies.getAll reads the user's
 * profile cookie jar, so institutional SSO session cookies are included.
 */
async function _fetchWithCookies(url, referrer) {
  const cookies = await chrome.cookies.getAll({ url });
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const headers = {
    Accept: "application/pdf,application/octet-stream,*/*;q=0.8",
    Cookie: cookieHeader,
    "Cache-Control": "no-cache",
  };
  if (referrer) headers["Referer"] = referrer;

  const resp = await fetch(url, { headers });

  // Check Content-Type before downloading the body — saves bandwidth and gives
  // a clear error when a one-time token has been consumed (publisher returns
  // an HTML login redirect with HTTP 200).
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  if (ct.startsWith("text/html")) {
    throw new Error(
      `Publisher returned a web page instead of a PDF (HTTP ${resp.status}). ` +
      `The download link may have expired — try the 'Open & Capture' button again after logging in.`
    );
  }

  if (!resp.ok) throw new Error(`HTTP ${resp.status} from publisher`);

  const blob = await resp.blob();
  if (blob.size === 0) throw new Error("Server returned an empty response.");
  return blob;
}

/**
 * Verify the blob starts with the PDF magic bytes "%PDF".
 * This is the last line of defence: even if Content-Type was wrong/missing,
 * a real PDF always starts with %PDF. An HTML page never does.
 */
async function _assertIsPdf(blob, url) {
  const buf = await blob.slice(0, 5).arrayBuffer();
  const header = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!header.startsWith("%PDF")) {
    const preview = header.replace(/[\x00-\x1f\x7f-\xff]/g, "?");
    throw new Error(
      `Captured file is not a PDF (starts with "${preview}"). ` +
      `The publisher may use single-use download links — please download the PDF ` +
      `and use the manual upload option.`
    );
  }
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

/** Ensure the filename ends with .pdf so the backend accepts it. */
function _ensurePdfExt(filename) {
  return filename.toLowerCase().endsWith(".pdf") ? filename : filename + ".pdf";
}
