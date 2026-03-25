const DEFAULT_SETTINGS = {
  backendBaseUrl: "https://continuum-61io.onrender.com",
  auditRules: {
    required_sections: ["Purpose", "Preconditions", "Procedure", "Controls", "Evidence"],
    required_keywords: [],
    prohibited_words: []
  },
  captureInputValues: false,
  meetingNotesStyle: "professional_bullets",
  userAccount: {
    user_id: "",
    email: "",
    name: "",
    plan: "free",
    usage: {}
  }
};

const LOCAL_PLAN_LIMITS = {
  free: {
    documents_generated: 25,
    screenshots_saved: 100,
    meetings_uploaded: 10,
    external_docs_generated: 10
  },
  paid: {
    documents_generated: null,
    screenshots_saved: null,
    meetings_uploaded: null,
    external_docs_generated: null
  }
};

const USAGE_LIMIT_LABELS = {
  documents_generated: "documents",
  screenshots_saved: "screenshots",
  meetings_uploaded: "meetings",
  external_docs_generated: "external documents"
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await storageGet("sync", "continuum_settings");
  if (!existing.continuum_settings) {
    await storageSet("sync", { continuum_settings: DEFAULT_SETTINGS });
  }
  await storageSet("local", { continuum_offscreen_ready: false });
});

