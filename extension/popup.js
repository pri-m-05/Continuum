/*
  POPUP UI

  WHAT THIS FILE DOES
  1. Shows backend connectivity
  2. Loads the current tab's workflow session
  3. Lets the user generate docs
  4. Lets the user search docs
  5. Lets the user capture screenshots
  6. Starts/stops tab-audio meeting capture
  7. Shows the latest meeting transcript + notes + actions

*/

let activeSessionId = null;

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await checkBackend();
  await loadCurrentSession();
  await refreshMeetingStatus();
  await loadLatestMeeting();
});

function bindEvents() {
  document.getElementById("searchBtn").addEventListener("click", handleSearch);
  document.getElementById("generateBtn").addEventListener("click", handleGenerateDocs);
  document.getElementById("automationBtn").addEventListener("click", handleAutomationIdeas);
  document.getElementById("screenshotBtn").addEventListener("click", handleCaptureScreenshot);
  document.getElementById("startMeetingBtn").addEventListener("click", handleStartMeeting);
  document.getElementById("stopMeetingBtn").addEventListener("click", handleStopMeeting);
  document.getElementById("settingsBtn").addEventListener("click", handleOpenSettings);
}

async function checkBackend() {
  const statusEl = document.getElementById("status");

  try {
    const result = await sendMessage({ type: "PING_BACKEND" });
    statusEl.textContent = result.ok ? "Backend connected." : "Backend responded unexpectedly.";
  } catch (error) {
    statusEl.textContent = `Backend error: ${error.message}`;
  }
}

async function loadCurrentSession() {
  const tabId = await getActiveTabId();

  if (tabId === null) {
    document.getElementById("sessionMeta").textContent = "Could not determine active tab.";
    return;
  }

  const info = await sendMessage({
    type: "GET_SESSION_INFO",
    payload: { tabId }
  });

  activeSessionId = info.sessionId || null;

  if (!activeSessionId) {
    document.getElementById("sessionMeta").textContent =
      "No session yet. Interact with the page first.";
    return;
  }

  document.getElementById("sessionMeta").textContent = `Session: ${activeSessionId}`;

  if (info.latestResult && info.latestResult.primary_document) {
    renderLatestDraft(info.latestResult);
  }
}

async function refreshMeetingStatus() {
  try {
    const result = await sendMessage({ type: "GET_MEETING_STATUS" });
    document.getElementById("meetingStatus").textContent =
      `Meeting status: ${result.status || "idle"}`;
  } catch (error) {
    document.getElementById("meetingStatus").textContent =
      `Meeting status error: ${error.message}`;
  }
}

async function handleSearch() {
  const query = document.getElementById("searchInput").value.trim();
  const container = document.getElementById("searchResults");

  if (!query) {
    container.innerHTML = "<p>Please enter a search term.</p>";
    return;
  }

  try {
    const result = await sendMessage({
      type: "SEARCH_DOCS",
      payload: { query }
    });

    const items = result.items || [];
    if (items.length === 0) {
      container.innerHTML = "<p>No documents found.</p>";
      return;
    }

    container.innerHTML = items
      .map(
        (item) => `
          <div class="resultItem">
            <strong>${escapeHtml(item.title || "Untitled")}</strong>
            <div>${escapeHtml(item.summary || "")}</div>
            <details>
              <summary>View content</summary>
              <pre>${escapeHtml(item.content || "")}</pre>
            </details>
          </div>
        `
      )
      .join("");
  } catch (error) {
    container.innerHTML = `<p>Error: ${escapeHtml(error.message)}</p>`;
  }
}

async function handleGenerateDocs() {
  const latestDraftEl = document.getElementById("latestDraft");

  if (!activeSessionId) {
    latestDraftEl.innerHTML = "<p>No active session found. Interact with the page first.</p>";
    return;
  }

  latestDraftEl.innerHTML = "<p>Generating...</p>";

  try {
    const result = await sendMessage({
      type: "GENERATE_DOCS",
      payload: { sessionId: activeSessionId }
    });

    renderLatestDraft(result);
  } catch (error) {
    latestDraftEl.innerHTML = `<p>Error: ${escapeHtml(error.message)}</p>`;
  }
}

