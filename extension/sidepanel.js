let activeSessionId = null;
let meetingPollHandle = null;
let lastSeenMeetingCompletedAt = 0;

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("libraryBtn").addEventListener("click", () => sendMessage({ type: "OPEN_LIBRARY" }));
  document.getElementById("settingsBtn").addEventListener("click", () => sendMessage({ type: "OPEN_OPTIONS_PAGE" }));
  document.getElementById("saveIntentBtn").addEventListener("click", saveIntent);
  document.getElementById("generateBtn").addEventListener("click", generateDocs);
  document.getElementById("captureRecommendedBtn").addEventListener("click", () => captureScreenshot({ recommended: true }));
  document.getElementById("captureAnyBtn").addEventListener("click", () => captureScreenshot({ recommended: false }));

  document.getElementById("startMeetingBtn").addEventListener("click", startMeetingCapture);
  document.getElementById("stopMeetingBtn").addEventListener("click", stopMeetingCapture);
  document.getElementById("refreshMeetingBtn").addEventListener("click", async () => {
    await refreshMeetingStatus();
    await refreshMicStatus();
    await loadLatestMeeting();
  });

  document.getElementById("enableMicBtn").addEventListener("click", enableMicPermission);

  await pingBackend();
  await loadCurrentSession();
  await loadIntent();
  await refreshGuidance();

  await refreshMeetingStatus();
  await refreshMicStatus();
  await loadLatestMeeting();

  startMeetingPolling();
});

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
    document.getElementById("sessionInfo").innerHTML = `No session yet. Click around on the page to start one.`;
    return;
  }

  document.getElementById("sessionInfo").innerHTML = `<div><strong>Session:</strong> ${escapeHtml(activeSessionId)}</div>`;

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
  document.getElementById("processName").value = intent.process_name || "";
  document.getElementById("docType").value = intent.doc_type || "sop";
  document.getElementById("audience").value = intent.audience || "team";
  document.getElementById("intentNotes").value = intent.notes || "";
  document.getElementById("needScreenshots").checked = !!intent.evidence?.screenshots;
  document.getElementById("needMeeting").checked = !!intent.evidence?.meeting;
  document.getElementById("intentStatus").textContent = `Intent loaded (${intent.doc_type || "sop"}).`;
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
  status.textContent = `Intent saved.`;
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

  const evidence = await sendMessage({ type: "GET_EVIDENCE_SUMMARY", payload: { sessionId: activeSessionId } });
  const screenshotCount = evidence.summary?.screenshot_count || 0;

  const plan = buildScreenshotPlan(intent.doc_type);
  const nextIndex = Math.min(screenshotCount, plan.length - 1);

  list.innerHTML = plan.map((item, idx) => {
    const marker = idx === nextIndex ? `<span class="badge">next</span>` : "";
    const done = idx < screenshotCount ? `<span class="badge">done</span>` : "";
    return `<div class="item"><strong>${escapeHtml(item.title)}</strong> ${marker} ${done}<div class="subtle">${escapeHtml(item.why)}</div></div>`;
  }).join("");
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
      payload: { sessionId: activeSessionId, caption, recommended: !!recommended, step_index: screenshotCount }
    });

    status.textContent = `Saved: ${caption}`;
    if (res.screenshot?.data_url) {
      imgBox.innerHTML = `<img src="${res.screenshot.data_url}" alt="Screenshot" />`;
    }
    await refreshGuidance();
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  }
}

async function enableMicPermission() {
  const micStatus = document.getElementById("micStatus");
  try {
    micStatus.textContent = "Mic permission: opening permission tab...";
    const url = chrome.runtime.getURL("mic.html");
    await chrome.tabs.create({ url });
    setTimeout(refreshMicStatus, 800);
  } catch (e) {
    micStatus.textContent = `Mic permission: error (${e.message})`;
  }
}

async function refreshMicStatus() {
  const micStatus = document.getElementById("micStatus");
  const primed = await new Promise((resolve) => {
    chrome.storage.local.get("continuum_mic_primed", (res) => resolve(!!res.continuum_mic_primed));
  });
  micStatus.textContent = primed ? "Mic permission: granted ✅" : "Mic permission: not granted";
}

async function startMeetingCapture() {
  const box = document.getElementById("latestMeeting");
  box.innerHTML = `<div class="subtle">Starting meeting capture...</div>`;

  try {
    // MIC ALWAYS included
    await sendMessage({ type: "START_MEETING_CAPTURE", payload: { includeMic: true } });
    await refreshMeetingStatus();
    startMeetingPolling();
  } catch (e) {
    box.innerHTML = `<div class="subtle">Error: ${escapeHtml(e.message)}</div>`;
  }
}

async function stopMeetingCapture() {
  const box = document.getElementById("latestMeeting");
  box.innerHTML = `<div class="subtle">Stopping... waiting for upload/transcript...</div>`;

  try {
    await sendMessage({ type: "STOP_MEETING_CAPTURE" });
    await refreshMeetingStatus();
    startMeetingPolling();
  } catch (e) {
    box.innerHTML = `<div class="subtle">Error: ${escapeHtml(e.message)}</div>`;
  }
}