chrome.runtime.onStartup?.addListener(async () => {
  await storageSet("local", { continuum_offscreen_ready: false });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "OFFSCREEN_READY") {
        await storageSet("local", { continuum_offscreen_ready: true });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "MIC_PERMISSION_PRIMED") {
        await storageSet("local", { continuum_mic_primed: !!message.payload?.primed });
        sendResponse({ ok: true });
        return;
      }

      switch (message.type) {
        case "OPEN_WORKSPACE": {
          const tab = await getActiveTab();
          if (!tab || typeof tab.windowId !== "number") throw new Error("No active Chrome window found.");
          await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
          await chrome.sidePanel.open({ windowId: tab.windowId });
          sendResponse({ ok: true });
          return;
        }

        case "OPEN_LIBRARY": {
            const payload = message.payload || {};
            const params = new URLSearchParams();

            if (payload.mode) params.set("mode", payload.mode);
            if (payload.sessionId) params.set("session_id", payload.sessionId);
            if (payload.createdAt) params.set("created_at", payload.createdAt);
            if (payload.meetingId) params.set("meeting_id", payload.meetingId);
            if (payload.title) params.set("title", payload.title);

            const query = params.toString();
            const url = chrome.runtime.getURL(`dashboard.html${query ? `?${query}` : ""}`);

            await chrome.tabs.create({ url });
            sendResponse({ ok: true });
            return;
        }

        case "OPEN_OPTIONS_PAGE": {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          return;
        }

        case "OPEN_UPGRADE_PAGE": {
            const payload = message.payload || {};
            const params = new URLSearchParams();

            if (payload.reason) params.set("reason", payload.reason);

            const query = params.toString();
            const url = chrome.runtime.getURL(`upgrade.html${query ? `?${query}` : ""}`);

            await chrome.tabs.create({ url });
            sendResponse({ ok: true });
            return;
        }

        case "OPEN_MIC_PERMISSION_PAGE": {
          await chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
          sendResponse({ ok: true });
          return;
        }

        case "PING_BACKEND": {
          const s = await getSettings();
          try {
            const r = await fetchJson(`${s.backendBaseUrl}/health`, { method: "GET" });
            sendResponse(r);
          } catch {
            sendResponse({ ok: false, error: `Could not reach backend at ${s.backendBaseUrl}. Is uvicorn running?` });
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

        case "GET_CURRENT_PROCESS": {
            const process = await getCurrentProcess();
            sendResponse({ ok: true, process });
            return;
        }

        case "START_PROCESS": {
            const process = await startProcessForActiveTab(message.payload.intent);
            sendResponse({ ok: true, process });
            return;
        }

        case "ADD_CURRENT_TAB_TO_PROCESS": {
            const process = await addCurrentTabToCurrentProcess();
            sendResponse({ ok: true, process });
            return;
        }

        case "STOP_PROCESS": {
            const process = await stopCurrentProcess();
            sendResponse({ ok: true, process });
            return;
        }

        case "INCLUDE_SESSION_IN_PROCESS": {
            const process = await includeSessionInCurrentProcess(message.payload || {});
            sendResponse({ ok: true, process });
            return;
        }

        case "INCLUDE_MEETING_IN_PROCESS": {
            const process = await includeMeetingInCurrentProcess(message.payload || {});
            sendResponse({ ok: true, process });
            return;
        }

        case "GET_CAPTURE_STATE": {
            const state = await getCaptureState(message.payload?.sessionId || "");
            sendResponse({ ok: true, state });
            return;
        }

        case "START_CAPTURE": {
            const r = await startCaptureForSession(message.payload || {});
            sendResponse({ ok: true, ...r });
            return;
        }

        case "TOGGLE_CAPTURE_PAUSE": {
            const r = await toggleCapturePause(message.payload || {});
            sendResponse({ ok: true, ...r });
            return;
        }

        case "TOGGLE_PROCESS_PAUSE": {
            const process = await toggleCurrentProcessPause();
            sendResponse({ ok: true, process });
            return;
        }

        case "STOP_CAPTURE": {
            const r = await stopCaptureForSession(message.payload || {});
            sendResponse({ ok: true, ...r });
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
            `${s.backendBaseUrl}/sessions/evidence-summary?session_id=${encodeURIComponent(message.payload.sessionId)}`,
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
            const r = await generateDocsForCurrentProcess(message.payload || {});
            sendResponse(r);
            return;
        }

        case "START_GUIDED_RUN": {
            const r = await startGuidedRun(message.payload || {});
            sendResponse({ ok: true, ...r });
            return;
        }

        case "GET_GUIDED_RUN_STATE": {
            const r = await getGuidedRunStateForTab(sender.tab?.id || null);
            sendResponse({ ok: true, ...r });
            return;
        }

        case "GUIDED_RUN_STEP": {
            const r = await moveGuidedRunStep(message.payload || {}, sender.tab?.id || null);
            sendResponse({ ok: true, ...r });
            return;
        }

        case "EXIT_GUIDED_RUN": {
            const r = await exitGuidedRun(sender.tab?.id || null);
            sendResponse({ ok: true, ...r });
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
          const r = await startMeetingCaptureForActiveTab(message.payload || {});
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

  const captureState = await getCaptureState(sessionId);
  if (captureState.status === "paused" || captureState.status === "stopped") {
    return { sessionId, ignored: true, state: captureState };
  }

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
  const mappings = (await storageGet("local", "continuum_tab_sessions")).continuum_tab_sessions || {};
  const mapping = mappings[String(tabId)];
  if (!mapping) return { ok: true, sessionId: null, latestResult: null };

  const lastResults = (await storageGet("local", "continuum_last_results")).continuum_last_results || {};
  return { ok: true, sessionId: mapping.sessionId, latestResult: lastResults[mapping.sessionId] || null };
}

async function getCurrentProcess() {
  return (await storageGet("local", "continuum_current_process")).continuum_current_process || null;
}

async function saveCurrentProcess(process) {
  await storageSet("local", { continuum_current_process: process });
  return process;
}

function nowIso() {
  return new Date().toISOString();
}

async function startProcessForActiveTab(intent) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");
  const process = {
    processId: `process_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    status: "observing",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    intent,
    includedSessions: [
      {
        sessionId: sessionInfo.sessionId,
        tabId: tab.id,
        url: tab.url || "",
        title: tab.title || "",
        addedAt: nowIso()
      }
    ],
    includedMeetingIds: []
  };

  await setCaptureIntent(sessionInfo.sessionId, intent);
  await setCaptureState(sessionInfo.sessionId, "observing");
  await saveCurrentProcess(process);
  return process;
}

async function addCurrentTabToCurrentProcess() {
  const process = await getCurrentProcess();
  if (!process?.processId) throw new Error("Start a process first.");

  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");
  return await includeSessionInCurrentProcess({
    sessionId: sessionInfo.sessionId,
    tabId: tab.id,
    url: tab.url || "",
    title: tab.title || ""
  });
}

async function includeSessionInCurrentProcess(payload) {
  const process = await getCurrentProcess();
  if (!process?.processId) throw new Error("Start a process first.");

  const sessionId = payload.sessionId;
  if (!sessionId) throw new Error("Session ID is required.");

  const existing = Array.isArray(process.includedSessions) ? process.includedSessions : [];
  if (!existing.some((item) => item.sessionId === sessionId)) {
    existing.push({
      sessionId,
      tabId: Number.isFinite(payload.tabId) ? payload.tabId : null,
      url: payload.url || "",
      title: payload.title || payload.label || "",
      addedAt: nowIso()
    });
  }

  process.includedSessions = existing;
  process.updatedAt = nowIso();

  if (process.intent) {
    await setCaptureIntent(sessionId, process.intent);
  }

  process.includedSessions = existing;
  process.updatedAt = nowIso();

  const targetStatus =
    process.status === "paused" ? "paused" :
    process.status === "stopped" ? "stopped" :
    "observing";

  await setCaptureState(sessionId, targetStatus);
  await saveCurrentProcess(process);
  return process;
}

async function includeMeetingInCurrentProcess(payload) {
  const process = await getCurrentProcess();
  if (!process?.processId) throw new Error("Start a process first.");

  const meetingId = payload.meetingId;
  if (!meetingId) throw new Error("Meeting ID is required.");

  const existing = Array.isArray(process.includedMeetingIds) ? process.includedMeetingIds : [];
  if (!existing.includes(meetingId)) {
    existing.push(meetingId);
  }

  process.includedMeetingIds = existing;
  process.updatedAt = nowIso();
  await saveCurrentProcess(process);
  return process;
}

async function stopCurrentProcess() {
  const process = await getCurrentProcess();
  if (!process) return null;
  process.status = "stopped";
  process.updatedAt = nowIso();
  await saveCurrentProcess(process);
  return process;
}

async function flushSession(sessionId) {
  const s = await getSettings();
  const buffers = (await storageGet("local", "continuum_buffers")).continuum_buffers || {};
  const buffer = buffers[sessionId];

  if (!buffer?.actions?.length) return null;

  const intent = await getCaptureIntent(sessionId);
  const user = await getConnectedUser();

  const result = await fetchJson(`${s.backendBaseUrl}/ingest-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      page: buffer.page,
      actions: buffer.actions,
      rules: s.auditRules,
      intent: intent || null,
      user
    })
  });

  buffer.actions = [];
  buffers[sessionId] = buffer;
  await storageSet("local", { continuum_buffers: buffers });
  return result;
}

