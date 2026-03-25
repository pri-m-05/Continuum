let backendBaseUrl = "https://continuum-61io.onrender.com/";
let currentMode = "docs";
let currentDoc = null;
let currentMeeting = null;
let screenshotItems = [];
let selectedScreenshotId = null;

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  document.getElementById("backToLibrary").addEventListener("click", () => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode") || "docs";
    window.location.href = chrome.runtime.getURL(`dashboard.html?mode=${encodeURIComponent(mode)}`);
  });

  document.getElementById("editDocBtn").addEventListener("click", enterEditMode);
  document.getElementById("shareDocBtn").addEventListener("click", openShareModal);
  document.getElementById("startGuideBtn").addEventListener("click", startGuidedRun);
  document.getElementById("cancelEditBtn").addEventListener("click", cancelEditMode);
  document.getElementById("saveDocBtn").addEventListener("click", saveDocumentEdits);
  document.getElementById("insertScreenshotBtn").addEventListener("click", openScreenshotPicker);
  document.getElementById("includeInProcessBtn").addEventListener("click", includeCurrentItemInProcess);
  document.getElementById("closeScreenshotModalBtn").addEventListener("click", closeScreenshotPicker);
  document.getElementById("cancelScreenshotInsertBtn").addEventListener("click", closeScreenshotPicker);
  document.getElementById("confirmScreenshotInsertBtn").addEventListener("click", insertSelectedScreenshot);
  document.getElementById("closeShareModalBtn").addEventListener("click", closeShareModal);
  document.getElementById("downloadDocxBtn").addEventListener("click", () => downloadDocumentExport("docx"));
  document.getElementById("downloadPdfBtn").addEventListener("click", () => downloadDocumentExport("pdf"));
  document.getElementById("emailDocxBtn").addEventListener("click", () => downloadEmailDraft("docx"));
  document.getElementById("emailPdfBtn").addEventListener("click", () => downloadEmailDraft("pdf"));
  document.getElementById("docTitleInput").addEventListener("input", renderEditorPreview);
  document.getElementById("docSummaryInput").addEventListener("input", renderEditorPreview);
  document.getElementById("docBodyInput").addEventListener("input", renderEditorPreview);
  document.getElementById("qaAskBtn").addEventListener("click", askDocumentQuestion);
  document.getElementById("qaGuideBtn").addEventListener("click", startGuidedRun);

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
    currentMeeting = null;
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
  currentDoc = doc;

  document.title = `${doc.title || "Document"} · Continuum`;
  document.getElementById("detailType").textContent = "Document";
  document.getElementById("pageTitle").textContent = doc.title || "Untitled Document";
  document.getElementById("pageMeta").textContent = buildMeta(doc.created_at, doc.session_id);
  renderSourceBasis(doc);
  const hasInternalFlow = !!(
    doc.session_id ||
    (Array.isArray(doc.source_session_ids) && doc.source_session_ids.length)
  );

  document.getElementById("processIncludeStatus").textContent = "";
  document.getElementById("includeInProcessBtn").classList.toggle("hidden", !hasInternalFlow);
  document.getElementById("shareDocBtn").classList.remove("hidden");
  if (hasInternalFlow) {
    document.getElementById("includeInProcessBtn").textContent = "Include Doc Session";
  }
  document.getElementById("startGuideBtn").classList.toggle("hidden", !hasInternalFlow);
  document.getElementById("qaGuideBtn").classList.toggle("hidden", !hasInternalFlow);

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

  resetQaSurface();
  document.getElementById("qaSection").classList.remove("hidden");
  document.getElementById("viewState").classList.remove("hidden");
  document.getElementById("editState").classList.add("hidden");

  document.getElementById("editDocBtn").classList.remove("hidden");
  document.getElementById("shareDocBtn").classList.remove("hidden");
  document.getElementById("startGuideBtn").classList.toggle("hidden", !hasInternalFlow);
  document.getElementById("insertScreenshotBtn").classList.add("hidden");
  document.getElementById("saveDocBtn").classList.add("hidden");
  document.getElementById("cancelEditBtn").classList.add("hidden");
  document.getElementById("saveStatus").textContent = "";
}

