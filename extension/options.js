const DEFAULT_SETTINGS = {
  backendBaseUrl: "http://127.0.0.1:8000",
  auditRules: {
    required_sections: ["Purpose", "Preconditions", "Procedure", "Controls", "Evidence"],
    required_keywords: [],
    prohibited_words: []
  },
  captureInputValues: false,
  meetingNotesStyle: "professional_bullets"
};

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("saveBtn").addEventListener("click", saveSettings);
  document.getElementById("refreshAiStatusBtn").addEventListener("click", refreshAiStatus);
  await loadSettings();
  await refreshAiStatus();
});

async function loadSettings() {
  const result = await storageGet("continuum_settings");
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(result.continuum_settings || {}),
    auditRules: {
      ...DEFAULT_SETTINGS.auditRules,
      ...((result.continuum_settings || {}).auditRules || {})
    }
  };

  document.getElementById("backendBaseUrl").value = settings.backendBaseUrl || "";
  document.getElementById("meetingNotesStyle").value = settings.meetingNotesStyle || "professional_bullets";
  document.getElementById("requiredSections").value = (settings.auditRules.required_sections || []).join("\n");
  document.getElementById("requiredKeywords").value = (settings.auditRules.required_keywords || []).join("\n");
  document.getElementById("prohibitedWords").value = (settings.auditRules.prohibited_words || []).join("\n");
  document.getElementById("captureInputValues").checked = Boolean(settings.captureInputValues);
}

async function saveSettings() {
  const backendBaseUrl = document.getElementById("backendBaseUrl").value.trim();
  const meetingNotesStyle = document.getElementById("meetingNotesStyle").value;

  const requiredSections = parseLines(document.getElementById("requiredSections").value);
  const requiredKeywords = parseLines(document.getElementById("requiredKeywords").value);
  const prohibitedWords = parseLines(document.getElementById("prohibitedWords").value);
  const captureInputValues = document.getElementById("captureInputValues").checked;

  const settings = {
    backendBaseUrl: backendBaseUrl || DEFAULT_SETTINGS.backendBaseUrl,
    meetingNotesStyle: meetingNotesStyle || "professional_bullets",
    captureInputValues,
    auditRules: {
      required_sections: requiredSections,
      required_keywords: requiredKeywords,
      prohibited_words: prohibitedWords
    }
  };

  await storageSet({ continuum_settings: settings });
  document.getElementById("status").textContent = "Settings saved.";
  await refreshAiStatus();
}

async function refreshAiStatus() {
  const statusEl = document.getElementById("aiStatusText");
  const backendBaseUrl = document.getElementById("backendBaseUrl").value.trim() || DEFAULT_SETTINGS.backendBaseUrl;
  statusEl.textContent = "Checking backend AI configuration...";

  try {
    const response = await fetch(`${backendBaseUrl}/config/status`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || `Request failed: ${response.status}`);

    statusEl.textContent = data.ai?.configured
      ? "OpenAI key detected on backend. Meeting transcription + notes enabled."
      : "OpenAI key NOT loaded on backend. Meetings can save, but transcript/notes disabled.";
  } catch (error) {
    statusEl.textContent = `Could not check backend AI status: ${error.message}`;
  }
}

function parseLines(value) {
  return String(value || "").split("\n").map((line) => line.trim()).filter(Boolean);
}
function storageGet(key) { return new Promise((resolve) => chrome.storage.sync.get(key, resolve)); }
function storageSet(value) { return new Promise((resolve) => chrome.storage.sync.set(value, resolve)); }
