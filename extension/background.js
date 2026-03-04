const DEFAULT_SETTINGS = {
  backendBaseUrl: "http://127.0.0.1:8000",
  auditRules: {
    required_sections: ["Purpose", "Preconditions", "Procedure", "Controls", "Evidence"],
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

  await storageSet("local", {
    continuum_offscreen_ready: false
  });
});

chrome.runtime.onStartup?.addListener(async () => {
  // Also reset on browser startup to avoid stale state.
  await storageSet("local", {
    continuum_offscreen_ready: false
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "OFFSCREEN_READY") {
        await storageSet("local", { continuum_offscreen_ready: true });
        sendResponse({ ok: true });
        return;
      }

      switch (message.type) {
        case "OPEN_WORKSPACE": {
          const tab = await getActiveTab();
          if (!tab || typeof tab.windowId !== "number") {
            throw new Error("No active Chrome window was found.");
          }

          if (!chrome.sidePanel || !chrome.sidePanel.open) {
            throw new Error("Side Panel API is not available in this Chrome build.");
          }

          await chrome.sidePanel.setOptions({
            path: "sidepanel.html",
            enabled: true
          });

          await chrome.sidePanel.open({
            windowId: tab.windowId
          });

          sendResponse({ ok: true });
          return;
        }

        case "OPEN_LIBRARY": {
          await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
          sendResponse({ ok: true });
          return;
        }

        case "OPEN_OPTIONS_PAGE": {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          return;
        }

        case "PING_BACKEND": {
          const s = await getSettings();
          try {
            const r = await fetchJson(`${s.backendBaseUrl}/health`, { method: "GET" });
            sendResponse(r);
          } catch (error) {
            sendResponse({
              ok: false,
              error: `Could not reach backend at ${s.backendBaseUrl}. Is uvicorn running?`
            });
          }
          return;
        }

        case "CAPTURE_ACTION": {
          const r = await handleCapturedAction(sender, message.payload);
          sendResponse({ ok: true, ...r });
          return;
        }

        case "GET_SESSION_INFO": {
          const r = await getSessionInfo(message.payload.tabId);
          sendResponse(r);
          return;
        }

        case "SET_CAPTURE_INTENT": {
          await setCaptureIntent(message.payload.sessionId, message.payload.intent);
          sendResponse({ ok: true });
          return;
        }

        case "GET_CAPTURE_INTENT": {
          const intent = await getCaptureIntent(message.payload.sessionId);
          sendResponse({ ok: true, intent });
          return;
        }

        case "GET_EVIDENCE_SUMMARY": {
          const s = await getSettings();
          const summary = await fetchJson(
            `${s.backendBaseUrl}/sessions/evidence-summary?session_id=${encodeURIComponent(
              message.payload.sessionId
            )}`,
            { method: "GET" }
          );
          sendResponse({ ok: true, summary: summary.summary });
          return;
        }

        case "CAPTURE_SCREENSHOT": {
          const r = await captureScreenshotForActiveTab(message.payload);
          sendResponse(r);
          return;
        }

        case "GENERATE_DOCS": {
          const r = await generateDocsForSession(message.payload.sessionId);
          sendResponse(r);
          return;
        }

        case "GET_LATEST_MEETING": {
          const r = await getLatestMeeting(message.payload.sessionId);
          sendResponse(r);
          return;
        }

        case "GET_MEETING_STATUS": {
          const r = await getMeetingStatus();
          sendResponse(r);
          return;
        }

        case "START_MEETING_CAPTURE": {
          const r = await startMeetingCaptureForActiveTab();
          sendResponse(r);
          return;
        }

        case "STOP_MEETING_CAPTURE": {
          const r = await stopMeetingCapture();
          sendResponse(r);
          return;
        }

        case "OFFSCREEN_MEETING_COMPLETE": {
          await handleOffscreenMeetingComplete(message.payload);
          sendResponse({ ok: true });
          return;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message type." });
          return;
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message ? e.message : String(e) });
    }
  })();

  return true;
});

async function handleCapturedAction(sender, action) {
  const tab = sender.tab;
  if (!tab?.id) throw new Error("Missing sender tab.");

  const tabId = tab.id;
  const page = { url: tab.url || "", title: tab.title || "" };

  const sessionInfo = await getOrCreateSessionForTab(tabId, page.url);
  const sessionId = sessionInfo.sessionId;

  const buffers = (await storageGet("local", "continuum_buffers")).continuum_buffers || {};
  const existing = buffers[sessionId] || { sessionId, tabId, page, actions: [] };

  existing.page = page;
  existing.actions.push({ ...action, timestamp: action.timestamp || Date.now() });

  buffers[sessionId] = existing;
  await storageSet("local", { continuum_buffers: buffers });

  if (existing.actions.length >= 6 || action.kind === "submit") {
    await flushSession(sessionId);
  }

  return { sessionId };
}