async function generateDocsForCurrentProcess(payload) {
  const process = await getCurrentProcess();

  if (process?.intent?.process_name && Array.isArray(process.includedSessions) && process.includedSessions.length) {
    await syncConnectedUserStatus();
    await enforceLocalUsageLimit("documents_generated");

    const sessionIds = process.includedSessions.map((item) => item.sessionId).filter(Boolean);

    for (const sessionId of sessionIds) {
      await flushSession(sessionId);
    }

    const s = await getSettings();
    const user = await getConnectedUser();
    const result = await fetchJson(`${s.backendBaseUrl}/docs/generate-process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        process_id: process.processId,
        session_ids: sessionIds,
        meeting_ids: Array.isArray(process.includedMeetingIds) ? process.includedMeetingIds : [],
        rules: s.auditRules,
        intent: process.intent,
        user
      })
    });

    await storageSet("local", { continuum_last_process_result: result });

    const lastResults = (await storageGet("local", "continuum_last_results")).continuum_last_results || {};
    if (sessionIds[0]) lastResults[sessionIds[0]] = result;
    await storageSet("local", { continuum_last_results: lastResults });

    await bumpStoredUsage({ documents_generated: 1 });
    await syncConnectedUserStatus(user);
    return result;
  }

  return await generateDocsForSession(payload.sessionId);
}



async function generateDocsForSession(sessionId) {
  const intent = await getCaptureIntent(sessionId);
  if (!intent?.process_name) throw new Error("Start a process first before generating a document.");

  await syncConnectedUserStatus();
  await enforceLocalUsageLimit("documents_generated");
  await flushSession(sessionId);

  const s = await getSettings();
  const user = await getConnectedUser();
  const result = await fetchJson(`${s.backendBaseUrl}/docs/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, rules: s.auditRules, intent, user })
  });

  const lastResults = (await storageGet("local", "continuum_last_results")).continuum_last_results || {};
  lastResults[sessionId] = result;
  await storageSet("local", { continuum_last_results: lastResults });

  await bumpStoredUsage({ documents_generated: 1 });
  await syncConnectedUserStatus(user);

  return result;
}

