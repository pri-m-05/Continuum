let activeSessionId = null;
let settingsCache = null;

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("libraryBtn").addEventListener("click", () => sendMessage({ type: "OPEN_LIBRARY" }));
  document.getElementById("settingsBtn").addEventListener("click", () => sendMessage({ type: "OPEN_OPTIONS_PAGE" }));

  document.getElementById("saveIntentBtn").addEventListener("click", saveIntent);
  document.getElementById("generateBtn").addEventListener("click", generateDocs);

  document.getElementById("captureRecommendedBtn").addEventListener("click", () => captureScreenshot({ recommended: true }));
  document.getElementById("captureAnyBtn").addEventListener("click", () => captureScreenshot({ recommended: false }));

  document.getElementById("startMeetingBtn").addEventListener("click", () => sendMessage({ type: "START_MEETING_CAPTURE" }).then(refreshMeetingStatus));
  document.getElementById("stopMeetingBtn").addEventListener("click", () => sendMessage({ type: "STOP_MEETING_CAPTURE" }).then(refreshMeetingStatus));
  document.getElementById("refreshMeetingBtn").addEventListener("click", async () => {
    await refreshMeetingStatus();
    await loadLatestMeeting();
  });

  await loadSettings();
  await pingBackend();
  await loadCurrentSession();
  await loadIntent();
  await refreshGuidance();
  await refreshMeetingStatus();
  await loadLatestMeeting();
});

async function loadSettings() {
  const res = await new Promise((resolve) => chrome.storage.sync.get("continuum_settings", resolve));
  settingsCache = res.continuum_settings || null;
}

async function pingBackend() {
  const el = document.getElementById("backendStatus");
  try {
    const r = await sendMessage({ type: "PING_BACKEND" });
    el.textContent = r.ok ? "Backend: connected" : "Backend: unexpected response";
  } catch (e) {
    el.textContent = `Backend: error (${e.message})`;
  }
}

async function loadCurrentSession() {
  const tabId = await getActiveTabId();
  if (tabId === null) {
    document.getElementById("sessionInfo").textContent = "Could not determine active tab.";
    return;
  }

  const info = await sendMessage({ type: "GET_SESSION_INFO", payload: { tabId } });
  activeSessionId = info.sessionId || null;

  if (!activeSessionId) {
    document.getElementById("sessionInfo").innerHTML =
      `No session yet. Click around on the page to start one.`;
    return;
  }

  document.getElementById("sessionInfo").innerHTML =
    `<div><strong>Session:</strong> ${escapeHtml(activeSessionId)}</div>`;

  if (info.latestResult && info.latestResult.primary_document) {
    renderDraft(info.latestResult);
  }
}

async function loadIntent() {
  if (!activeSessionId) return;

  const res = await sendMessage({ type: "GET_CAPTURE_INTENT", payload: { sessionId: activeSessionId } });
  const intent = res.intent || null;

  if (!intent) {
    document.getElementById("intentStatus").textContent = "Intent not set yet. Fill the form and click Save Intent.";
    return;
  }

  // Hydrate UI
  document.getElementById("processName").value = intent.process_name || "";
  document.getElementById("docType").value = intent.doc_type || "sop";
  document.getElementById("audience").value = intent.audience || "team";
  document.getElementById("intentNotes").value = intent.notes || "";
  document.getElementById("needScreenshots").checked = !!intent.evidence?.screenshots;
  document.getElementById("needMeeting").checked = !!intent.evidence?.meeting;

  document.getElementById("intentStatus").textContent = "Intent loaded.";
}

async function saveIntent() {
  const status = document.getElementById("intentStatus");

  if (!activeSessionId) {
    status.textContent = "No active session yet. Interact with the page first.";
    return;
  }

  const intent = {
    process_name: document.getElementById("processName").value.trim(),
    doc_type: document.getElementById("docType").value,
    audience: document.getElementById("audience").value,
    notes: document.getElementById("intentNotes").value.trim(),
    evidence: {
      screenshots: document.getElementById("needScreenshots").checked,
      meeting: document.getElementById("needMeeting").checked
    }
  };

  if (!intent.process_name) {
    status.textContent = "Please enter a process name (what you're documenting).";
    return;
  }

  await sendMessage({ type: "SET_CAPTURE_INTENT", payload: { sessionId: activeSessionId, intent } });
  status.textContent = "Intent saved. You can now generate docs.";
  await refreshGuidance();
}

async function generateDocs() {
  const box = document.getElementById("latestDraft");
  box.textContent = "Generating...";

  if (!activeSessionId) {
    box.textContent = "No session yet.";
    return;
  }

  try {
    const res = await sendMessage({ type: "GENERATE_DOCS", payload: { sessionId: activeSessionId } });
    renderDraft(res);
  } catch (e) {
    box.textContent = `Error: ${e.message}`;
  }
}

