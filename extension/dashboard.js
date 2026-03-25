let backendBaseUrl = "https://continuum-61io.onrender.com/";
let mode = "docs";
let items = [];
let displayedItems = [];
let pendingFocus = null;

function getSourceMeta(item) {
  const sourceBasis = String(
    item?.source_basis || (item?.source_session_ids || item?.session_id ? "internal_capture" : "internal_draft")
  );

  const defaults = {
    internal_capture: {
      label: "Internal workflow",
      note: "Built from captured browser actions, screenshots, and any explicitly included process evidence."
    },
    internal_draft: {
      label: "Internal draft",
      note: "Internal content with no verified captured workflow attached yet."
    },
    trusted_external: {
      label: "Trusted external",
      note: "Based on trusted public product documentation. Steps may vary by tenant, permissions, or rollout."
    },
    mixed: {
      label: "Mixed sources",
      note: "Combines internal workflow evidence with trusted external references. Verify against your team process before following."
    },
    community: {
      label: "Community source",
      note: "Based on community guidance and should be verified against trusted documentation before use."
    }
  };

  const fallback = defaults[sourceBasis] || defaults.internal_draft;

  return {
    basis: sourceBasis,
    label: String(item?.source_label || fallback.label),
    note: String(item?.source_note || fallback.note)
  };
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get("mode");
  if (requestedMode === "docs" || requestedMode === "meetings") {
    mode = requestedMode;
  }

  pendingFocus = {
    mode,
    sessionId: params.get("session_id") || "",
    createdAt: params.get("created_at") || "",
    meetingId: params.get("meeting_id") || "",
    title: params.get("title") || ""
  };

  applyModeUI();

  document.getElementById("tabDocs").addEventListener("click", () => setMode("docs"));
  document.getElementById("tabMeetings").addEventListener("click", () => setMode("meetings"));

  document.getElementById("searchBtn").addEventListener("click", () => runSearch());
  document.getElementById("refreshBtn").addEventListener("click", () => runSearch(""));
  document.getElementById("externalDocBtn").addEventListener("click", openExternalGuideStudio);
  document.getElementById("docTypeFilter").addEventListener("change", applyDocControls);
  document.getElementById("sourceBasisFilter").addEventListener("change", applyDocControls);
  document.getElementById("docSort").addEventListener("change", applyDocControls);
  document.getElementById("list").addEventListener("click", (e) => {
  const row = e.target.closest(".item");
  if (!row) return;

  const idx = Number(row.getAttribute("data-idx"));
  const currentItems = getCurrentListItems();
  if (!Number.isFinite(idx) || !currentItems[idx]) return;

  markSelected(idx);
  openDetailPage(currentItems[idx]);
});

  await runSearch("");
});

async function loadSettings() {
  const res = await new Promise((resolve) => chrome.storage.sync.get("continuum_settings", resolve));
  const settings = res.continuum_settings || {};
  backendBaseUrl = settings.backendBaseUrl || backendBaseUrl;
  document.getElementById("backendInfo").textContent = `Backend: ${backendBaseUrl}`;
}

function applyModeUI() {
  const docsMode = mode === "docs";

  document.getElementById("tabDocs").classList.toggle("active", docsMode);
  document.getElementById("tabMeetings").classList.toggle("active", !docsMode);
  document.getElementById("listTitle").textContent = docsMode ? "Documents" : "Meetings";
  document.getElementById("q").placeholder = docsMode ? "Search docs..." : "Search meetings...";
  document.getElementById("externalDocBtn").classList.toggle("hidden", !docsMode);
  document.getElementById("docControls").classList.toggle("hidden", !docsMode);
}

function setMode(next) {
  mode = next;
  pendingFocus = null;
  applyModeUI();
  document.getElementById("preview").textContent = "Select an item.";
  runSearch("");
}

async function runSearch(forcedQuery) {
  const q = typeof forcedQuery === "string" ? forcedQuery : document.getElementById("q").value.trim();
  document.getElementById("list").textContent = "Loading...";
  document.getElementById("preview").textContent = "Select an item.";

  const url =
    mode === "docs"
      ? `${backendBaseUrl}/docs/search?query=${encodeURIComponent(q || "")}`
      : `${backendBaseUrl}/meetings/search?query=${encodeURIComponent(q || "")}`;

  const res = await fetch(url).then((r) => r.json());
  items = Array.isArray(res.items) ? res.items : [];
  displayedItems = [...items];

  if (!items.length) {
    document.getElementById("list").textContent = "No results found.";
    return;
  }

  if (mode === "docs") {
    applyDocControls();
    return;
  }

  renderList(items);
}

function applyDocControls() {
  if (mode !== "docs") {
    displayedItems = [...items];
    renderList(displayedItems);
    return;
  }

  const docType = document.getElementById("docTypeFilter").value;
  const sourceBasis = document.getElementById("sourceBasisFilter").value;
  const sort = document.getElementById("docSort").value;

  let nextItems = [...items];

  if (docType !== "all") {
    nextItems = nextItems.filter((item) => String(item.doc_type || "").toLowerCase() === docType);
  }

  if (sourceBasis !== "all") {
    nextItems = nextItems.filter((item) => getSourceMeta(item).basis === sourceBasis);
  }

  if (sort === "oldest") {
    nextItems.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  } else if (sort === "title_asc") {
    nextItems.sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" }));
  } else {
    nextItems.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  }

  displayedItems = nextItems;
  renderList(displayedItems);
}