function renderMeeting(meeting) {
  currentDoc = null;

  document.title = `${meeting.page_title || "Meeting"} · Continuum`;
  document.getElementById("detailType").textContent = "Meeting";
  document.getElementById("pageTitle").textContent = meeting.page_title || "Meeting";
  document.getElementById("pageMeta").textContent = buildMeta(meeting.created_at, meeting.session_id);
  hideSourceBasis();
  document.getElementById("summaryCard").classList.add("hidden");
  document.getElementById("qaSection").classList.add("hidden");
  document.getElementById("editDocBtn").classList.add("hidden");
  document.getElementById("shareDocBtn").classList.add("hidden");
  document.getElementById("startGuideBtn").classList.add("hidden");
  document.getElementById("insertScreenshotBtn").classList.add("hidden");
  document.getElementById("saveDocBtn").classList.add("hidden");
  document.getElementById("cancelEditBtn").classList.add("hidden");
  document.getElementById("viewState").classList.remove("hidden");
  document.getElementById("editState").classList.add("hidden");
  currentMeeting = meeting;
  document.getElementById("processIncludeStatus").textContent = "";
  document.getElementById("includeInProcessBtn").classList.remove("hidden");
  document.getElementById("includeInProcessBtn").textContent = "Include Meeting";


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

  document.getElementById("docTitleInput").value = currentDoc.title || "";
  document.getElementById("docSummaryInput").value = currentDoc.summary || "";
  document.getElementById("docBodyInput").value = currentDoc.content || "";

  document.getElementById("viewState").classList.add("hidden");
  document.getElementById("editState").classList.remove("hidden");

  document.getElementById("editDocBtn").classList.add("hidden");
  document.getElementById("shareDocBtn").classList.add("hidden");
  document.getElementById("startGuideBtn").classList.add("hidden");
  document.getElementById("qaSection").classList.add("hidden");
  document.getElementById("insertScreenshotBtn").classList.remove("hidden");
  document.getElementById("saveDocBtn").classList.remove("hidden");
  document.getElementById("cancelEditBtn").classList.remove("hidden");
  document.getElementById("saveStatus").textContent = "";

  renderEditorPreview();
}

function cancelEditMode() {
  closeScreenshotPicker();
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

async function openScreenshotPicker() {
  if (!currentDoc || !currentDoc.session_id) {
    document.getElementById("saveStatus").textContent = "No session found for this document.";
    return;
  }

  const modal = document.getElementById("screenshotModal");
  const grid = document.getElementById("screenshotGrid");
  const status = document.getElementById("screenshotPickerStatus");

  modal.classList.remove("hidden");
  grid.innerHTML = "";
  status.textContent = "Loading screenshots...";

  try {
    const res = await fetch(
      `${backendBaseUrl}/sessions/screenshots?session_id=${encodeURIComponent(currentDoc.session_id)}`
    );
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.detail || data.error || "Could not load screenshots.");
    }

    screenshotItems = Array.isArray(data.items) ? data.items : [];
    selectedScreenshotId = screenshotItems.length ? screenshotItems[0].screenshot_id : null;

    if (!screenshotItems.length) {
      status.textContent = "No screenshots found for this session.";
      grid.innerHTML = "";
      return;
    }

    status.textContent = `Found ${screenshotItems.length} screenshot${screenshotItems.length === 1 ? "" : "s"}.`;
    renderScreenshotGrid();
  } catch (e) {
    status.textContent = e.message || "Could not load screenshots.";
    grid.innerHTML = "";
  }
}

function closeScreenshotPicker() {
  document.getElementById("screenshotModal").classList.add("hidden");
}

function renderScreenshotGrid() {
  const grid = document.getElementById("screenshotGrid");

  grid.innerHTML = screenshotItems.map((item) => {
    const isSelected = item.screenshot_id === selectedScreenshotId;
    const caption = item.caption ? escapeHtml(item.caption) : "Screenshot";
    const ts = formatTimestamp(item.created_at);

    return `
      <button
        type="button"
        class="shot-card${isSelected ? " selected" : ""}"
        data-screenshot-id="${escapeHtml(item.screenshot_id || "")}"
      >
        <img class="shot-thumb" src="${item.data_url}" alt="${caption}" />
        <div class="shot-meta">
          <div class="shot-time">${escapeHtml(ts)}</div>
          <div class="shot-caption">${caption}</div>
        </div>
      </button>
    `;
  }).join("");

  grid.querySelectorAll(".shot-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedScreenshotId = card.getAttribute("data-screenshot-id");
      renderScreenshotGrid();
    });
  });
}