async function refreshGuidance() {
  if (!activeSessionId) return;

  const res = await sendMessage({ type: "GET_CAPTURE_INTENT", payload: { sessionId: activeSessionId } });
  const intent = res.intent || null;

  const list = document.getElementById("guidanceList");
  if (!intent) {
    list.innerHTML = `<div class="subtle">Set intent to get guided screenshots.</div>`;
    return;
  }

  // Ask backend for evidence counts (so guidance can advance)
  const evidence = await sendMessage({ type: "GET_EVIDENCE_SUMMARY", payload: { sessionId: activeSessionId } });
  const screenshotCount = evidence.summary?.screenshot_count || 0;

  const plan = buildScreenshotPlan(intent.doc_type);
  const nextIndex = Math.min(screenshotCount, plan.length - 1);

  list.innerHTML = plan
    .map((item, idx) => {
      const marker = idx === nextIndex ? `<span class="badge">next</span>` : "";
      const done = idx < screenshotCount ? `<span class="badge">done</span>` : "";
      return `<div class="item"><strong>${escapeHtml(item.title)}</strong> ${marker} ${done}<div class="subtle">${escapeHtml(item.why)}</div></div>`;
    })
    .join("");
}

function buildScreenshotPlan(docType) {
  if (docType === "audit") {
    return [
      { title: "Start state", why: "Evidence you began in the correct location." },
      { title: "Key inputs filled", why: "Shows what was entered before submission." },
      { title: "Approval / control screen", why: "Shows control points (approvals/checks)." },
      { title: "Confirmation/result", why: "Proof of completion (ID, banner, status)." }
    ];
  }
  if (docType === "meeting") {
    return [
      { title: "Meeting context screen", why: "Shows meeting title/date/context." },
      { title: "Key decision slide/page", why: "Supports decisions and action items." }
    ];
  }
  return [
    { title: "Start screen", why: "Where the process begins." },
    { title: "Critical form state", why: "The most error-prone inputs." },
    { title: "Before submit", why: "Evidence of review before committing." },
    { title: "Confirmation/result", why: "Proof the process completed successfully." }
  ];
}

async function captureScreenshot({ recommended }) {
  const status = document.getElementById("screenshotStatus");
  const imgBox = document.getElementById("latestScreenshot");

  if (!activeSessionId) {
    status.textContent = "No session yet.";
    return;
  }

  // Determine caption
  const intentRes = await sendMessage({ type: "GET_CAPTURE_INTENT", payload: { sessionId: activeSessionId } });
  const intent = intentRes.intent;

  if (!intent) {
    status.textContent = "Set intent first so screenshots are labeled correctly.";
    return;
  }

  const evidence = await sendMessage({ type: "GET_EVIDENCE_SUMMARY", payload: { sessionId: activeSessionId } });
  const screenshotCount = evidence.summary?.screenshot_count || 0;
  const plan = buildScreenshotPlan(intent.doc_type);
  const nextIndex = Math.min(screenshotCount, plan.length - 1);
  const caption = recommended ? plan[nextIndex].title : "Manual screenshot";

  status.textContent = "Capturing...";
  imgBox.innerHTML = "";

  try {
    const res = await sendMessage({
      type: "CAPTURE_SCREENSHOT",
      payload: {
        sessionId: activeSessionId,
        caption,
        recommended: !!recommended,
        step_index: screenshotCount
      }
    });

    status.textContent = "Saved.";
    if (res.screenshot?.data_url) {
      imgBox.innerHTML = `<img src="${res.screenshot.data_url}" alt="Screenshot" />`;
    }
    await refreshGuidance();
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  }
}

async function refreshMeetingStatus() {
  try {
    const res = await sendMessage({ type: "GET_MEETING_STATUS" });
    document.getElementById("meetingStatus").textContent = `Status: ${res.status || "idle"}`;
  } catch (e) {
    document.getElementById("meetingStatus").textContent = `Status error: ${e.message}`;
  }
}

async function loadLatestMeeting() {
  const box = document.getElementById("latestMeeting");
  if (!activeSessionId) {
    box.innerHTML = `<div class="subtle">No session yet.</div>`;
    return;
  }

  try {
    const res = await sendMessage({ type: "GET_LATEST_MEETING", payload: { sessionId: activeSessionId } });
    const meeting = res.meeting;
    if (!meeting) {
      box.innerHTML = `<div class="subtle">No meeting captured yet.</div>`;
      return;
    }
    const notes = meeting.notes || {};
    box.innerHTML = `
      <div class="item">
        <strong>${escapeHtml(meeting.page_title || "Meeting")}</strong>
        <div class="subtle">${escapeHtml(meeting.created_at || "")}</div>
        <pre>${escapeHtml(notes.summary || "No summary.")}</pre>
      </div>
    `;
  } catch (e) {
    box.innerHTML = `<div class="subtle">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderDraft(result) {
  const box = document.getElementById("latestDraft");
  const primary = result.primary_document;
  if (!primary) {
    box.textContent = "No draft yet.";
    return;
  }
  box.innerHTML = `
    <div class="item">
      <strong>${escapeHtml(primary.title || "Draft")}</strong>
      <div class="subtle">${escapeHtml(primary.summary || "")}</div>
      <pre>${escapeHtml(primary.content || "")}</pre>
    </div>
  `;
}

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs.length || typeof tabs[0].id !== "number") return resolve(null);
      resolve(tabs[0].id);
    });
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error("No response from background."));
      if (response.ok === false && response.error) return reject(new Error(response.error));
      resolve(response);
    });
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}