let backendBaseUrl = "http://127.0.0.1:8000";
let currentMode = "docs";
let currentDoc = null;
let isEditing = false;

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  document.getElementById("backToLibrary").addEventListener("click", () => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode") || "docs";
    window.location.href = chrome.runtime.getURL(`dashboard.html?mode=${encodeURIComponent(mode)}`);
  });

  document.getElementById("editDocBtn").addEventListener("click", enterEditMode);
  document.getElementById("cancelEditBtn").addEventListener("click", cancelEditMode);
  document.getElementById("saveDocBtn").addEventListener("click", saveDocumentEdits);

  document.getElementById("docTitleInput").addEventListener("input", renderEditorPreview);
  document.getElementById("docSummaryInput").addEventListener("input", renderEditorPreview);
  document.getElementById("docBodyInput").addEventListener("input", renderEditorPreview);

  await loadItem();
});

async function loadSettings() {
  const res = await new Promise((resolve) => chrome.storage.sync.get("continuum_settings", resolve));
  const settings = res.continuum_settings || {};
  backendBaseUrl = settings.backendBaseUrl || backendBaseUrl;
}

async function loadItem() {
  const params = new URLSearchParams(window.location.search);
  currentMode = params.get("mode") || "docs";

  try {
    const url = buildItemUrl(currentMode, params);
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok || !data.item) {
      throw new Error(data.detail || data.error || "Could not load item.");
    }

    if (currentMode === "meetings") {
      renderMeeting(data.item);
      return;
    }

    currentDoc = data.item;
    renderDocumentView(currentDoc);
  } catch (e) {
    document.getElementById("detailType").textContent = "Error";
    document.getElementById("pageTitle").textContent = "Could not load item";
    document.getElementById("pageMeta").textContent = e.message || "Unknown error";
    document.getElementById("preview").innerHTML = `<div class="subtle">${escapeHtml(e.message || "Unknown error")}</div>`;
  }
}

function buildItemUrl(mode, params) {
  const query = new URLSearchParams();

  if (mode === "meetings") {
    if (params.get("meeting_id")) query.set("meeting_id", params.get("meeting_id"));
    if (params.get("created_at")) query.set("created_at", params.get("created_at"));
    if (params.get("session_id")) query.set("session_id", params.get("session_id"));
    return `${backendBaseUrl}/meetings/item?${query.toString()}`;
  }

  if (params.get("created_at")) query.set("created_at", params.get("created_at"));
  if (params.get("session_id")) query.set("session_id", params.get("session_id"));
  if (params.get("title")) query.set("title", params.get("title"));
  return `${backendBaseUrl}/docs/item?${query.toString()}`;
}

function renderDocumentView(doc) {
  isEditing = false;
  currentDoc = doc;

  document.title = `${doc.title || "Document"} · Continuum`;
  document.getElementById("detailType").textContent = "Document";
  document.getElementById("pageTitle").textContent = doc.title || "Untitled Document";
  document.getElementById("pageMeta").textContent = buildMeta(doc.created_at, doc.session_id);

  const summary = String(doc.summary || "").trim();
  const summaryCard = document.getElementById("summaryCard");
  const summaryText = document.getElementById("summaryText");

  if (summary) {
    summaryCard.classList.remove("hidden");
    summaryText.textContent = summary;
  } else {
    summaryCard.classList.add("hidden");
    summaryText.textContent = "";
  }

  renderMarkdownIntoTarget("preview", String(doc.content || ""));

  document.getElementById("viewState").classList.remove("hidden");
  document.getElementById("editState").classList.add("hidden");

  document.getElementById("editDocBtn").classList.remove("hidden");
  document.getElementById("saveDocBtn").classList.add("hidden");
  document.getElementById("cancelEditBtn").classList.add("hidden");
  document.getElementById("saveStatus").textContent = "";
}