async function handleAutomationIdeas() {
  const container = document.getElementById("automationResults");

  if (!activeSessionId) {
    container.innerHTML = "<p>No active session found yet.</p>";
    return;
  }

  container.innerHTML = "<p>Analyzing...</p>";

  try {
    const result = await sendMessage({
      type: "GET_AUTOMATION_SUGGESTIONS",
      payload: { sessionId: activeSessionId }
    });

    const suggestions = result.suggestions || [];
    if (suggestions.length === 0) {
      container.innerHTML = "<p>No automation suggestions yet.</p>";
      return;
    }

    container.innerHTML = suggestions
      .map(
        (item) => `
          <div class="resultItem">
            <strong>${escapeHtml(item.title)}</strong>
            <div>${escapeHtml(item.reason)}</div>
            <pre>${escapeHtml(item.example || "")}</pre>
          </div>
        `
      )
      .join("");
  } catch (error) {
    container.innerHTML = `<p>Error: ${escapeHtml(error.message)}</p>`;
  }
}

async function handleCaptureScreenshot() {
  const container = document.getElementById("latestScreenshot");

  if (!activeSessionId) {
    container.innerHTML = "<p>No active session found. Interact with the page first.</p>";
    return;
  }

  container.innerHTML = "<p>Capturing screenshot...</p>";

  try {
    const result = await sendMessage({ type: "CAPTURE_SCREENSHOT" });
    renderLatestScreenshot(result.screenshot);
  } catch (error) {
    container.innerHTML = `<p>Error: ${escapeHtml(error.message)}</p>`;
  }
}

async function handleStartMeeting() {
  const container = document.getElementById("latestMeeting");
  container.innerHTML = "<p>Starting meeting capture...</p>";

  try {
    const result = await sendMessage({ type: "START_MEETING_CAPTURE" });

    if (result.sessionId) {
      activeSessionId = result.sessionId;
      document.getElementById("sessionMeta").textContent = `Session: ${activeSessionId}`;
    }

    await refreshMeetingStatus();
    container.innerHTML = "<p>Meeting capture started. Join or continue the browser meeting tab, then click Stop Meeting when done.</p>";
  } catch (error) {
    container.innerHTML = `<p>Error: ${escapeHtml(error.message)}</p>`;
  }
}

async function handleStopMeeting() {
  const container = document.getElementById("latestMeeting");
  container.innerHTML = "<p>Stopping and saving meeting...</p>";

  try {
    await sendMessage({ type: "STOP_MEETING_CAPTURE" });
    await refreshMeetingStatus();

    
    setTimeout(async () => {
      await refreshMeetingStatus();
      await loadLatestMeeting();
    }, 3000);
  } catch (error) {
    container.innerHTML = `<p>Error: ${escapeHtml(error.message)}</p>`;
  }
}

async function loadLatestMeeting() {
  const container = document.getElementById("latestMeeting");

  if (!activeSessionId) {
    container.innerHTML = "<p>No active session yet.</p>";
    return;
  }

  try {
    const result = await sendMessage({
      type: "GET_LATEST_MEETING",
      payload: { sessionId: activeSessionId }
    });

    if (!result.meeting) {
      container.innerHTML = "<p>No meeting captured yet.</p>";
      return;
    }

    renderLatestMeeting(result.meeting);
  } catch (error) {
    container.innerHTML = `<p>Error: ${escapeHtml(error.message)}</p>`;
  }
}

function renderLatestDraft(result) {
  const latestDraftEl = document.getElementById("latestDraft");
  const primary = result.primary_document;
  const audit = result.audit || { passed: true, issues: [] };
  const options = result.options || [];

  if (!primary) {
    latestDraftEl.innerHTML = "<p>No document generated yet.</p>";
    return;
  }

  latestDraftEl.innerHTML = `
    <div class="resultItem">
      <strong>${escapeHtml(primary.title || "Untitled Draft")}</strong>
      <div>${escapeHtml(primary.summary || "")}</div>

      <details open>
        <summary>Primary document</summary>
        <pre>${escapeHtml(primary.content || "")}</pre>
      </details>

      <details>
        <summary>Audit result (${audit.passed ? "passed" : "issues found"})</summary>
        ${
          audit.issues && audit.issues.length
            ? `<ul>${audit.issues
                .map(
                  (issue) =>
                    `<li><strong>${escapeHtml(issue.severity)}</strong> - ${escapeHtml(issue.message)}</li>`
                )
                .join("")}</ul>`
            : "<p>No issues found.</p>"
        }
      </details>

      <details>
        <summary>Other generated options (${options.length})</summary>
        ${options
          .map(
            (option) => `
              <div class="optionBlock">
                <strong>${escapeHtml(option.title || "Untitled Option")}</strong>
                <div>${escapeHtml(option.summary || "")}</div>
                <pre>${escapeHtml(option.content || "")}</pre>
              </div>
            `
          )
          .join("")}
      </details>
    </div>
  `;
}