function insertSelectedScreenshot() {
  const selected = screenshotItems.find((item) => item.screenshot_id === selectedScreenshotId);
  if (!selected) return;

  const bodyInput = document.getElementById("docBodyInput");
  const imageUrl = `${backendBaseUrl}/screenshots/${encodeURIComponent(selected.screenshot_id)}`;
  const markdown = `![Screenshot](${imageUrl})`;

  insertTextAtCursor(bodyInput, markdown);
  renderEditorPreview();
  closeScreenshotPicker();
  bodyInput.focus();
}

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const value = textarea.value;

  const before = value.slice(0, start);
  const after = value.slice(end);

  const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
  const needsTrailingNewline = after.length > 0 && !after.startsWith("\n");

  const insertValue =
    `${needsLeadingNewline ? "\n" : ""}${text}${needsTrailingNewline ? "\n" : ""}`;

  textarea.value = before + insertValue + after;

  const nextPos = before.length + insertValue.length;
  textarea.selectionStart = nextPos;
  textarea.selectionEnd = nextPos;
}

function resetQaSurface() {
  const status = document.getElementById("qaStatus");
  const wrap = document.getElementById("qaAnswerWrap");
  const body = document.getElementById("qaAnswerBody");
  const citations = document.getElementById("qaCitations");

  if (status) status.textContent = "";
  if (wrap) wrap.classList.add("hidden");
  if (body) body.innerHTML = "";
  if (citations) citations.innerHTML = "";
}