async function captureScreenshotForActiveTab(payload) {
  await syncConnectedUserStatus();
  await enforceLocalUsageLimit("screenshots_saved");

  const s = await getSettings();
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");
  const sessionId = payload?.sessionId || sessionInfo.sessionId;

  const captureState = await getCaptureState(sessionId);
  if (captureState.status === "paused") {
    throw new Error("Observation is paused. Resume before capturing screenshots.");
  }
  if (captureState.status === "stopped") {
    throw new Error("Observation is stopped. Start again before capturing screenshots.");
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const user = await getConnectedUser();

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
      step_index: Number.isFinite(payload?.step_index) ? payload.step_index : 0,
      user_id: user?.user_id || "",
      user_email: user?.email || "",
      user_name: user?.name || ""
    })
  });

  await bumpStoredUsage({ screenshots_saved: 1 });
  await syncConnectedUserStatus(user);
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

async function getAllCaptureStates() {
  return (await storageGet("local", "continuum_capture_states")).continuum_capture_states || {};
}

async function getCaptureState(sessionId) {
  if (!sessionId) return { status: "idle", updatedAt: null };
  const states = await getAllCaptureStates();
  return states[sessionId] || { status: "observing", updatedAt: null };
}

async function setCaptureState(sessionId, status) {
  if (!sessionId) throw new Error("Session ID is required.");

  const states = await getAllCaptureStates();
  states[sessionId] = {
    status,
    updatedAt: new Date().toISOString()
  };
  await storageSet("local", { continuum_capture_states: states });
  return states[sessionId];
}

async function startCaptureForSession(payload) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");
  const sessionId = payload.sessionId || sessionInfo.sessionId;

  if (payload.intent) {
    await setCaptureIntent(sessionId, payload.intent);
  }

  const state = await setCaptureState(sessionId, "observing");
  return { sessionId, state };
}

async function toggleCapturePause(payload) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");
  const sessionId = payload.sessionId || sessionInfo.sessionId;
  const current = await getCaptureState(sessionId);

  if (current.status === "paused") {
    const state = await setCaptureState(sessionId, "observing");
    return { sessionId, state };
  }

  if (current.status === "stopped") {
    const state = await setCaptureState(sessionId, "observing");
    return { sessionId, state };
  }

  await flushSession(sessionId);
  const state = await setCaptureState(sessionId, "paused");
  return { sessionId, state };
}

async function toggleCurrentProcessPause() {
  const process = await getCurrentProcess();
  if (!process?.processId) {
    throw new Error("Start a process first.");
  }

  const includedSessions = Array.isArray(process.includedSessions) ? process.includedSessions : [];
  if (!includedSessions.length) {
    throw new Error("No included tabs in the current process.");
  }

  const nextStatus = process.status === "paused" ? "observing" : "paused";

  if (nextStatus === "paused") {
    for (const item of includedSessions) {
      if (item.sessionId) {
        await flushSession(item.sessionId);
      }
    }
  }

  for (const item of includedSessions) {
    if (item.sessionId) {
      await setCaptureState(item.sessionId, nextStatus);
    }
  }

  process.status = nextStatus;
  process.updatedAt = nowIso();
  await saveCurrentProcess(process);
  return process;
}

async function stopCaptureForSession(payload) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");
  const sessionId = payload.sessionId || sessionInfo.sessionId;

  await flushSession(sessionId);
  const state = await setCaptureState(sessionId, "stopped");
  return { sessionId, state };
}

async function ensureOffscreenDocument() {
  const hasWorkingOffscreen = await pingOffscreen();
  if (hasWorkingOffscreen) return;

  await storageSet("local", { continuum_offscreen_ready: false });

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    const hasOffscreenContext = contexts.some((ctx) => ctx.documentUrl && ctx.documentUrl.includes("offscreen.html"));
    if (hasOffscreenContext && chrome.offscreen?.closeDocument) {
      try { await chrome.offscreen.closeDocument(); } catch (_) {}
    }
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record meeting audio from the active tab + microphone."
  });

  for (let i = 0; i < 30; i++) {
    const stored = await storageGet("local", "continuum_offscreen_ready");
    if (stored.continuum_offscreen_ready) break;
    await sleep(100);
  }

  const reachable = await pingOffscreen();
  if (!reachable) {
    await storageSet("local", { continuum_offscreen_ready: false });
    throw new Error("Offscreen recorder not reachable. Reload extension and try again.");
  }
}

