let backendBaseUrl = "http://127.0.0.1:8000";
let messageCounter = 0;
let activeSourceUrls = [];
let generatedDocumentRef = null;
let guideReady = false;

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  document.getElementById("askBtn").addEventListener("click", askExternalQuestion);
  document.getElementById("generateDraftBtn").addEventListener("click", generateExternalDraft);
  document.getElementById("openGeneratedGuideBtn").addEventListener("click", openGeneratedGuide);
});

async function loadSettings() {
  const res = await new Promise((resolve) => chrome.storage.sync.get("continuum_settings", resolve));
  const settings = res.continuum_settings || {};
  backendBaseUrl = settings.backendBaseUrl || backendBaseUrl;
}

function getManualSourceUrls() {
  return document.getElementById("urlsInput").value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getFormPayload() {
  return {
    topic: document.getElementById("topicInput").value.trim(),
    doc_type: document.getElementById("docTypeInput").value,
    audience: document.getElementById("audienceInput").value,
    notes: document.getElementById("notesInput").value.trim(),
    source_urls: getManualSourceUrls()
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

function setGuideReadyState(isReady) {
  guideReady = isReady;
  document.getElementById("questionInput").disabled = !isReady;
  document.getElementById("askBtn").disabled = !isReady;
}

function renderGeneratedGuideInfo(doc, sources) {
  generatedDocumentRef = doc
    ? {
        created_at: doc.created_at || "",
        title: doc.title || "",
        session_id: doc.session_id || ""
      }
    : null;

  const wrap = document.getElementById("generatedGuideWrap");
  const badge = document.getElementById("generatedGuideBadge");
  const status = document.getElementById("generatedGuideStatus");
  const sourcesBox = document.getElementById("generatedGuideSources");
  const openBtn = document.getElementById("openGeneratedGuideBtn");

  wrap.classList.remove("hidden");
  badge.textContent = "Trusted external";
  status.textContent = doc?.title
    ? `Generated and saved: ${doc.title}`
    : "Guide generated from trusted external sources.";
  sourcesBox.innerHTML = (sources || [])
    .map((source) => `<span class="citationPill">${escapeHtml(source.title || source.host || "Source")}</span>`)
    .join("");
  openBtn.classList.toggle("hidden", !generatedDocumentRef?.created_at || !generatedDocumentRef?.title);
}

async function askExternalQuestion() {
  const payload = getFormPayload();
  const questionInput = document.getElementById("questionInput");
  const status = document.getElementById("chatStatus");
  const question = questionInput.value.trim();

  if (!guideReady) {
    status.textContent = "Generate the guide first, then ask follow-up questions.";
    return;
  }

  if (!payload.topic) {
    status.textContent = "Enter what you need help with first.";
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
        source_urls: activeSourceUrls.length ? activeSourceUrls : payload.source_urls,
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

  status.textContent = payload.source_urls.length
    ? "Generating guide from trusted sources..."
    : "Finding trusted sources and generating guide...";

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

    activeSourceUrls = Array.isArray(data.sources) ? data.sources.map((source) => source.url).filter(Boolean) : [];
    if (activeSourceUrls.length) {
      document.getElementById("urlsInput").value = activeSourceUrls.join("\n");
    }

    renderGeneratedGuideInfo(data.primary_document, data.sources || []);
    appendAssistantMessage({
      source_label: "Trusted external",
      source_note: "Based on trusted public product documentation. Steps may vary by tenant, permissions, or rollout.",
      used_ai: true,
      answer_markdown: `Generated **${data.primary_document.title || payload.topic}** using trusted external sources. You can now ask follow-up questions about this guide.`,
      citations: Array.isArray(data.sources)
        ? data.sources.map((source) => ({ id: source.url, label: source.title || source.host || "Source" }))
        : []
    });

    setGuideReadyState(true);
    status.textContent = "Guide generated. You can now ask follow-up questions.";
  } catch (e) {
    status.textContent = e.message || "Could not generate the external document.";
  }
}

function openGeneratedGuide() {
  if (!generatedDocumentRef?.created_at || !generatedDocumentRef?.title) return;

  const params = new URLSearchParams();
  params.set("mode", "docs");
  params.set("created_at", generatedDocumentRef.created_at);
  params.set("title", generatedDocumentRef.title);

  const url = chrome.runtime.getURL(`detail.html?${params.toString()}`);
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