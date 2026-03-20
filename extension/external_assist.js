let backendBaseUrl = "http://127.0.0.1:8000";
let messageCounter = 0;

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  document.getElementById("askBtn").addEventListener("click", askExternalQuestion);
  document.getElementById("generateDraftBtn").addEventListener("click", generateExternalDraft);
});

async function loadSettings() {
  const res = await new Promise((resolve) => chrome.storage.sync.get("continuum_settings", resolve));
  const settings = res.continuum_settings || {};
  backendBaseUrl = settings.backendBaseUrl || backendBaseUrl;
}

function getFormPayload() {
  return {
    topic: document.getElementById("topicInput").value.trim(),
    doc_type: document.getElementById("docTypeInput").value,
    audience: document.getElementById("audienceInput").value,
    notes: document.getElementById("notesInput").value.trim(),
    source_urls: document.getElementById("urlsInput").value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  };
}

function appendUserMessage(text) {
  const log = document.getElementById("chatLog");
  clearEmptyState();

  const node = document.createElement("div");
  node.className = "msg msg--user";
  node.innerHTML = `
    <div class="msgMeta"><strong>You</strong></div>
    <div class="msgBubble">${escapeHtml(text)}</div>
  `;
  log.appendChild(node);
  log.scrollTop = log.scrollHeight;
}

function appendAssistantMessage(answer) {
  const log = document.getElementById("chatLog");
  clearEmptyState();

  const messageId = `assistantMessage_${++messageCounter}`;
  const citations = Array.isArray(answer.citations)
    ? answer.citations
        .map((citation) => `<span class="citationPill">${escapeHtml(citation.label || citation.id || "Source")}</span>`)
        .join("")
    : "";

  const node = document.createElement("div");
  node.className = "msg msg--assistant";
  node.innerHTML = `
    <div class="msgMeta">
      <strong>Continuum</strong>
      <span class="sourceBadge">${escapeHtml(answer.source_label || "Trusted external")}</span>
      <span class="subtle">${escapeHtml(answer.used_ai ? "AI-grounded" : "Heuristic fallback")}</span>
    </div>
    <div class="msgBubble">
      <div class="subtle">${escapeHtml(answer.source_note || "")}</div>
      <div id="${messageId}" class="md-render-slot"></div>
      <div class="citations">${citations}</div>
    </div>
  `;
  log.appendChild(node);

  if (typeof window.renderMarkdownInto === "function") {
    window.renderMarkdownInto(messageId, String(answer.answer_markdown || ""));
  } else {
    document.getElementById(messageId).innerHTML = `<pre>${escapeHtml(answer.answer_markdown || "")}</pre>`;
  }

  log.scrollTop = log.scrollHeight;
}

function clearEmptyState() {
  const empty = document.querySelector(".emptyState");
  if (empty) empty.remove();
}

async function askExternalQuestion() {
  const payload = getFormPayload();
  const questionInput = document.getElementById("questionInput");
  const status = document.getElementById("chatStatus");
  const question = questionInput.value.trim();

  if (!payload.topic) {
    status.textContent = "Enter what you need help with first.";
    return;
  }

  if (!payload.source_urls.length) {
    status.textContent = "Paste at least one trusted source URL first.";
    return;
  }

  if (!question) {
    status.textContent = "Enter a question first.";
    return;
  }

  appendUserMessage(question);
  status.textContent = "Searching trusted sources...";

  try {
    const res = await fetch(`${backendBaseUrl}/external/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...payload,
        question
      })
    });

    const data = await res.json();

    if (!res.ok || !data.answer) {
      throw new Error(data.detail || data.error || "Could not answer that question.");
    }

    appendAssistantMessage(data.answer);
    questionInput.value = "";
    status.textContent = "Answer ready.";
  } catch (e) {
    status.textContent = e.message || "Could not answer that question.";
  }
}

async function generateExternalDraft() {
  const payload = getFormPayload();
  const status = document.getElementById("setupStatus");

  if (!payload.topic) {
    status.textContent = "Enter what you need help with first.";
    return;
  }

  if (!payload.source_urls.length) {
    status.textContent = "Paste at least one trusted source URL first.";
    return;
  }

  status.textContent = "Generating trusted-external draft...";

  try {
    const res = await fetch(`${backendBaseUrl}/docs/generate-external`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok || !data.primary_document) {
      throw new Error(data.detail || data.error || "Could not generate the external document.");
    }

    const doc = data.primary_document;
    const params = new URLSearchParams();
    params.set("mode", "docs");
    if (doc.created_at) params.set("created_at", doc.created_at);
    if (doc.title) params.set("title", doc.title);

    const url = chrome.runtime.getURL(`detail.html?${params.toString()}`);
    chrome.tabs.create({ url });

    status.textContent = "Draft generated and opened in a new tab.";
  } catch (e) {
    status.textContent = e.message || "Could not generate the external document.";
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}