async function sendToOffscreen(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ to: "offscreen", type, payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error("No response from offscreen recorder."));
      if (res.ok === false && res.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

async function pingOffscreen() {
  try {
    const res = await sendToOffscreen("OFFSCREEN_PING", {});
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

async function startMeetingCaptureForActiveTab(opts) {
  await syncConnectedUserStatus();
  await enforceLocalUsageLimit("meetings_uploaded");

  const state = (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {};
  if (state.status === "recording") return { ok: true, ...state };

  const s = await getSettings();
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  const sessionInfo = await getOrCreateSessionForTab(tab.id, tab.url || "");

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

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const user = await getConnectedUser();

    await sendToOffscreen("OFFSCREEN_START_RECORDING", {
      streamId,
      sessionId: sessionInfo.sessionId,
      tabId: tab.id,
      backendBaseUrl: s.backendBaseUrl,
      pageUrl: tab.url || "",
      pageTitle: tab.title || "",
      includeMic: true,
      notesStyle: s.meetingNotesStyle || "professional_bullets",
      user,
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
    const msg = error?.message ? error.message : String(error);
    await storageSet("local", {
      continuum_meeting_state: {
        status: "error",
        sessionId: sessionInfo.sessionId,
        tabId: tab.id,
        startedAt: Date.now(),
        lastError: msg
      }
    });
    throw error;
  }
}

async function stopMeetingCapture() {
  const state = (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {};
  if (state.status !== "recording") return { ok: true, status: "idle" };

  await sendToOffscreen("OFFSCREEN_STOP_RECORDING", {});

  const next = { ...state, status: "saving", lastError: "" };
  await storageSet("local", { continuum_meeting_state: next });

  if (typeof state.tabId === "number") {
    await chrome.action.setBadgeText({ text: "...", tabId: state.tabId });
  }
  return { ok: true, ...next };
}

async function handleOffscreenMeetingComplete(payload) {
  const latest = (await storageGet("local", "continuum_latest_meetings")).continuum_latest_meetings || {};
  const currentState = (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || {};

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

    const durationSeconds = Number(payload?.meeting?.duration_seconds || 0);
    await bumpStoredUsage({
        meetings_uploaded: 1,
        meeting_minutes_processed: durationSeconds > 0 ? Math.ceil(durationSeconds / 60) : 0
    });

    await syncConnectedUserStatus();
    return;
    }

  await storageSet("local", { continuum_meeting_state: { status: "error", sessionId: currentState.sessionId || null, lastCompletedAt: Date.now(), lastError: payload?.error || "Meeting finished without returning a record." } });
}

async function getMeetingStatus() {
  const state = (await storageGet("local", "continuum_meeting_state")).continuum_meeting_state || { status: "idle", lastError: "" };
  return { ok: true, ...state };
}

async function getLatestMeeting(sessionId) {
  const local = (await storageGet("local", "continuum_latest_meetings")).continuum_latest_meetings || {};
  if (sessionId && local[sessionId]) return { ok: true, meeting: local[sessionId] };

  const s = await getSettings();
  return await fetchJson(`${s.backendBaseUrl}/meetings/latest?session_id=${encodeURIComponent(sessionId || "")}`, { method: "GET" });
}

async function getGuidedRunState() {
  return (await storageGet("local", "continuum_guided_run")).continuum_guided_run || null;
}

async function saveGuidedRunState(state) {
  await storageSet("local", { continuum_guided_run: state });
  return state;
}

async function clearGuidedRunState() {
  await storageSet("local", { continuum_guided_run: null });
}

async function startGuidedRun(payload) {
  const guide = payload.guide || {};
  const steps = Array.isArray(guide.steps) ? guide.steps : [];
  if (!steps.length) throw new Error("No guided steps were available for this document.");

  const startUrl = guide.start_url || steps[0]?.page_url || "";
  if (!startUrl) throw new Error("No start page was found for this guided run.");

  const tab = await chrome.tabs.create({ url: startUrl, active: true });
  const state = {
    guideId: `guide_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    guideTabId: tab.id,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    currentIndex: 0,
    status: "running",
    guide,
    documentRef: payload.documentRef || {}
  };

  await saveGuidedRunState(state);
  return { guidedRun: state };
}

async function getGuidedRunStateForTab(tabId) {
  const state = await getGuidedRunState();
  if (!state || !state.guideTabId || !tabId || state.guideTabId !== tabId || state.status !== "running") {
    return { guidedRun: null };
  }

  const steps = Array.isArray(state.guide?.steps) ? state.guide.steps : [];
  const currentStep = steps[state.currentIndex] || null;
  return {
    guidedRun: {
      guideId: state.guideId,
      guideTabId: state.guideTabId,
      currentIndex: state.currentIndex,
      totalSteps: steps.length,
      documentTitle: state.guide?.document_title || "Guided Run",
      currentStep,
      status: state.status
    }
  };
}

async function moveGuidedRunStep(payload, tabId) {
  const state = await getGuidedRunState();
  if (!state || state.status !== "running" || !tabId || state.guideTabId !== tabId) {
    return { guidedRun: null };
  }

  const steps = Array.isArray(state.guide?.steps) ? state.guide.steps : [];
  if (!steps.length) {
    return { guidedRun: null };
  }

  const delta = Number.isFinite(payload.delta) ? payload.delta : 0;
  const nextIndex = Math.max(0, Math.min(steps.length - 1, state.currentIndex + delta));
  state.currentIndex = nextIndex;
  state.updatedAt = nowIso();
  await saveGuidedRunState(state);

  return await getGuidedRunStateForTab(tabId);
}

async function exitGuidedRun(tabId) {
  const state = await getGuidedRunState();
  if (state && tabId && state.guideTabId === tabId) {
    await clearGuidedRunState();
    return { exited: true };
  }
  if (state && !tabId) {
    await clearGuidedRunState();
    return { exited: true };
  }
  return { exited: false };
}

async function getOrCreateSessionForTab(tabId, currentUrl) {
  const key = String(tabId);
  const mappings = (await storageGet("local", "continuum_tab_sessions")).continuum_tab_sessions || {};
  const existing = mappings[key];
  if (existing && existing.url === currentUrl) return existing;

  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const next = { sessionId, url: currentUrl };
  mappings[key] = next;
  await storageSet("local", { continuum_tab_sessions: mappings });
  return next;
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  return (trimmed || DEFAULT_SETTINGS.backendBaseUrl).replace(/\/+$/, "");
}

function getUsageSnapshot(account = {}) {
  const plan = String(account.plan || "free").trim().toLowerCase();
  const fallbackLimits = LOCAL_PLAN_LIMITS[plan] || LOCAL_PLAN_LIMITS.free;

  return {
    plan,
    usage: {
      documents_generated: Number(account?.usage?.documents_generated || 0),
      screenshots_saved: Number(account?.usage?.screenshots_saved || 0),
      meetings_uploaded: Number(account?.usage?.meetings_uploaded || 0),
      meeting_minutes_processed: Number(account?.usage?.meeting_minutes_processed || 0),
      external_docs_generated: Number(account?.usage?.external_docs_generated || 0)
    },
    limits: {
      ...fallbackLimits,
      ...(account?.limits || {})
    }
  };
}

async function enforceLocalUsageLimit(usageKey, amount = 1) {
  const s = await getSettings();
  const account = s.userAccount || {};

  if (!account.user_id && !account.email) {
    throw new Error("Connect a beta account before using this feature.");
  }

  const { usage, limits, plan } = getUsageSnapshot(account);
  const limit = limits[usageKey];
  const current = Number(usage[usageKey] || 0);
  const requestedAmount = Math.max(1, Number(amount || 1));

  if (limit == null) {
    return { account, plan, current, limit: null };
  }

  if (current + requestedAmount > Number(limit)) {
    const label = USAGE_LIMIT_LABELS[usageKey] || usageKey.replace(/_/g, " ");
    const planLabel = plan === "paid" ? "Paid" : "Free";
    throw new Error(
      `${planLabel} plan limit reached for ${label}. You've used ${current} of ${limit}. Upgrade to continue.`
    );
  }

  return { account, plan, current, limit: Number(limit) };
}

function mergeUsageCounts(existingUsage = {}, incomingUsage = {}) {
  const keys = new Set([
    ...Object.keys(existingUsage || {}),
    ...Object.keys(incomingUsage || {})
  ]);

  const merged = {};
  for (const key of keys) {
    merged[key] = Math.max(
      Number(existingUsage?.[key] || 0),
      Number(incomingUsage?.[key] || 0)
    );
  }
  return merged;
}

async function getSettings() {
  const r = await storageGet("sync", "continuum_settings");
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(r.continuum_settings || {}),
    auditRules: {
      ...DEFAULT_SETTINGS.auditRules,
      ...((r.continuum_settings || {}).auditRules || {})
    },
    userAccount: {
      ...DEFAULT_SETTINGS.userAccount,
      ...((r.continuum_settings || {}).userAccount || {})
    }
  };

  merged.backendBaseUrl = normalizeBaseUrl(merged.backendBaseUrl);
  merged.userAccount.email = String(merged.userAccount.email || "").trim().toLowerCase();
  merged.userAccount.name = String(merged.userAccount.name || "").trim();
  return merged;
}

async function saveSettingsPatch(nextSettings) {
  const current = await getSettings();
  const nextUserAccount = (nextSettings || {}).userAccount || {};

  const merged = {
    ...current,
    ...nextSettings,
    backendBaseUrl: normalizeBaseUrl(nextSettings.backendBaseUrl || current.backendBaseUrl),
    auditRules: {
      ...current.auditRules,
      ...((nextSettings || {}).auditRules || {})
    },
    userAccount: {
      ...current.userAccount,
      ...nextUserAccount,
      usage: mergeUsageCounts(
        current.userAccount?.usage || {},
        nextUserAccount.usage || {}
      )
    }
  };

  await storageSet("sync", { continuum_settings: merged });
  return merged;
}

async function bumpStoredUsage(deltas = {}) {
  const current = await getSettings();
  const account = current.userAccount || {};

  if (!account.user_id && !account.email) return current;

  const nextUsage = { ...(account.usage || {}) };

  for (const [key, delta] of Object.entries(deltas)) {
    nextUsage[key] = Math.max(
      0,
      Number(nextUsage[key] || 0) + Number(delta || 0)
    );
  }

  return await saveSettingsPatch({
    userAccount: {
      ...account,
      usage: nextUsage
    }
  });
}

async function syncConnectedUserStatus(preferredUser = null) {
  const s = await getSettings();
  const account = preferredUser || s.userAccount || {};

  if (!account.user_id && !account.email) return null;

  try {
    let user = null;

    if (account.email) {
        const bootstrapped = await fetchJson(`${s.backendBaseUrl}/users/bootstrap`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: account.email || "",
                name: account.name || "",
                user_id: ""
            })
        });
        user = bootstrapped?.user || null;
    } else if (account.user_id) {
      const status = await fetchJson(
        `${s.backendBaseUrl}/users/status?user_id=${encodeURIComponent(account.user_id)}`,
        { method: "GET" }
      );
      user = status?.user || null;
    }

    if (user) {
      await saveSettingsPatch({
        userAccount: {
          ...user,
          email: user.email || account.email || "",
          name: user.name || account.name || "",
          usage: mergeUsageCounts(account.usage || {}, user.usage || {})
        }
      });

      return {
        user_id: user.user_id || "",
        email: user.email || account.email || "",
        name: user.name || account.name || ""
      };
    }
  } catch (_) {}

  return {
    user_id: account.user_id || "",
    email: account.email || "",
    name: account.name || ""
  };
}

async function getConnectedUser() {
  const s = await getSettings();
  const account = s.userAccount || {};

  if (!account.email && !account.user_id) return null;

  if (account.user_id) {
    return {
      user_id: account.user_id || "",
      email: account.email || "",
      name: account.name || ""
    };
  }

  return await syncConnectedUserStatus(account);
}

function fetchJson(url, options) {
  return fetch(url, options).then(async (resp) => {
    const text = await resp.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!resp.ok) throw new Error(data.detail || data.error || `Request failed: ${resp.status}`);
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
  return new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] || null)));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
