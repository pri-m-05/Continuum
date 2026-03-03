/*
  OPTIONS PAGE

  WHAT THIS FILE DOES
  1. Loads the current saved settings
  2. Lets the user change backend URL and audit rules
  3. Saves those settings to chrome.storage.sync

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

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("saveBtn").addEventListener("click", saveSettings);
  await loadSettings();
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
  document.getElementById("requiredSections").value =
    (settings.auditRules.required_sections || []).join("\n");
  document.getElementById("requiredKeywords").value =
    (settings.auditRules.required_keywords || []).join("\n");
  document.getElementById("prohibitedWords").value =
    (settings.auditRules.prohibited_words || []).join("\n");
  document.getElementById("captureInputValues").checked = Boolean(settings.captureInputValues);
}

async function saveSettings() {
  const backendBaseUrl = document.getElementById("backendBaseUrl").value.trim();
  const requiredSections = parseLines(document.getElementById("requiredSections").value);
  const requiredKeywords = parseLines(document.getElementById("requiredKeywords").value);
  const prohibitedWords = parseLines(document.getElementById("prohibitedWords").value);
  const captureInputValues = document.getElementById("captureInputValues").checked;

  const settings = {
    backendBaseUrl: backendBaseUrl || DEFAULT_SETTINGS.backendBaseUrl,
    captureInputValues,
    auditRules: {
      required_sections: requiredSections,
      required_keywords: requiredKeywords,
      prohibited_words: prohibitedWords
    }
  };

  await storageSet({
    continuum_settings: settings
  });

  document.getElementById("status").textContent = "Settings saved.";
}

function parseLines(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(key, resolve);
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(value, resolve);
  });
}