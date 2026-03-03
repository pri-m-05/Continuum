/*
  CONTINUUM BACKGROUND SERVICE WORKER

  WHAT THIS FILE DOES
  1. Receives captured browser actions from the content script
  2. Manages one workflow session per active tab/url context
  3. Flushes captured actions to the backend
  4. Captures screenshots
  5. Starts/stops meeting recording using an offscreen document
  6. Caches the latest doc result and latest meeting result
  7. Acts as the single message router for popup/content/offscreen

*/

const DEFAULT_SETTINGS = {
  backendBaseUrl: "http://127.0.0.1:8000",
  auditRules: {
    required_sections: [
      "Purpose",
      "Preconditions",
      "Procedure",
      "Controls",
      "Evidence"
    ],
    required_keywords: [],
    prohibited_words: []
  },
  captureInputValues: false
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await storageGet("sync", "continuum_settings");
  if (!existing.continuum_settings) {
    await storageSet("sync", { continuum_settings: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "CAPTURE_ACTION": {
          const result = await handleCapturedAction(sender, message.payload);
          sendResponse({ ok: true, ...result });
          return;
        }

        case "GET_SESSION_INFO": {
          const result = await getSessionInfo(message.payload.tabId);
          sendResponse(result);
          return;
        }

        case "SEARCH_DOCS": {
          const settings = await getSettings();
          const url = `${settings.backendBaseUrl}/docs/search?query=${encodeURIComponent(
            message.payload.query || ""
          )}`;
          const result = await fetchJson(url, { method: "GET" });
          sendResponse(result);
          return;
        }

        case "GENERATE_DOCS": {
          const result = await generateDocsForSession(message.payload.sessionId);
          sendResponse(result);
          return;
        }

        case "GET_LATEST_DOC": {
          const result = await getLatestDoc(message.payload.sessionId);
          sendResponse(result);
          return;
        }

        case "GET_AUTOMATION_SUGGESTIONS": {
          const result = await getAutomationSuggestions(message.payload.sessionId);
          sendResponse(result);
          return;
        }

        case "RUN_AUDIT": {
          const settings = await getSettings();
          const result = await fetchJson(`${settings.backendBaseUrl}/audit-check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: message.payload.content,
              rules: settings.auditRules
            })
          });
          sendResponse(result);
          return;
        }

        case "PING_BACKEND": {
          const settings = await getSettings();
          const result = await fetchJson(`${settings.backendBaseUrl}/health`, {
            method: "GET"
          });
          sendResponse(result);
          return;
        }

        case "CAPTURE_SCREENSHOT": {
          const result = await captureScreenshotForActiveTab();
          sendResponse(result);
          return;
        }

        case "START_MEETING_CAPTURE": {
          const result = await startMeetingCaptureForActiveTab();
          sendResponse(result);
          return;
        }

        case "STOP_MEETING_CAPTURE": {
          const result = await stopMeetingCapture();
          sendResponse(result);
          return;
        }

        case "GET_MEETING_STATUS": {
          const result = await getMeetingStatus();
          sendResponse(result);
          return;
        }

        case "GET_LATEST_MEETING": {
          const result = await getLatestMeeting(message.payload.sessionId);
          sendResponse(result);
          return;
        }

        case "OFFSCREEN_MEETING_COMPLETE": {
          await handleOffscreenMeetingComplete(message.payload);
          sendResponse({ ok: true });
          return;
        }

        case "OPEN_OPTIONS_PAGE": {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          return;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message type." });
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  })();

  return true;
});

async function handleCapturedAction(sender, action) {
  const senderTab = sender.tab;
  if (!senderTab || typeof senderTab.id !== "number") {
    throw new Error("Missing sender tab.");
  }

  const tabId = senderTab.id;
  const page = {
    url: senderTab.url || "",
    title: senderTab.title || ""
  };

  const sessionInfo = await getOrCreateSessionForTab(tabId, page.url);
  const sessionId = sessionInfo.sessionId;

  const buffers = (await storageGet("local", "continuum_buffers")).continuum_buffers || {};
  const existingBuffer = buffers[sessionId] || {
    sessionId,
    tabId,
    page,
    actions: []
  };

  existingBuffer.page = page;
  existingBuffer.actions.push({
    ...action,
    timestamp: action.timestamp || Date.now()
  });

  buffers[sessionId] = existingBuffer;
  await storageSet("local", { continuum_buffers: buffers });

  let flushed = false;
  let latestResult = null;

  if (existingBuffer.actions.length >= 5 || action.kind === "submit") {
    latestResult = await flushSession(sessionId);
    flushed = Boolean(latestResult);
  }

  return {
    sessionId,
    bufferedActionCount: existingBuffer.actions.length,
    flushed,
    latestResult
  };
}

async function getSessionInfo(tabId) {
  const mappings =
    (await storageGet("local", "continuum_tab_sessions")).continuum_tab_sessions || {};
  const mapping = mappings[String(tabId)];

  if (!mapping) {
    return {
      ok: true,
      sessionId: null,
      latestResult: null
    };
  }

  const lastResults =
    (await storageGet("local", "continuum_last_results")).continuum_last_results || {};

  return {
    ok: true,
    sessionId: mapping.sessionId,
    latestResult: lastResults[mapping.sessionId] || null
  };
}

async function generateDocsForSession(sessionId) {
  await flushSession(sessionId);

  const settings = await getSettings();
  const result = await fetchJson(`${settings.backendBaseUrl}/docs/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      rules: settings.auditRules
    })
  });

  await cacheLatestResult(sessionId, result);
  return result;
}

async function getLatestDoc(sessionId) {
  const settings = await getSettings();
  const url = `${settings.backendBaseUrl}/docs/latest?session_id=${encodeURIComponent(sessionId)}`;
  return await fetchJson(url, { method: "GET" });
}

async function getAutomationSuggestions(sessionId) {
  await flushSession(sessionId);

  const settings = await getSettings();
  return await fetchJson(`${settings.backendBaseUrl}/automate-step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId })
  });
}

async function flushSession(sessionId) {
  const settings = await getSettings();
  const buffers = (await storageGet("local", "continuum_buffers")).continuum_buffers || {};
  const buffer = buffers[sessionId];

  if (!buffer || !Array.isArray(buffer.actions) || buffer.actions.length === 0) {
    return null;
  }

  const result = await fetchJson(`${settings.backendBaseUrl}/ingest-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      page: buffer.page,
      actions: buffer.actions,
      rules: settings.auditRules
    })
  });

  buffer.actions = [];
  buffers[sessionId] = buffer;
  await storageSet("local", { continuum_buffers: buffers });
  await cacheLatestResult(sessionId, result);

  return result;
}

