let mediaStream = null;
let mediaRecorder = null;
let audioContext = null;
let audioSourceNode = null;
let audioChunks = [];
let state = { ready: false, recording: false };

let activeSessionId = null;
let activeTabId = null;
let activeBackendBaseUrl = null;
let activePageUrl = "";
let activePageTitle = "";
let activeMimeType = "audio/webm";

(async function boot() {
  // Tell background we exist and can receive messages now.
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

async function startRecording(payload) {
  if (mediaRecorder && mediaRecorder.state === "recording") return;

  activeSessionId = payload.sessionId;
  activeTabId = payload.tabId;
  activeBackendBaseUrl = payload.backendBaseUrl;
  activePageUrl = payload.pageUrl || "";
  activePageTitle = payload.pageTitle || "";

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: payload.streamId
      }
    },
    video: false
  });

  audioContext = new AudioContext();
  audioSourceNode = audioContext.createMediaStreamSource(mediaStream);
  audioSourceNode.connect(audioContext.destination);

  activeMimeType = pickSupportedMimeType();
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: activeMimeType, audioBitsPerSecond: 64000 });

  audioChunks = [];
  state.recording = true;

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) audioChunks.push(event.data);
  };

  mediaRecorder.onstop = async () => {
    state.recording = false;
    await finalizeAndUploadRecording();
  };

  mediaRecorder.start(1000);
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  mediaRecorder.stop();
}

async function finalizeAndUploadRecording() {
  const blob = new Blob(audioChunks, { type: activeMimeType });
  const extension = activeMimeType.includes("webm") ? "webm" : "bin";

  const formData = new FormData();
  formData.append("file", new File([blob], `meeting_${Date.now()}.${extension}`, { type: activeMimeType }));
  formData.append("session_id", activeSessionId || "");
  formData.append("tab_id", String(activeTabId || ""));
  formData.append("page_url", activePageUrl || "");
  formData.append("page_title", activePageTitle || "");

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
  cleanup();
}

function cleanup() {
  try { mediaStream?.getTracks()?.forEach(t => t.stop()); } catch (_) {}
  try { audioSourceNode?.disconnect(); } catch (_) {}
  try { audioContext?.close(); } catch (_) {}

  mediaStream = null;
  mediaRecorder = null;
  audioContext = null;
  audioSourceNode = null;
  audioChunks = [];

  activeSessionId = null;
  activeTabId = null;
  activeBackendBaseUrl = null;
  activePageUrl = "";
  activePageTitle = "";
}

function pickSupportedMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", ""];
  for (const value of candidates) {
    if (!value) return "";
    if (MediaRecorder.isTypeSupported(value)) return value;
  }
  return "";
}