async function getSessionInfo(tabId) {
  const mappings =
    (await storageGet("local", "continuum_tab_sessions")).continuum_tab_sessions || {};
  const mapping = mappings[String(tabId)];
  if (!mapping) return { ok: true, sessionId: null, latestResult: null };

  const lastResults =
    (await storageGet("local", "continuum_last_results")).continuum_last_results || {};
  return {
    ok: true,
    sessionId: mapping.sessionId,
    latestResult: lastResults[mapping.sessionId] || null
  };
}

async function flushSession(sessionId) {
  const s = await getSettings();
  const buffers = (await storageGet("local", "continuum_buffers")).continuum_buffers || {};
  const buffer = buffers[sessionId];

  if (!buffer?.actions?.length) return null;

  const intent = await getCaptureIntent(sessionId);

  const result = await fetchJson(`${s.backendBaseUrl}/ingest-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      page: buffer.page,
      actions: buffer.actions,
      rules: s.auditRules,
      intent: intent || null
    })
  });

  buffer.actions = [];
  buffers[sessionId] = buffer;
  await storageSet("local", { continuum_buffers: buffers });

  const lastResults =
    (await storageGet("local", "continuum_last_results")).continuum_last_results || {};
  lastResults[sessionId] = result;
  await storageSet("local", { continuum_last_results: lastResults });

  return result;
}

async function generateDocsForSession(sessionId) {
  const intent = await getCaptureIntent(sessionId);
  if (!intent?.process_name) {
    throw new Error("Set intent first in the Side Panel before generating docs.");
  }

  await flushSession(sessionId);

  const s = await getSettings();
  const result = await fetchJson(`${s.backendBaseUrl}/docs/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, rules: s.auditRules, intent })
  });

  const lastResults =
    (await storageGet("local", "continuum_last_results")).continuum_last_results || {};
  lastResults[sessionId] = result;
  await storageSet("local", { continuum_last_results: lastResults });

  return result;
}

