let backendBaseUrl = "http://127.0.0.1:8000";
let docs = [];

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  document.getElementById("searchBtn").addEventListener("click", () => runSearch());
  document.getElementById("refreshBtn").addEventListener("click", () => runSearch(""));

  await runSearch("");
});

async function loadSettings() {
  const res = await new Promise((resolve) => chrome.storage.sync.get("continuum_settings", resolve));
  const settings = res.continuum_settings || {};
  backendBaseUrl = settings.backendBaseUrl || backendBaseUrl;
  document.getElementById("backendInfo").textContent = `Backend: ${backendBaseUrl}`;
}

async function runSearch(forcedQuery) {
  const q = typeof forcedQuery === "string" ? forcedQuery : document.getElementById("q").value.trim();
  document.getElementById("list").textContent = "Loading...";
  document.getElementById("preview").textContent = "Select a document.";

  const url = `${backendBaseUrl}/docs/search?query=${encodeURIComponent(q || "")}`;
  const res = await fetch(url).then(r => r.json());
  docs = res.items || [];

  if (!docs.length) {
    document.getElementById("list").textContent = "No documents found.";
    return;
  }

  document.getElementById("list").innerHTML = docs.map((d, idx) => `
    <div class="item" data-idx="${idx}">
      <strong>${escapeHtml(d.title || "Untitled")}</strong>
      <div class="subtle">${escapeHtml(d.created_at || "")} • Session: ${escapeHtml(d.session_id || "")}</div>
      <div>${escapeHtml(d.summary || "")}</div>
    </div>
  `).join("");

  Array.from(document.querySelectorAll(".item")).forEach(el => {
    el.addEventListener("click", () => {
      const idx = Number(el.getAttribute("data-idx"));
      showPreview(docs[idx]);
    });
  });
}

function showPreview(doc) {
  document.getElementById("preview").innerHTML = `
    <div>
      <strong>${escapeHtml(doc.title || "Untitled")}</strong>
      <div class="subtle">${escapeHtml(doc.created_at || "")}</div>
      <pre>${escapeHtml(doc.content || "")}</pre>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}