function renderLatestScreenshot(screenshot) {
  const container = document.getElementById("latestScreenshot");

  if (!screenshot || !screenshot.data_url) {
    container.innerHTML = "<p>No screenshot found.</p>";
    return;
  }

  container.innerHTML = `
    <div class="resultItem">
      <div><strong>Captured:</strong> ${escapeHtml(screenshot.created_at || "")}</div>
      <div><strong>Page:</strong> ${escapeHtml(screenshot.page_title || "")}</div>
      <img class="thumb" src="${screenshot.data_url}" alt="Captured screenshot" />
    </div>
  `;
}

function renderLatestMeeting(meeting) {
  const container = document.getElementById("latestMeeting");
  const notes = meeting.notes || {};
  const transcript = meeting.transcript || "";
  const summary = notes.summary || "No summary available.";
  const decisions = Array.isArray(notes.decisions) ? notes.decisions : [];
  const actionItems = Array.isArray(notes.action_items) ? notes.action_items : [];
  const followUp = Array.isArray(notes.follow_up_questions) ? notes.follow_up_questions : [];
  const warnings = Array.isArray(notes.warnings) ? notes.warnings : [];

  container.innerHTML = `
    <div class="resultItem">
      <strong>${escapeHtml(meeting.page_title || "Meeting capture")}</strong>
      <div><strong>Created:</strong> ${escapeHtml(meeting.created_at || "")}</div>
      <div><strong>Transcript length:</strong> ${escapeHtml(String(transcript.length))} chars</div>

      ${
        warnings.length
          ? `<div class="warningBox"><strong>Warnings</strong><ul>${warnings
              .map((item) => `<li>${escapeHtml(item)}</li>`)
              .join("")}</ul></div>`
          : ""
      }

      <details open>
        <summary>Summary</summary>
        <pre>${escapeHtml(summary)}</pre>
      </details>

      <details>
        <summary>Decisions (${decisions.length})</summary>
        ${
          decisions.length
            ? `<ul>${decisions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
            : "<p>No decisions extracted.</p>"
        }
      </details>

      <details>
        <summary>Action items (${actionItems.length})</summary>
        ${
          actionItems.length
            ? `<ul>${actionItems
                .map(
                  (item) =>
                    `<li><strong>${escapeHtml(item.owner || "Unassigned")}</strong>: ${escapeHtml(
                      item.task || ""
                    )}${item.due_date ? ` (Due: ${escapeHtml(item.due_date)})` : ""}</li>`
                )
                .join("")}</ul>`
            : "<p>No action items extracted.</p>"
        }
      </details>

      <details>
        <summary>Follow-up questions (${followUp.length})</summary>
        ${
          followUp.length
            ? `<ul>${followUp.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
            : "<p>No follow-up questions extracted.</p>"
        }
      </details>

      <details>
        <summary>Transcript</summary>
        <pre>${escapeHtml(transcript || "No transcript available.")}</pre>
      </details>
    </div>
  `;
}

async function handleOpenSettings() {
  try {
    await sendMessage({ type: "OPEN_OPTIONS_PAGE" });
  } catch (error) {
    alert(`Could not open settings: ${error.message}`);
  }
}

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs.length || typeof tabs[0].id !== "number") {
        resolve(null);
        return;
      }
      resolve(tabs[0].id);
    });
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response) {
        reject(new Error("No response from background."));
        return;
      }

      if (response.ok === false && response.error) {
        reject(new Error(response.error));
        return;
      }

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