async function captureScreenshotForActiveTab(payload) {
  const s = await getSettings();
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");
  const sessionId = payload?.sessionId || sessionInfo.sessionId;

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  const result = await fetchJson(`${s.backendBaseUrl}/sessions/screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      page_url: tab.url || "",
      page_title: tab.title || "",
      data_url: dataUrl,
      caption: payload?.caption || "",
      recommended: !!payload?.recommended,
      step_index: Number.isFinite(payload?.step_index) ? payload.step_index : 0
    })
  });

  return { ok: true, screenshot: result.screenshot, sessionId };
}

async function setCaptureIntent(sessionId, intent) {
  const all = (await storageGet("local", "continuum_intents")).continuum_intents || {};
  all[sessionId] = intent;
  await storageSet("local", { continuum_intents: all });
}

async function getCaptureIntent(sessionId) {
  const all = (await storageGet("local", "continuum_intents")).continuum_intents || {};
  return all[sessionId] || null;
}

async function ensureOffscreenDocument() {
  /*
    WHAT THIS FIXES
    1. Detects whether a real offscreen document actually exists
    2. Recreates it if the stored ready flag is stale
    3. Waits until OFFSCREEN_READY is received
    4. Verifies the offscreen doc can actually answer messages

  */

  const hasWorkingOffscreen = await pingOffscreen();
  if (hasWorkingOffscreen) {
    return;
  }

  await storageSet("local", { continuum_offscreen_ready: false });

  
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });

    const hasOffscreenContext = contexts.some(
      (ctx) => ctx.documentUrl && ctx.documentUrl.includes("offscreen.html")
    );

    // If one exists but isn't responding, try closing it first.
    if (hasOffscreenContext && chrome.offscreen?.closeDocument) {
      try {
        await chrome.offscreen.closeDocument();
      } catch (error) {
        // ignore close errors
      }
    }
  }

  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Record meeting audio from the active tab."
    });
  } catch (e) {
    const msg = e?.message ? e.message : String(e);

    
    if (!msg.toLowerCase().includes("exists")) {
      throw e;
    }
  }

  
  for (let i = 0; i < 30; i++) {
    const stored = await storageGet("local", "continuum_offscreen_ready");
    if (stored.continuum_offscreen_ready) {
      break;
    }
    await sleep(100);
  }

  
  const reachable = await pingOffscreen();
  if (!reachable) {
    await storageSet("local", { continuum_offscreen_ready: false });
    throw new Error(
      "Offscreen recorder did not become reachable. Reload the extension and try again."
    );
  }
}

async function sendToOffscreen(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ to: "offscreen", type, payload }, (res) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }

      if (!res) {
        return reject(new Error("No response from offscreen recorder."));
      }

      if (res.ok === false && res.error) {
        return reject(new Error(res.error));
      }

      resolve(res);
    });
  });
}

async function pingOffscreen() {
  try {
    const response = await sendToOffscreen("OFFSCREEN_PING", {});
    return Boolean(response && response.ok);
  } catch (error) {
    return false;
  }
}

async function startMeetingCaptureForActiveTab() {
  const state =
    (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {};

  if (state.status === "recording") {
    return { ok: true, ...state };
  }

  const s = await getSettings();
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");

  // Mark state early so UI shows progress
  await storageSet("local", {
    continuum_meeting_state: {
      status: "arming",
      sessionId: sessionInfo.sessionId,
      tabId: tab.id,
      startedAt: Date.now(),
      lastError: ""
    }
  });

  try {
    await ensureOffscreenDocument();

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id
    });

    await sendToOffscreen("OFFSCREEN_START_RECORDING", {
      streamId,
      sessionId: sessionInfo.sessionId,
      tabId: tab.id,
      backendBaseUrl: s.backendBaseUrl,
      pageUrl: tab.url || "",
      pageTitle: tab.title || ""
    });

    const next = {
      status: "recording",
      sessionId: sessionInfo.sessionId,
      tabId: tab.id,
      startedAt: Date.now(),
      lastError: ""
    };

    await storageSet("local", { continuum_meeting_state: next });
    await chrome.action.setBadgeText({ text: "REC", tabId: tab.id });

    return { ok: true, ...next };
  } catch (error) {
    const message = error?.message ? error.message : String(error);

    await storageSet("local", {
      continuum_meeting_state: {
        status: "error",
        sessionId: sessionInfo.sessionId,
        tabId: tab.id,
        startedAt: Date.now(),
        lastError: message
      }
    });

    throw error;
  }
}

async function stopMeetingCapture() {
  const state =
    (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {};

  if (state.status !== "recording") {
    return { ok: true, status: "idle" };
  }

  try {
    await sendToOffscreen("OFFSCREEN_STOP_RECORDING", {});
  } catch (error) {
    const message = error?.message ? error.message : String(error);

    await storageSet("local", {
      continuum_meeting_state: {
        ...state,
        status: "error",
        lastError: message
      }
    });

    throw error;
  }

  const next = {
    ...state,
    status: "saving",
    lastError: ""
  };

  await storageSet("local", { continuum_meeting_state: next });

  if (typeof state.tabId === "number") {
    await chrome.action.setBadgeText({ text: "...", tabId: state.tabId });
  }

  return { ok: true, ...next };
}

async function handleOffscreenMeetingComplete(payload) {
  const latest =
    (await storageGet("local", "continuum_latest_meetings")).continuum_latest_meetings || {};

  const currentState =
    (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {};

  if (typeof currentState.tabId === "number") {
    await chrome.action.setBadgeText({ text: "", tabId: currentState.tabId });
  }

  if (payload?.meeting?.session_id) {
    latest[payload.meeting.session_id] = payload.meeting;
    await storageSet("local", { continuum_latest_meetings: latest });

    await storageSet("local", {
      continuum_meeting_state: {
        status: "idle",
        sessionId: payload.meeting.session_id,
        lastCompletedAt: Date.now(),
        lastError: ""
      }
    });

    return;
  }

  await storageSet("local", {
    continuum_meeting_state: {
      status: "error",
      sessionId: currentState.sessionId || null,
      lastCompletedAt: Date.now(),
      lastError:
        payload?.error || "Meeting capture finished without returning a meeting record."
    }
  });
}

async function getMeetingStatus() {
  const state =
    (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {
      status: "idle",
      lastError: ""
    };

  return { ok: true, ...state };
}

async function getLatestMeeting(sessionId) {
  const local =
    (await storageGet("local", "continuum_latest_meetings")).continuum_latest_meetings || {};
  if (sessionId && local[sessionId]) return { ok: true, meeting: local[sessionId] };

  const s = await getSettings();
  return await fetchJson(
    `${s.backendBaseUrl}/meetings/latest?session_id=${encodeURIComponent(sessionId || "")}`,
    { method: "GET" }
  );
}

async function getOrCreateSessionForTab(tabId, currentUrl) {
  const key = String(tabId);
  const mappings =
    (await storageGet("local", "continuum_tab_sessions")).continuum_tab_sessions || {};
  const existing = mappings[key];
  if (existing && existing.url === currentUrl) return existing;

  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const next = { sessionId, url: currentUrl };
  mappings[key] = next;
  await storageSet("local", { continuum_tab_sessions: mappings });
  return next;
}

async function getSettings() {
  const r = await storageGet("sync", "continuum_settings");
  return {
    ...DEFAULT_SETTINGS,
    ...(r.continuum_settings || {}),
    auditRules: {
      ...DEFAULT_SETTINGS.auditRules,
      ...((r.continuum_settings || {}).auditRules || {})
    }
  };
}

function fetchJson(url, options) {
  return fetch(url, options).then(async (resp) => {
    const text = await resp.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!resp.ok) {
      throw new Error(data.detail || data.error || `Request failed: ${resp.status}`);
    }

    return data;
  });
}

function storageGet(area, key) {
  return new Promise((resolve) => chrome.storage[area].get(key, resolve));
}

function storageSet(area, value) {
  return new Promise((resolve) => chrome.storage[area].set(value, resolve));
}

function getActiveTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
      resolve(tabs?.[0] || null)
    )
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}