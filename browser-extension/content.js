/**
 * EvidencePlatform PDF Capture — Content Script
 *
 * Injected into every page. Acts as a message bridge between the EP React
 * application (which runs in the page's JS context) and the extension's
 * background service worker (which has access to chrome.* APIs).
 *
 * Messages from page  →  forwarded to background via chrome.runtime
 * Messages from background  →  dispatched to page via window.postMessage
 */

// Announce presence immediately so the page can detect the extension.
window.postMessage({ type: "EP_EXTENSION_READY", version: "1.0.0" }, "*");

// ── Page → Background bridge ──────────────────────────────────────────────────

window.addEventListener("message", (event) => {
  // Only handle messages posted by the same page (not iframes or other origins)
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "EP_PROBE":
      // Re-announce so React components that mount after load can detect us
      window.postMessage({ type: "EP_EXTENSION_READY", version: "1.0.0" }, "*");
      // Also ask the background for live watch state
      chrome.runtime.sendMessage({ type: "EP_PING" }, (res) => {
        if (chrome.runtime.lastError) return;
        window.postMessage({ type: "EP_PING_RESPONSE", ...res }, "*");
      });
      break;

    case "EP_WATCH_DOWNLOAD":
    case "EP_CANCEL_WATCH":
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return;
        window.postMessage({ type: `${msg.type}_ACK`, ...res }, "*");
      });
      break;

    default:
      break;
  }
});

// ── Background → Page bridge ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (
    msg.type === "EP_CAPTURE_SUCCESS" ||
    msg.type === "EP_CAPTURE_ERROR"
  ) {
    window.postMessage(msg, "*");
  }
});