async function refreshMeetingStatus() {
  try {
    const res = await sendMessage({ type: "GET_MEETING_STATUS" });
    let text = `Status: ${res.status || "idle"}`;
    if (res.lastError) text += ` • ${res.lastError}`;
    document.getElementById("meetingStatus").textContent = text;
    return res;
  } catch (e) {
    document.getElementById("meetingStatus").textContent = `Status error: ${e.message}`;
    return { status: "error", lastError: e.message };
  }
}

function startMeetingPolling() {
  if (meetingPollHandle) clearInterval(meetingPollHandle);

  meetingPollHandle = setInterval(async () => {
    const st = await refreshMeetingStatus();

    const completedAt = st.lastCompletedAt || 0;
    if (st.status === "idle" && completedAt && completedAt !== lastSeenMeetingCompletedAt) {
      lastSeenMeetingCompletedAt = completedAt;
      await loadLatestMeeting();
      clearInterval(meetingPollHandle);
      meetingPollHandle = null;
      return;
    }

    if (st.status === "error") {
      await loadLatestMeeting();
      clearInterval(meetingPollHandle);
      meetingPollHandle = null;
      return;
    }
  }, 1500);
}

async function loadLatestMeeting() {
  const box = document.getElementById("latestMeeting");

  let sessionForMeeting = activeSessionId || "";
  try {
    const st = await sendMessage({ type: "GET_MEETING_STATUS" });
    if (st.sessionId) sessionForMeeting = st.sessionId;
  } catch (_) {}

  try {
    const res = await sendMessage({ type: "GET_LATEST_MEETING", payload: { sessionId: sessionForMeeting } });
    const meeting = res.meeting;

    if (!meeting) {
      box.innerHTML = `<div class="subtle">No meeting captured yet.</div>`;
      return;
    }

    const notes = meeting.notes || {};
    const minutes = cleanMinutesMarkdown(notes.minutes_markdown || notes.summary || "No minutes.");
    const transcript = String(meeting.transcript || "").trim();
    const warnings = Array.isArray(notes.warnings) ? notes.warnings : [];

    box.innerHTML = `
      <div class="item meeting-view">
        <div class="meeting-meta">
          <strong>${escapeHtml(meeting.page_title || "Meeting")}</strong>
          <div class="subtle">${escapeHtml(meeting.created_at || "")}</div>
        </div>

        <section>
          <div class="meeting-section-title">Minutes</div>
          <div id="preview" class="meeting-surface"></div>
        </section>

        <section>
          <div class="meeting-section-title">Transcript</div>
          <div class="meeting-surface transcript-box">${escapeHtml(transcript || "No transcript yet.")}</div>
        </section>

        ${warnings.length ? `<div class="meeting-warnings"><strong>Warnings:</strong> ${escapeHtml(warnings.join(" | "))}</div>` : ""}
      </div>
    `;
    const openLatestMeetingLink = document.getElementById("openLatestMeetingLink");
    if (openLatestMeetingLink) {
    openLatestMeetingLink.addEventListener("click", async (e) => {
        e.preventDefault();
        await openItemInLibrary({
        mode: "meetings",
        meetingId: meeting.meeting_id || "",
        sessionId: meeting.session_id || "",
        createdAt: meeting.created_at || "",
        title: meeting.page_title || ""
        });
    });
    }

    if (typeof window.renderMarkdownPreview === "function") {
      window.renderMarkdownPreview(minutes);
    } else {
      document.getElementById("preview").innerHTML = `<pre>${escapeHtml(minutes)}</pre>`;
    }
  } catch (e) {
    box.innerHTML = `<div class="subtle">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function cleanMinutesMarkdown(value) {
  let text = String(value || "").trim();

  text = text.replace(/^#\s+Meeting Minutes[^\n]*\n+/i, "");
  text = text.replace(/\.\s+-\s+/g, ".\n- ");
  text = text.replace(/:\s+-\s+/g, ":\n- ");

  return text;
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
      <div>
        <a href="#" id="openLatestDocLink"><strong>${escapeHtml(primary.title || "Draft")}</strong></a>
      </div>
      <div class="subtle">${escapeHtml(primary.summary || "")}</div>
      <pre>${escapeHtml(primary.content || "")}</pre>
    </div>
  `;

  const openLatestDocLink = document.getElementById("openLatestDocLink");
  if (openLatestDocLink) {
    openLatestDocLink.addEventListener("click", async (e) => {
      e.preventDefault();
      await openItemInLibrary({
        mode: "docs",
        sessionId: primary.session_id || activeSessionId || "",
        createdAt: primary.created_at || "",
        title: primary.title || ""
      });
    });
  }
}

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs.length || typeof tabs[0].id !== "number") return resolve(null);
      resolve(tabs[0].id);
    });
  });
}

function openItemInLibrary(payload) {
  return sendMessage({ type: "OPEN_LIBRARY", payload });
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
