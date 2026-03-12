const dot = document.getElementById("status-dot");
const statusEl = document.getElementById("watch-status");
const metaEl = document.getElementById("watch-meta");
const cancelBtn = document.getElementById("cancel-btn");
const apiBaseInput = document.getElementById("api-base");
const saveBtn = document.getElementById("save-btn");
const saveMsg = document.getElementById("save-msg");

// ── Load settings ─────────────────────────────────────────────────────────────

chrome.storage.local.get(["apiBase"], (data) => {
  apiBaseInput.value = data.apiBase || "http://localhost:8000";
});

saveBtn.addEventListener("click", () => {
  chrome.storage.local.set({ apiBase: apiBaseInput.value.trim() }, () => {
    saveMsg.style.display = "inline";
    setTimeout(() => (saveMsg.style.display = "none"), 1500);
  });
});

// ── Fetch live watch state from background ────────────────────────────────────

chrome.runtime.sendMessage({ type: "EP_PING" }, (res) => {
  if (chrome.runtime.lastError || !res) {
    setStatus("error", "Extension error", "");
    return;
  }
  if (res.watching) {
    setStatus("watching", "Watching for download…", "PDF capture is active. Download a PDF to capture it.");
    cancelBtn.style.display = "inline-block";
  } else {
    setStatus("idle", "Ready", "No active watch session.");
  }
});

cancelBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "EP_CANCEL_WATCH" }, () => {
    setStatus("idle", "Ready", "Watch cancelled.");
    cancelBtn.style.display = "none";
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(state, label, meta) {
  statusEl.textContent = label;
  metaEl.textContent = meta;
  dot.className = "dot";
  if (state === "watching") dot.classList.add("yellow");
  else if (state === "idle") dot.classList.add("green");
  else dot.classList.add("red");
}