async function cacheLatestResult(sessionId, result) {
  const lastResults =
    (await storageGet("local", "continuum_last_results")).continuum_last_results || {};
  lastResults[sessionId] = result;
  await storageSet("local", { continuum_last_results: lastResults });
}

async function captureScreenshotForActiveTab() {
  /*
    WHAT THIS DOES
    1. Finds the active tab
    2. Finds that tab's current workflow session
    3. Captures a PNG screenshot of the visible area
    4. Sends that screenshot to the backend as evidence

    WHY
    Users want screenshots embedded as proof/evidence for the documented process.
  */
  const settings = await getSettings();
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") {
    throw new Error("No active tab found.");
  }

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  const result = await fetchJson(`${settings.backendBaseUrl}/sessions/screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionInfo.sessionId,
      page_url: tab.url || "",
      page_title: tab.title || "",
      data_url: dataUrl
    })
  });

  return {
    ok: true,
    sessionId: sessionInfo.sessionId,
    screenshot: result.screenshot
  };
}

async function startMeetingCaptureForActiveTab() {
  /*
    WHAT THIS DOES
    1. Finds the active tab and current session
    2. Creates an offscreen document if needed
    3. Gets a tab capture stream ID from the service worker
    4. Tells the offscreen document to start recording audio from the tab
    5. Caches meeting state locally

    WHY
    The service worker cannot use DOM APIs directly, so the actual MediaRecorder
    work has to happen in the offscreen document.
  */
  const currentState =
    (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {};

  if (currentState.status === "recording") {
    return {
      ok: true,
      status: "recording",
      sessionId: currentState.sessionId,
      message: "Meeting recording is already running."
    };
  }

  const settings = await getSettings();
  const tab = await getActiveTab();

  if (!tab || typeof tab.id !== "number") {
    throw new Error("No active tab found.");
  }

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");
  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id
  });

  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_START_RECORDING",
    payload: {
      streamId,
      sessionId: sessionInfo.sessionId,
      tabId: tab.id,
      backendBaseUrl: settings.backendBaseUrl,
      pageUrl: tab.url || "",
      pageTitle: tab.title || ""
    }
  });

  const nextState = {
    status: "recording",
    sessionId: sessionInfo.sessionId,
    tabId: tab.id,
    startedAt: Date.now()
  };

  await storageSet("local", { continuum_meeting_state: nextState });
  await chrome.action.setBadgeText({ text: "REC", tabId: tab.id });

  return {
    ok: true,
    ...nextState
  };
}

async function stopMeetingCapture() {
  /*
    WHAT THIS DOES
    1. Tells the offscreen document to stop MediaRecorder
    2. Updates local state to "saving"
    3. Waits for offscreen to upload and send completion message

    WHY
    Stopping the recording is only step one. The upload + transcript + notes
    run after the recorder finishes.
  */
  const currentState =
    (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {};

  if (currentState.status !== "recording") {
    return {
      ok: true,
      status: "idle",
      message: "No meeting recording is currently running."
    };
  }

  await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_RECORDING" });

  const nextState = {
    ...currentState,
    status: "saving"
  };

  await storageSet("local", { continuum_meeting_state: nextState });

  if (typeof currentState.tabId === "number") {
    await chrome.action.setBadgeText({ text: "...", tabId: currentState.tabId });
  }

  return {
    ok: true,
    ...nextState
  };
}

async function getMeetingStatus() {
  const state =
    (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {
      status: "idle"
    };

  return {
    ok: true,
    ...state
  };
}

async function getLatestMeeting(sessionId) {
  const localResults =
    (await storageGet("local", "continuum_latest_meetings")).continuum_latest_meetings || {};

  if (sessionId && localResults[sessionId]) {
    return { ok: true, meeting: localResults[sessionId] };
  }

  const settings = await getSettings();
  const url = `${settings.backendBaseUrl}/meetings/latest?session_id=${encodeURIComponent(
    sessionId || ""
  )}`;

  return await fetchJson(url, { method: "GET" });
}

async function handleOffscreenMeetingComplete(payload) {
  /*
    WHAT THIS DOES
    1. Receives the final saved meeting record from offscreen
    2. Stores it for quick popup access
    3. Clears the recording badge and resets state

    WHY
    This gives the popup a fast place to read the newest meeting result.
  */
  const latest =
    (await storageGet("local", "continuum_latest_meetings")).continuum_latest_meetings || {};

  if (payload && payload.meeting && payload.meeting.session_id) {
    latest[payload.meeting.session_id] = payload.meeting;
    await storageSet("local", { continuum_latest_meetings: latest });
  }

  const state =
    (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {};

  if (typeof state.tabId === "number") {
    await chrome.action.setBadgeText({ text: "", tabId: state.tabId });
  }

  await storageSet("local", {
    continuum_meeting_state: {
      status: "idle",
      sessionId: payload && payload.meeting ? payload.meeting.session_id : null,
      lastCompletedAt: Date.now()
    }
  });
}

async function ensureOffscreenDocument() {
  /*
    WHAT THIS DOES
    Ensures exactly one offscreen document exists before recording begins.

    WHY
    The offscreen document is where MediaRecorder / getUserMedia lives.
  */
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });

    const hasExisting = contexts.some((ctx) => ctx.documentUrl && ctx.documentUrl.includes("offscreen.html"));
    if (hasExisting) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Record meeting audio from the active tab for transcripts and notes."
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (!message.toLowerCase().includes("exists")) {
      throw error;
    }
  }
}

async function getOrCreateSessionForTab(tabId, currentUrl) {
  const key = String(tabId);
  const mappings =
    (await storageGet("local", "continuum_tab_sessions")).continuum_tab_sessions || {};

  const existing = mappings[key];
  if (existing && existing.url === currentUrl) {
    return existing;
  }

  const sessionId = createSessionId();
  const newMapping = { sessionId, url: currentUrl };
  mappings[key] = newMapping;
  await storageSet("local", { continuum_tab_sessions: mappings });
  return newMapping;
}

function createSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function getSettings() {
  const result = await storageGet("sync", "continuum_settings");
  return {
    ...DEFAULT_SETTINGS,
    ...(result.continuum_settings || {}),
    auditRules: {
      ...DEFAULT_SETTINGS.auditRules,
      ...((result.continuum_settings || {}).auditRules || {})
    }
  };
}

function fetchJson(url, options) {
  return fetch(url, options).then(async (response) => {
    const text = await response.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch (error) {
      data = { raw: text };
    }

    if (!response.ok) {
      throw new Error(data.detail || data.error || `Request failed: ${response.status}`);
    }

    return data;
  });
}

function storageGet(area, key) {
  return new Promise((resolve) => {
    chrome.storage[area].get(key, resolve);
  });
}

function storageSet(area, value) {
  return new Promise((resolve) => {
    chrome.storage[area].set(value, resolve);
  });
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs.length ? tabs[0] : null);
    });
  });
}