function renderList(listItems) {
  displayedItems = Array.isArray(listItems) ? listItems : [];

  if (!displayedItems.length) {
    document.getElementById("list").textContent = "No results match the current filters.";
    document.getElementById("preview").textContent = "Select an item.";
    return;
  }

  document.getElementById("list").innerHTML = displayedItems.map((it, idx) => {
    if (mode === "docs") {
      const source = getSourceMeta(it);
      return `
        <div class="item" data-idx="${idx}">
          <div class="itemTitleRow">
            <strong>${escapeHtml(it.title || "Untitled")}</strong>
            <span class="source-pill source-pill--${escapeHtml(source.basis)}">${escapeHtml(source.label)}</span>
          </div>
          <div class="subtle">${[
            escapeHtml(it.created_at || ""),
            it.session_id ? `Session: ${escapeHtml(it.session_id)}` : ""
          ].filter(Boolean).join(" • ")}</div>
          <div class="subtle">${escapeHtml(source.note)}</div>
          <div>${escapeHtml(it.summary || "")}</div>
        </div>
      `;
    }

    const notes = it.notes || {};
    const minutes = notes.minutes_markdown || notes.summary || "";
    return `
      <div class="item" data-idx="${idx}">
        <strong>${escapeHtml(it.page_title || "Meeting")}</strong>
        <div class="subtle">${escapeHtml(it.created_at || "")} • Session: ${escapeHtml(it.session_id || "")}</div>
        <div>${escapeHtml(String(minutes).slice(0, 180))}</div>
      </div>
    `;
  }).join("");

  const selectedIdx = getPreferredIndex();
  markSelected(selectedIdx);
  showPreview(displayedItems[selectedIdx]);
}

function getCurrentListItems() {
  return mode === "docs" ? displayedItems : items;
}

function getPreferredIndex() {
  const currentItems = getCurrentListItems();

  if (!pendingFocus || pendingFocus.mode !== mode) return 0;

  let idx = -1;

  if (mode === "meetings") {
    idx = currentItems.findIndex((it) =>
      (pendingFocus.meetingId && it.meeting_id === pendingFocus.meetingId) ||
      (
        pendingFocus.createdAt &&
        it.created_at === pendingFocus.createdAt &&
        (!pendingFocus.sessionId || it.session_id === pendingFocus.sessionId)
      )
    );
  } else {
    idx = currentItems.findIndex((it) =>
      (pendingFocus.createdAt && it.created_at === pendingFocus.createdAt) ||
      (
        pendingFocus.sessionId &&
        it.session_id === pendingFocus.sessionId &&
        (!pendingFocus.title || (it.title || "") === pendingFocus.title)
      )
    );
  }

  pendingFocus = null;
  return idx >= 0 ? idx : 0;
}

function markSelected(idx) {
  document.querySelectorAll("#list .item").forEach((row, rowIdx) => {
    row.classList.toggle("selected", rowIdx === idx);
  });
}

function openDetailPage(it) {
  const params = new URLSearchParams();
  params.set("mode", mode);

  if (mode === "meetings") {
    if (it.meeting_id) params.set("meeting_id", it.meeting_id);
    if (it.created_at) params.set("created_at", it.created_at);
    if (it.session_id) params.set("session_id", it.session_id);
  } else {
    if (it.created_at) params.set("created_at", it.created_at);
    if (it.session_id) params.set("session_id", it.session_id);
    if (it.title) params.set("title", it.title);
  }

  const url = chrome.runtime.getURL(`detail.html?${params.toString()}`);
  chrome.tabs.create({ url });
}

function showPreview(it) {
  const preview = document.getElementById("preview");

  if (mode === "docs") {
    const source = getSourceMeta(it);
    const markdown = [
      `# ${it.title || "Untitled"}`,
      it.created_at ? `_${it.created_at}_` : "",
      `**Source basis:** ${source.label}`,
      source.note ? `_${source.note}_` : "",
      "",
      String(it.content || "")
    ].filter(Boolean).join("\n");

    if (typeof window.renderMarkdownPreview === "function") {
      window.renderMarkdownPreview(markdown);
    } else {
      preview.innerHTML = `<pre>${escapeHtml(markdown)}</pre>`;
    }
    return;
  }

  const notes = it.notes || {};
  const minutes = notes.minutes_markdown || notes.summary || "";
  const transcript = it.transcript || "";
  const warnings = Array.isArray(notes.warnings) ? notes.warnings : [];

  const markdown = [
    `# ${it.page_title || "Meeting"}`,
    it.created_at ? `_${it.created_at}_` : "",
    "",
    "## Minutes",
    String(minutes || "(empty)"),
    "",
    "## Transcript",
    String(transcript || "(empty)"),
    warnings.length ? `\n## Warnings\n- ${warnings.join("\n- ")}` : ""
  ].filter(Boolean).join("\n");

  if (typeof window.renderMarkdownPreview === "function") {
    window.renderMarkdownPreview(markdown);
  } else {
    preview.innerHTML = `<pre>${escapeHtml(markdown)}</pre>`;
  }
}

function openExternalGuideStudio() {
  const url = chrome.runtime.getURL("external_assist.html");
  chrome.tabs.create({ url });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}