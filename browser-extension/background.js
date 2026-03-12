/**
 * EvidencePlatform PDF Capture — Background Service Worker (Manifest V3)
 *
 * Flow:
 *  1. EP React app → content.js → chrome.runtime.sendMessage(EP_WATCH_DOWNLOAD)
 *  2. Background stores watchState, opens targetUrl in a new tab.
 *  3. User authenticates via SSO in that tab, triggers a PDF download.
 *  4. chrome.downloads.onCreated fires → background pauses the download,
 *     re-fetches the PDF using the user's cookies (via chrome.cookies API),
 *     and POSTs it to the EP backend.
 *  5. Result is forwarded back to the source EP tab via chrome.tabs.sendMessage.
 *
 * If the re-fetch fails (e.g. one-time token URLs), the original download is
 * resumed so the user still gets their file, and a fallback notification is shown.
 */

// ── Watch state ───────────────────────────────────────────────────────────────

/** @type {{ projectId: string, recordId: string|null, clusterId: string|null,
 *           token: string, apiBase: string, sourceTabId: number,
 *           expiresAt: number } | null} */
let watchState = null;

const WATCH_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Message handler (from content scripts) ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "EP_WATCH_DOWNLOAD") {
    watchState = {
      projectId: msg.projectId,
      recordId: msg.recordId || null,
      clusterId: msg.clusterId || null,
      token: msg.token,
      apiBase: msg.apiBase,
      sourceTabId: sender.tab?.id ?? null,
      expiresAt: Date.now() + WATCH_TTL_MS,
    };
    if (msg.targetUrl) {
      chrome.tabs.create({ url: msg.targetUrl });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "EP_CANCEL_WATCH") {
    watchState = null;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "EP_PING") {
    sendResponse({
      ok: true,
      version: "1.0.0",
      watching: !!(watchState && Date.now() < watchState.expiresAt),
    });
    return true;
  }
});

// ── Download interception ─────────────────────────────────────────────────────

chrome.downloads.onCreated.addListener(async (item) => {
  // Ignore if no active watch or watch expired
  if (!watchState || Date.now() > watchState.expiresAt) return;

  // Only intercept PDFs
  const looksLikePdf =
    (item.mime && item.mime.includes("pdf")) ||
    (item.filename && item.filename.toLowerCase().endsWith(".pdf")) ||
    (item.url && item.url.toLowerCase().includes(".pdf"));
  if (!looksLikePdf) return;

  // Capture the state and clear the watch immediately (one capture per watch)
  const state = { ...watchState };
  watchState = null;

  // Pause the browser download while we handle it ourselves
  try {
    await chrome.downloads.pause(item.id);
  } catch (_) {
    // Already completed or not pausable — continue anyway
  }

  try {
    const pdfBlob = await _fetchPdf(item.url, item.referrer);
    const filename = _basename(item.filename || item.url || "document.pdf");
    await _uploadToEP(state, pdfBlob, filename);

    // Cancel the browser download — we've handled it
    chrome.downloads.cancel(item.id).catch(() => {});
    chrome.downloads.erase({ id: item.id }).catch(() => {});

    _notifyTab(state.sourceTabId, { type: "EP_CAPTURE_SUCCESS" });
    _showNotification("PDF Captured", "The PDF has been saved to EvidencePlatform.");
  } catch (err) {
    console.error("[EP] Capture failed:", err);

    // Resume so the user still gets their file
    chrome.downloads.resume(item.id).catch(() => {});

    _notifyTab(state.sourceTabId, { type: "EP_CAPTURE_ERROR", error: err.message });
    _showNotification(
      "PDF Capture Failed",
      `Auto-capture failed (${err.message}). Please upload the file manually.`
    );
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch a PDF from `url` using the user's browser cookies for that domain.
 *
 * Because extension service workers run outside the browser's normal cookie
 * partition, credentials:'include' alone does not forward the user's cookies.
 * Instead we read them via chrome.cookies and attach them as a header.
 * With host_permissions:"<all_urls>", Chrome relaxes CORS for extension
 * service worker fetches, so the server-side CORS policy is not a barrier.
 */
async function _fetchPdf(url, referrer) {
  const cookies = await chrome.cookies.getAll({ url });
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const headers = {
    Accept: "application/pdf,*/*",
    Cookie: cookieHeader,
  };
  if (referrer) headers["Referer"] = referrer;

  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching PDF`);

  const blob = await resp.blob();
  if (blob.size === 0) throw new Error("Server returned an empty response");
  return blob;
}

async function _uploadToEP(state, blob, filename) {
  const form = new FormData();
  form.append("file", blob, filename);
  if (state.recordId) form.append("record_id", state.recordId);
  if (state.clusterId) form.append("cluster_id", state.clusterId);

  const resp = await fetch(
    `${state.apiBase}/projects/${state.projectId}/fulltext`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}` },
      body: form,
    }
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.status);
    throw new Error(`EP upload failed: ${text}`);
  }
  return resp.json();
}

function _notifyTab(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // Tab may have navigated away — non-fatal
  });
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
