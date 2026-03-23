const DEFAULT_SETTINGS = {
  backendBaseUrl: "http://127.0.0.1:8000",
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

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("saveBtn").addEventListener("click", saveSettings);
  document.getElementById("refreshAiStatusBtn").addEventListener("click", refreshAiStatus);
  document.getElementById("connectAccountBtn").addEventListener("click", connectAccount);
  document.getElementById("refreshAccountBtn").addEventListener("click", refreshAccountStatus);

  await loadSettings();
  await refreshAiStatus();
  await refreshAccountStatus();
});

function mergeSettings(rawSettings) {
  return {
    ...DEFAULT_SETTINGS,
    ...(rawSettings || {}),
    auditRules: {
      ...DEFAULT_SETTINGS.auditRules,
      ...((rawSettings || {}).auditRules || {})
    },
    userAccount: {
      ...DEFAULT_SETTINGS.userAccount,
      ...((rawSettings || {}).userAccount || {})
    }
  };
}

async function loadSettings() {
  const result = await storageGet("continuum_settings");
  const settings = mergeSettings(result.continuum_settings || {});

  document.getElementById("backendBaseUrl").value = settings.backendBaseUrl || "";
  document.getElementById("meetingNotesStyle").value = settings.meetingNotesStyle || "professional_bullets";
  document.getElementById("requiredSections").value = (settings.auditRules.required_sections || []).join("\n");
  document.getElementById("requiredKeywords").value = (settings.auditRules.required_keywords || []).join("\n");
  document.getElementById("prohibitedWords").value = (settings.auditRules.prohibited_words || []).join("\n");
  document.getElementById("captureInputValues").checked = Boolean(settings.captureInputValues);
  document.getElementById("accountName").value = settings.userAccount?.name || "";
  document.getElementById("accountEmail").value = settings.userAccount?.email || "";
  renderAccountStatus(settings.userAccount || DEFAULT_SETTINGS.userAccount);
}

async function saveSettings() {
  const existing = await getSavedSettings();
  const backendBaseUrl = document.getElementById("backendBaseUrl").value.trim();
  const meetingNotesStyle = document.getElementById("meetingNotesStyle").value;
  const accountName = document.getElementById("accountName").value.trim();
  const accountEmail = document.getElementById("accountEmail").value.trim();

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
    },
    userAccount: {
      ...DEFAULT_SETTINGS.userAccount,
      ...(existing.userAccount || {}),
      name: accountName,
      email: accountEmail
    }
  };

  await storageSet({ continuum_settings: settings });
  document.getElementById("status").textContent = "Settings saved.";
  renderAccountStatus(settings.userAccount);
  await refreshAiStatus();
}

async function connectAccount() {
  const backendBaseUrl = document.getElementById("backendBaseUrl").value.trim() || DEFAULT_SETTINGS.backendBaseUrl;
  const existing = await getSavedSettings();
  const name = document.getElementById("accountName").value.trim();
  const email = document.getElementById("accountEmail").value.trim().toLowerCase();
  const statusEl = document.getElementById("accountStatusText");

  if (!email) {
    statusEl.textContent = "Enter an email first.";
    return;
  }

  statusEl.textContent = "Connecting beta account...";

  try {
    const response = await fetch(`${backendBaseUrl}/users/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name,
        user_id: existing.userAccount?.user_id || ""
      })
    });

    const data = await response.json();
    if (!response.ok || !data.user) throw new Error(data.detail || data.error || "Could not connect account.");

    const settings = {
      ...existing,
      backendBaseUrl,
      userAccount: {
        ...DEFAULT_SETTINGS.userAccount,
        ...data.user
      }
    };

    await storageSet({ continuum_settings: settings });
    document.getElementById("accountName").value = settings.userAccount.name || name;
    document.getElementById("accountEmail").value = settings.userAccount.email || email;
    renderAccountStatus(settings.userAccount);
    document.getElementById("status").textContent = "Beta account connected.";
  } catch (error) {
    statusEl.textContent = `Could not connect beta account: ${error.message}`;
  }
}

async function refreshAccountStatus() {
  const existing = await getSavedSettings();
  const backendBaseUrl = document.getElementById("backendBaseUrl").value.trim() || DEFAULT_SETTINGS.backendBaseUrl;
  const account = existing.userAccount || DEFAULT_SETTINGS.userAccount;

  if (!account.user_id && !account.email) {
    renderAccountStatus(account);
    return;
  }

  try {
    const params = new URLSearchParams();
    if (account.user_id) params.set("user_id", account.user_id);
    else if (account.email) params.set("email", account.email);

    const response = await fetch(`${backendBaseUrl}/users/status?${params.toString()}`);
    const data = await response.json();
    if (!response.ok || !data.user) throw new Error(data.detail || data.error || "Could not load account status.");

    const settings = {
      ...existing,
      backendBaseUrl,
      userAccount: {
        ...DEFAULT_SETTINGS.userAccount,
        ...data.user
      }
    };

    await storageSet({ continuum_settings: settings });
    renderAccountStatus(settings.userAccount);
  } catch (error) {
    document.getElementById("accountStatusText").textContent = `Could not load beta account status: ${error.message}`;
  }
}

function renderAccountStatus(account) {
  const statusEl = document.getElementById("accountStatusText");
  const usageEl = document.getElementById("accountUsageText");
  const safeAccount = {
    ...DEFAULT_SETTINGS.userAccount,
    ...(account || {})
  };

  if (!safeAccount.user_id && !safeAccount.email) {
    statusEl.textContent = "No beta account connected yet.";
    usageEl.textContent = "";
    return;
  }

  statusEl.textContent = `Connected as ${safeAccount.name || safeAccount.email || "beta user"} • Plan: ${safeAccount.plan || "free"}`;

  const usage = safeAccount.usage || {};
  const docs = Number(usage.documents_generated || 0);
  const shots = Number(usage.screenshots_saved || 0);
  const meetings = Number(usage.meetings_uploaded || 0);
  usageEl.textContent = `Usage so far — Docs: ${docs}, Screenshots: ${shots}, Meetings: ${meetings}`;
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

async function getSavedSettings() {
  const result = await storageGet("continuum_settings");
  return mergeSettings(result.continuum_settings || {});
}

function parseLines(value) {
  return String(value || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function storageGet(key) { return new Promise((resolve) => chrome.storage.sync.get(key, resolve)); }
function storageSet(value) { return new Promise((resolve) => chrome.storage.sync.set(value, resolve)); }