function renderMeeting(meeting) {
  isEditing = false;
  currentDoc = null;

  document.title = `${meeting.page_title || "Meeting"} · Continuum`;
  document.getElementById("detailType").textContent = "Meeting";
  document.getElementById("pageTitle").textContent = meeting.page_title || "Meeting";
  document.getElementById("pageMeta").textContent = buildMeta(meeting.created_at, meeting.session_id);

  document.getElementById("summaryCard").classList.add("hidden");
  document.getElementById("editDocBtn").classList.add("hidden");
  document.getElementById("saveDocBtn").classList.add("hidden");
  document.getElementById("cancelEditBtn").classList.add("hidden");
  document.getElementById("viewState").classList.remove("hidden");
  document.getElementById("editState").classList.add("hidden");

  const notes = meeting.notes || {};
  const warnings = Array.isArray(notes.warnings) ? notes.warnings : [];
  const minutes = cleanMinutesMarkdown(notes.minutes_markdown || notes.summary || "");
  const transcript = String(meeting.transcript || "").trim();

  const markdown = [
    minutes ? `## Minutes\n\n${minutes}` : "",
    transcript ? `## Transcript\n\n${transcript}` : "",
    warnings.length ? `## Warnings\n\n- ${warnings.join("\n- ")}` : ""
  ].filter(Boolean).join("\n\n");

  renderMarkdownIntoTarget("preview", markdown || "No meeting content available.");
}

function enterEditMode() {
  if (currentMode !== "docs" || !currentDoc) return;

  isEditing = true;

  document.getElementById("docTitleInput").value = currentDoc.title || "";
  document.getElementById("docSummaryInput").value = currentDoc.summary || "";
  document.getElementById("docBodyInput").value = currentDoc.content || "";

  document.getElementById("viewState").classList.add("hidden");
  document.getElementById("editState").classList.remove("hidden");

  document.getElementById("editDocBtn").classList.add("hidden");
  document.getElementById("saveDocBtn").classList.remove("hidden");
  document.getElementById("cancelEditBtn").classList.remove("hidden");
  document.getElementById("saveStatus").textContent = "";

  renderEditorPreview();
}

function cancelEditMode() {
  if (!currentDoc) return;
  renderDocumentView(currentDoc);
}

function renderEditorPreview() {
  const title = document.getElementById("docTitleInput").value.trim();
  const summary = document.getElementById("docSummaryInput").value.trim();
  const body = document.getElementById("docBodyInput").value;

  document.getElementById("editorPreviewTitle").textContent = title || "Untitled Document";

  const summaryWrap = document.getElementById("editorPreviewSummaryWrap");
  const summaryBox = document.getElementById("editorPreviewSummary");

  if (summary) {
    summaryWrap.classList.remove("hidden");
    summaryBox.textContent = summary;
  } else {
    summaryWrap.classList.add("hidden");
    summaryBox.textContent = "";
  }

  renderMarkdownIntoTarget("editorPreview", body || "_No content yet._");
}

async function saveDocumentEdits() {
  if (currentMode !== "docs" || !currentDoc) return;

  const title = document.getElementById("docTitleInput").value.trim();
  const summary = document.getElementById("docSummaryInput").value.trim();
  const content = document.getElementById("docBodyInput").value;
  const status = document.getElementById("saveStatus");

  if (!title) {
    status.textContent = "Title is required.";
    return;
  }

  status.textContent = "Saving...";

  try {
    const res = await fetch(`${backendBaseUrl}/docs/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        created_at: currentDoc.created_at,
        session_id: currentDoc.session_id || "",
        original_title: currentDoc.title || "",
        title,
        summary,
        content
      })
    });

    const data = await res.json();

    if (!res.ok || !data.item) {
      throw new Error(data.detail || data.error || "Could not save document.");
    }

    currentDoc = data.item;

    const params = new URLSearchParams(window.location.search);
    params.set("title", currentDoc.title || "");
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);

    renderDocumentView(currentDoc);
  } catch (e) {
    status.textContent = e.message || "Could not save document.";
  }
}

function renderMarkdownIntoTarget(targetId, markdown) {
  if (typeof window.renderMarkdownInto === "function") {
    window.renderMarkdownInto(targetId, markdown);
    return;
  }

  const target = document.getElementById(targetId);
  if (!target) return;
  target.innerHTML = `<pre>${escapeHtml(markdown)}</pre>`;
}

function cleanMinutesMarkdown(value) {
  let text = String(value || "").trim();
  text = text.replace(/^#\s+Meeting Minutes[^\n]*\n+/i, "");
  text = text.replace(/\.\s+-\s+/g, ".\n- ");
  text = text.replace(/:\s+-\s+/g, ":\n- ");
  return text;
}

function buildMeta(createdAt, sessionId) {
  const parts = [];
  if (createdAt) parts.push(createdAt);
  if (sessionId) parts.push(`Session: ${sessionId}`);
  return parts.join(" · ");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}