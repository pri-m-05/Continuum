let mediaRecorder = null;
let audioChunks = [];
let state = { ready: false, recording: false };

let activeSessionId = null;
let activeTabId = null;
let activeBackendBaseUrl = null;
let activePageUrl = "";
let activePageTitle = "";
let activeMimeType = "audio/webm";
let activeNotesStyle = "professional_bullets";

(async function boot() {
  try {
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" });
    state.ready = true;
  } catch (_) {}
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message?.to !== "offscreen") return;

      switch (message.type) {
        case "OFFSCREEN_PING":
          sendResponse({ ok: true, ready: true, recording: !!state.recording });
          return;

        case "OFFSCREEN_START_RECORDING":
          await startRecording(message.payload);
          sendResponse({ ok: true });
          return;

        case "OFFSCREEN_STOP_RECORDING":
          await stopRecording();
          sendResponse({ ok: true });
          return;

        default:
          sendResponse({ ok: false, error: "Unknown offscreen message." });
          return;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message ? error.message : String(error) });
    }
  })();
  return true;
});

let tabStream = null;
let micStream = null;
let audioContext = null;
let destination = null;
let tabSource = null;
let micSource = null;

async function startRecording(payload) {
  if (mediaRecorder && mediaRecorder.state === "recording") return;

  activeSessionId = payload.sessionId;
  activeTabId = payload.tabId;
  activeBackendBaseUrl = payload.backendBaseUrl;
  activePageUrl = payload.pageUrl || "";
  activePageTitle = payload.pageTitle || "";
  activeNotesStyle = payload.notesStyle || "professional_bullets";

  // TAB OUTPUT (what you hear)
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: payload.streamId
      }
    },
    video: false
  });

  // MIC INPUT (your voice) — ALWAYS attempt
  let micOk = false;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    micOk = true;
  } catch {
    micStream = null;
    micOk = false;
  }

  audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();

  destination = audioContext.createMediaStreamDestination();

  tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(destination);
  tabSource.connect(audioContext.destination);

  if (micStream) {
    micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);
  } else {
    micSource = null;
  }

  // Level meters (tab + mic)
  const tabAnalyser = audioContext.createAnalyser();
  tabAnalyser.fftSize = 2048;
  tabSource.connect(tabAnalyser);

  let micAnalyser = null;
  if (micSource) {
    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 2048;
    micSource.connect(micAnalyser);
  }

  const tabData = new Uint8Array(tabAnalyser.frequencyBinCount);
  const micData = micAnalyser ? new Uint8Array(micAnalyser.frequencyBinCount) : null;

  let tabSum = 0, tabSamples = 0;
  let micSum = 0, micSamples = 0;

  const levelTimer = setInterval(() => {
    tabAnalyser.getByteTimeDomainData(tabData);
    tabSum += rmsFromBytes(tabData);
    tabSamples += 1;

    if (micAnalyser && micData) {
      micAnalyser.getByteTimeDomainData(micData);
      micSum += rmsFromBytes(micData);
      micSamples += 1;
    }
  }, 500);

  const mixedStream = destination.stream;

  activeMimeType = pickSupportedMimeType();
  mediaRecorder = new MediaRecorder(mixedStream, { mimeType: activeMimeType, audioBitsPerSecond: 64000 });

  audioChunks = [];
  state.recording = true;

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) audioChunks.push(event.data);
  };

  mediaRecorder.onstop = async () => {
    clearInterval(levelTimer);

    const tabLevel = tabSamples ? tabSum / tabSamples : 0;
    const micLevel = micSamples ? micSum / micSamples : 0;

    state.recording = false;

    try { tabStream?.getTracks()?.forEach(t => t.stop()); } catch (_) {}
    try { micStream?.getTracks()?.forEach(t => t.stop()); } catch (_) {}

    await finalizeAndUploadRecording({ micOk, tabLevel, micLevel });
    cleanup();
  };

  mediaRecorder.start(1000);
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  mediaRecorder.stop();
}

async function finalizeAndUploadRecording(meta) {
  const blob = new Blob(audioChunks, { type: activeMimeType });
  const extension = activeMimeType.includes("webm") ? "webm" : "bin";

  const formData = new FormData();
  formData.append("file", new File([blob], `meeting_${Date.now()}.${extension}`, { type: activeMimeType }));
  formData.append("session_id", activeSessionId || "");
  formData.append("tab_id", String(activeTabId || ""));
  formData.append("page_url", activePageUrl || "");
  formData.append("page_title", activePageTitle || "");

  formData.append("mic_ok", String(!!meta?.micOk));
  formData.append("tab_level", String(meta?.tabLevel || 0));
  formData.append("mic_level", String(meta?.micLevel || 0));
  formData.append("notes_style", String(activeNotesStyle || "professional_bullets"));

  let backendResult = { ok: false, error: "Upload not executed." };

  try {
    const response = await fetch(`${activeBackendBaseUrl}/meetings/upload`, { method: "POST", body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "Meeting upload failed.");
    backendResult = data;
  } catch (error) {
    backendResult = { ok: false, error: error?.message ? error.message : String(error) };
  }

  await chrome.runtime.sendMessage({ type: "OFFSCREEN_MEETING_COMPLETE", payload: backendResult });
}

function cleanup() {
  mediaRecorder = null;
  audioChunks = [];

  tabStream = null;
  micStream = null;
  destination = null;

  try { tabSource?.disconnect(); } catch (_) {}
  try { micSource?.disconnect(); } catch (_) {}
  try { audioContext?.close(); } catch (_) {}

  audioContext = null;
  tabSource = null;
  micSource = null;

  activeSessionId = null;
  activeTabId = null;
  activeBackendBaseUrl = null;
  activePageUrl = "";
  activePageTitle = "";
  activeNotesStyle = "professional_bullets";
}

function pickSupportedMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", ""];
  for (const value of candidates) {
    if (!value) return "";
    if (MediaRecorder.isTypeSupported(value)) return value;
  }
  return "";
}

function rmsFromBytes(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}