async function askDocumentQuestion() {
  if (currentMode !== "docs" || !currentDoc) return;

  const input = document.getElementById("qaQuestionInput");
  const status = document.getElementById("qaStatus");
  const wrap = document.getElementById("qaAnswerWrap");
  const badge = document.getElementById("qaSourceBadge");
  const note = document.getElementById("qaSourceNote");
  const citations = document.getElementById("qaCitations");

  const question = String(input.value || "").trim();
  if (!question) {
    status.textContent = "Enter a question first.";
    return;
  }

  status.textContent = "Searching the document and linked evidence...";
  wrap.classList.add("hidden");
  citations.innerHTML = "";

  try {
    const res = await fetch(`${backendBaseUrl}/docs/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        created_at: currentDoc.created_at,
        session_id: currentDoc.session_id || "",
        title: currentDoc.title || "",
        question
      })
    });

    const data = await res.json();

    if (!res.ok || !data.answer) {
      throw new Error(data.detail || data.error || "Could not answer that question.");
    }

    const answer = data.answer;
    status.textContent = answer.used_ai
      ? "Grounded answer ready."
      : "Grounded answer ready (heuristic fallback).";

    badge.textContent = answer.source_label || "Internal workflow";
    badge.className = `source-badge source-badge--${escapeHtml(answer.source_basis || "internal_capture")}`;
    note.textContent = answer.source_note || "";

    renderMarkdownIntoTarget("qaAnswerBody", String(answer.answer_markdown || ""));

    const citationHtml =
      Array.isArray(answer.citations) && answer.citations.length
        ? answer.citations
            .map(
              (citation) =>
                `<span class="qa-citation-pill">${escapeHtml(citation.label || citation.id || "Source")}</span>`
            )
            .join("")
        : `<span class="subtle">No citations were returned.</span>`;

    citations.innerHTML = citationHtml;
    wrap.classList.remove("hidden");
  } catch (e) {
    status.textContent = e.message || "Could not answer that question.";
  }
}

async function includeCurrentItemInProcess() {
  const status = document.getElementById("processIncludeStatus");
  status.textContent = "Including...";

  try {
    if (currentMode === "meetings" && currentMeeting?.meeting_id) {
      await sendRuntimeMessage({ type: "INCLUDE_MEETING_IN_PROCESS", payload: { meetingId: currentMeeting.meeting_id } });
      status.textContent = "Meeting included in the current process.";
      return;
    }

    if (currentDoc?.session_id) {
      await sendRuntimeMessage({
        type: "INCLUDE_SESSION_IN_PROCESS",
        payload: {
          sessionId: currentDoc.session_id,
          title: currentDoc.title || "",
          label: currentDoc.title || ""
        }
      });
      status.textContent = "Document session included in the current process.";
      return;
    }

    status.textContent = "Nothing to include for this item.";
  } catch (e) {
    status.textContent = e.message || "Could not include this item.";
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error("No response from background."));
      if (response.ok === false && response.error) return reject(new Error(response.error));
      resolve(response);
    });
  });
}

function openShareModal() {
  if (currentMode !== "docs" || !currentDoc) return;
  document.getElementById("shareStatus").textContent = "";
  document.getElementById("shareModal").classList.remove("hidden");
}

function closeShareModal() {
  document.getElementById("shareModal").classList.add("hidden");
}

function buildExportQuery() {
  const params = new URLSearchParams();
  if (currentDoc?.created_at) params.set("created_at", currentDoc.created_at);
  if (currentDoc?.session_id) params.set("session_id", currentDoc.session_id);
  if (currentDoc?.title) params.set("title", currentDoc.title);
  return params.toString();
}

function getFilenameFromResponse(response, fallback) {
  const disposition = response.headers.get("Content-Disposition") || "";
  const utfMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch && utfMatch[1]) {
    try {
      return decodeURIComponent(utfMatch[1]);
    } catch (_) {}
  }

  const plainMatch = disposition.match(/filename="([^"]+)"/i);
  if (plainMatch && plainMatch[1]) {
    return plainMatch[1];
  }

  return fallback;
}

async function downloadBlobResponse(url, fallbackName) {
  const status = document.getElementById("shareStatus");
  status.textContent = "Preparing download...";

  const res = await fetch(url);
  if (!res.ok) {
    let message = "Could not prepare the export.";
    try {
      const data = await res.json();
      message = data.detail || data.error || message;
    } catch (_) {}
    throw new Error(message);
  }

  const blob = await res.blob();
  const filename = getFilenameFromResponse(res, fallbackName);
  const objectUrl = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url: objectUrl,
    filename,
    saveAs: false
  });

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  status.textContent = "Download started.";
}

async function downloadDocumentExport(format) {
  if (!currentDoc) return;

  const query = buildExportQuery();
  const fallback = `${currentDoc.title || "Document"} - ${String(currentDoc.doc_type || "DOC").toUpperCase()}.${format}`;
  await downloadBlobResponse(`${backendBaseUrl}/docs/export/${format}?${query}`, fallback);
}

async function downloadEmailDraft(format) {
  if (!currentDoc) return;

  const query = buildExportQuery();
  const fallback = `${currentDoc.title || "Document"} - ${String(currentDoc.doc_type || "DOC").toUpperCase()} - Email Draft.eml`;
  await downloadBlobResponse(
    `${backendBaseUrl}/docs/export/email-draft?${query}&attachment_format=${encodeURIComponent(format)}`,
    fallback
  );
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

function formatTimestamp(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

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

function renderSourceBasis(item) {
  const wrap = document.getElementById("sourceBasisWrap");
  const badge = document.getElementById("sourceBasisBadge");
  const note = document.getElementById("sourceBasisNote");
  const meta = getSourceMeta(item);

  badge.textContent = meta.label;
  badge.className = `source-badge source-badge--${meta.basis}`;
  note.textContent = meta.note;
  wrap.classList.remove("hidden");
}

function hideSourceBasis() {
  const wrap = document.getElementById("sourceBasisWrap");
  if (wrap) wrap.classList.add("hidden");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function startGuidedRun() {
  const hasInternalFlow = !!(
    currentDoc?.session_id ||
    (Array.isArray(currentDoc?.source_session_ids) && currentDoc.source_session_ids.length)
  );

  if (!hasInternalFlow) {
    const status = document.getElementById("processIncludeStatus");
    status.textContent = "Guided Run is only available for internally captured workflows.";
    return;
  }
  if (currentMode !== "docs" || !currentDoc) return;

  const status = document.getElementById("processIncludeStatus");
  status.textContent = "Starting guided run...";

  try {
    const params = new URLSearchParams();
    if (currentDoc.created_at) params.set("created_at", currentDoc.created_at);
    if (currentDoc.session_id) params.set("session_id", currentDoc.session_id);
    if (currentDoc.title) params.set("title", currentDoc.title);

    const res = await fetch(`${backendBaseUrl}/docs/guide?${params.toString()}`);
    const data = await res.json();

    if (!res.ok || !data.guide) {
      throw new Error(data.detail || data.error || "Could not prepare the guided run.");
    }

    await sendRuntimeMessage({
      type: "START_GUIDED_RUN",
      payload: {
        guide: data.guide,
        documentRef: {
          created_at: currentDoc.created_at || "",
          session_id: currentDoc.session_id || "",
          title: currentDoc.title || ""
        }
      }
    });

    status.textContent = "Guided run opened in a new tab.";
  } catch (e) {
    status.textContent = e.message || "Could not start the guided run.";
  }
}