/*
  OFFSCREEN RECORDING DOCUMENT

  WHAT THIS FILE DOES
  1. Consumes a tab capture stream ID from the background service worker
  2. Uses getUserMedia + MediaRecorder to record the current tab's audio
  3. Keeps the tab audio audible to the user while recording
  4. Uploads the finished audio file directly to the backend
  5. Sends the saved meeting record back to the background script

*/

let mediaStream = null;
let mediaRecorder = null;
let audioContext = null;
let audioSourceNode = null;
let audioChunks = [];
let activeSessionId = null;
let activeTabId = null;
let activeBackendBaseUrl = null;
let activePageUrl = "";
let activePageTitle = "";
let activeMimeType = "audio/webm";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
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

async function startRecording(payload) {
  /*
    Refuse to start if already recording.
    WHY:
    Only one recorder should be active in this offscreen document.
  */
  if (mediaRecorder && mediaRecorder.state === "recording") {
    return;
  }

  activeSessionId = payload.sessionId;
  activeTabId = payload.tabId;
  activeBackendBaseUrl = payload.backendBaseUrl;
  activePageUrl = payload.pageUrl || "";
  activePageTitle = payload.pageTitle || "";

  /*
    Recreate the tab media stream from the service worker stream ID.
    WHY:
    The service worker can request the stream ID, but the offscreen document
    is where the actual DOM/media APIs run.
  */
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: payload.streamId
      }
    },
    video: false
  });

  /*
    Keep the tab audio audible locally.
    WHY:
    Tab capture can mute local playback unless we route the audio back out.
  */
  audioContext = new AudioContext();
  audioSourceNode = audioContext.createMediaStreamSource(mediaStream);
  audioSourceNode.connect(audioContext.destination);

  /*
    Choose the best supported audio mime type.
    WHY:
    WebM/Opus is compact and works well for transcription upload.
  */
  activeMimeType = pickSupportedMimeType();

  mediaRecorder = new MediaRecorder(mediaStream, {
    mimeType: activeMimeType,
    audioBitsPerSecond: 64000
  });

  audioChunks = [];

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    await finalizeAndUploadRecording();
  };

  /*
    Start chunking data every second.
    WHY:
    Smaller chunks keep memory use more predictable.
  */
  mediaRecorder.start(1000);
}

async function stopRecording() {
  /*
    STEP 6: Stop only if an active recorder exists.
    WHY:
    Avoid throwing on duplicate stop requests.
  */
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return;
  }

  mediaRecorder.stop();
}

async function finalizeAndUploadRecording() {
  /*
    Build a Blob from captured audio chunks.
    WHY:
    We need a real file-like payload to upload to FastAPI.
  */
  const blob = new Blob(audioChunks, { type: activeMimeType });

  /*
    Upload directly from the offscreen document.
    WHY:
    This avoids trying to pass a large recording through extension runtime
    messages, which is more fragile.
  */
  const formData = new FormData();
  const extension = activeMimeType.includes("webm") ? "webm" : "bin";
  formData.append(
    "file",
    new File([blob], `meeting_${Date.now()}.${extension}`, { type: activeMimeType })
  );
  formData.append("session_id", activeSessionId || "");
  formData.append("tab_id", String(activeTabId || ""));
  formData.append("page_url", activePageUrl || "");
  formData.append("page_title", activePageTitle || "");

  let backendResult = {
    ok: false,
    error: "Upload did not run."
  };

  try {
    const response = await fetch(`${activeBackendBaseUrl}/meetings/upload`, {
      method: "POST",
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || data.error || "Meeting upload failed.");
    }

    backendResult = data;
  } catch (error) {
    backendResult = {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }

  /*
    Notify the background worker that the meeting is complete.
    WHY:
    The popup reads the latest meeting result from the background cache.
  */
  await chrome.runtime.sendMessage({
    type: "OFFSCREEN_MEETING_COMPLETE",
    payload: backendResult
  });

  cleanupRecordingResources();
}

function cleanupRecordingResources() {
  /*
    Release all media resources.
    WHY:
    Prevents leaks and avoids leaving hidden streams running.
  */
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }

  if (audioSourceNode) {
    try {
      audioSourceNode.disconnect();
    } catch (error) {}
  }

  if (audioContext) {
    try {
      audioContext.close();
    } catch (error) {}
  }

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
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    ""
  ];

  for (const value of candidates) {
    if (!value) return "";
    if (MediaRecorder.isTypeSupported(value)) {
      return value;
    }
  }

  return "";
}