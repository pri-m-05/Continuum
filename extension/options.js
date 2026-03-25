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

const UPGRADE_CONTACT_EMAIL = "pmamman@uwaterloo.ca";

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("saveBtn").addEventListener("click", saveSettings);
  document.getElementById("refreshAiStatusBtn").addEventListener("click", refreshAiStatus);
  document.getElementById("connectAccountBtn").addEventListener("click", connectAccount);
  document.getElementById("refreshAccountBtn").addEventListener("click", refreshAccountStatus);
  document.getElementById("requestUpgradeBtn").addEventListener("click", requestUpgrade);

  await loadSettings();
  await refreshAiStatus();
  await refreshAccountStatus();
});

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  return (trimmed || DEFAULT_SETTINGS.backendBaseUrl).replace(/\/+$/, "");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isSameAccountEmail(existingEmail, nextEmail) {
  const a = normalizeEmail(existingEmail);
  const b = normalizeEmail(nextEmail);
  return Boolean(a) && a === b;
}

function getReusableUserId(account, email) {
  return isSameAccountEmail(account?.email, email)
    ? String(account?.user_id || "").trim()
    : "";
}

function getResetOrExistingAccount(account, email) {
  if (isSameAccountEmail(account?.email, email)) {
    return account || {};
  }

  return {
    ...DEFAULT_SETTINGS.userAccount
  };
}

function mergeSettings(rawSettings) {
  const merged = {
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

  merged.backendBaseUrl = normalizeBaseUrl(merged.backendBaseUrl);
  merged.userAccount.email = String(merged.userAccount.email || "").trim().toLowerCase();
  merged.userAccount.name = String(merged.userAccount.name || "").trim();
  return merged;
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

function getPlanLimit(account, key) {
  const limits = account?.limits || {};
  const value = limits[key];
  return value == null ? null : Number(value);
}

function getRemaining(limit, used) {
  if (limit == null) return null;
  return Math.max(0, Number(limit) - Number(used || 0));
}

function formatUsageLine(label, used, limit) {
  if (limit == null) {
    return `${label}: ${used} used • Unlimited`;
  }
  return `${label}: ${used}/${limit} used • ${getRemaining(limit, used)} left`;
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
  const backendBaseUrl = normalizeBaseUrl(document.getElementById("backendBaseUrl").value);
  const meetingNotesStyle = document.getElementById("meetingNotesStyle").value;
  const accountName = document.getElementById("accountName").value.trim();
  const accountEmail = document.getElementById("accountEmail").value.trim().toLowerCase();

  const requiredSections = parseLines(document.getElementById("requiredSections").value);
  const requiredKeywords = parseLines(document.getElementById("requiredKeywords").value);
  const prohibitedWords = parseLines(document.getElementById("prohibitedWords").value);
  const captureInputValues = document.getElementById("captureInputValues").checked;

  const settings = mergeSettings({
    ...existing,
    backendBaseUrl,
    meetingNotesStyle: meetingNotesStyle || "professional_bullets",
    captureInputValues,
    auditRules: {
      required_sections: requiredSections,
      required_keywords: requiredKeywords,
      prohibited_words: prohibitedWords
    },
    userAccount: {
        ...getResetOrExistingAccount(existing.userAccount, accountEmail),
        name: accountName,
        email: accountEmail
    }
  });

  await storageSet({ continuum_settings: settings });
  document.getElementById("status").textContent = "Settings saved.";
  renderAccountStatus(settings.userAccount);
  await refreshAiStatus();
}

async function connectAccount() {
  const existing = await getSavedSettings();
  const backendBaseUrl = normalizeBaseUrl(document.getElementById("backendBaseUrl").value);
  const name = document.getElementById("accountName").value.trim();
  const email = document.getElementById("accountEmail").value.trim().toLowerCase();
  const statusEl = document.getElementById("accountStatusText");

  if (!email) {
    statusEl.textContent = "Enter an email first.";
    return;
  }

  statusEl.textContent = "Connecting beta account...";

  try {
    const user = await bootstrapAccount(backendBaseUrl, {
        email,
        name,
        user_id: getReusableUserId(existing.userAccount, email)
    });

    const settings = mergeSettings({
        ...existing,
        backendBaseUrl,
        userAccount: {
            ...DEFAULT_SETTINGS.userAccount,
            ...user,
            email: user.email || email,
            name: user.name || name,
            usage: user.usage || {}
        }
    });

    await storageSet({ continuum_settings: settings });
    document.getElementById("backendBaseUrl").value = backendBaseUrl;
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
  const backendBaseUrl = normalizeBaseUrl(document.getElementById("backendBaseUrl").value);
  const account = existing.userAccount || DEFAULT_SETTINGS.userAccount;

  if (!account.user_id && !account.email) {
    renderAccountStatus(account);
    return;
  }

  try {
    let user = null;

    if (account.email) {
      user = await bootstrapAccount(backendBaseUrl, account);
    } else if (account.user_id) {
      const response = await fetchJson(
        `${backendBaseUrl}/users/status?user_id=${encodeURIComponent(account.user_id)}`
      );
      user = response.user || null;
    }

    if (!user) {
      throw new Error("Could not load account status.");
    }

    const settings = mergeSettings({
      ...existing,
      backendBaseUrl,
      userAccount: {
        ...(existing.userAccount || {}),
        ...user,
        email: user.email || account.email,
        name: user.name || account.name,
        usage: mergeUsageCounts(account.usage || {}, user.usage || {})
      }
    });

    await storageSet({ continuum_settings: settings });
    document.getElementById("backendBaseUrl").value = backendBaseUrl;
    document.getElementById("accountName").value = settings.userAccount.name || "";
    document.getElementById("accountEmail").value = settings.userAccount.email || "";
    renderAccountStatus(settings.userAccount);
  } catch (error) {
    renderAccountStatus(account);
    document.getElementById("accountStatusText").textContent =
      `${document.getElementById("accountStatusText").textContent} • Could not refresh from backend`;
  }
}

async function requestUpgrade() {
  const settings = await getSavedSettings();
  const account = settings.userAccount || DEFAULT_SETTINGS.userAccount;

  if (!account.email && !account.user_id) {
    document.getElementById("status").textContent = "Connect a beta account first.";
    return;
  }

  await chrome.tabs.create({
    url: chrome.runtime.getURL("upgrade.html")
  });
}

async function bootstrapAccount(backendBaseUrl, account) {
  const response = await fetchJson(`${backendBaseUrl}/users/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: String(account.email || "").trim().toLowerCase(),
      name: String(account.name || "").trim(),
      user_id: String(account.user_id || "").trim()
    })
  });

  if (!response.user) {
    throw new Error("Could not connect account.");
  }

  return response.user;
}

function renderAccountStatus(account) {
  const statusEl = document.getElementById("accountStatusText");
  const usageEl = document.getElementById("accountUsageText");
  const limitEl = document.getElementById("accountLimitText");
  const upgradeBtn = document.getElementById("requestUpgradeBtn");

  const safeAccount = {
    ...DEFAULT_SETTINGS.userAccount,
    ...(account || {})
  };

  if (!safeAccount.user_id && !safeAccount.email) {
    statusEl.textContent = "No beta account connected yet.";
    usageEl.textContent = "";
    limitEl.textContent = "";
    upgradeBtn.style.display = "none";
    return;
  }

  const usage = safeAccount.usage || {};
  const docs = Number(usage.documents_generated || 0);
  const shots = Number(usage.screenshots_saved || 0);
  const meetings = Number(usage.meetings_uploaded || 0);
  const externalDocs = Number(usage.external_docs_generated || 0);

  const docsLimit = getPlanLimit(safeAccount, "documents_generated");
  const shotsLimit = getPlanLimit(safeAccount, "screenshots_saved");
  const meetingsLimit = getPlanLimit(safeAccount, "meetings_uploaded");
  const externalDocsLimit = getPlanLimit(safeAccount, "external_docs_generated");

  statusEl.textContent = `Connected as ${safeAccount.name || safeAccount.email || "beta user"} • Plan: ${safeAccount.plan || "free"}`;

  usageEl.textContent = [
    formatUsageLine("Docs", docs, docsLimit),
    formatUsageLine("Screenshots", shots, shotsLimit),
    formatUsageLine("Meetings", meetings, meetingsLimit),
    formatUsageLine("External docs", externalDocs, externalDocsLimit),
  ].join(" • ");

  if ((safeAccount.plan || "free") === "paid") {
    limitEl.textContent = "Paid plan active. Current beta setup uses unlimited usage.";
    upgradeBtn.style.display = "none";
  } else {
    limitEl.textContent = "Free plan includes limited docs, screenshots, meetings, and external docs. Upgrade when you need more.";
    upgradeBtn.style.display = "inline-flex";
  }
}

async function refreshAiStatus() {
  const statusEl = document.getElementById("aiStatusText");
  const backendBaseUrl = normalizeBaseUrl(document.getElementById("backendBaseUrl").value);
  statusEl.textContent = "Checking backend AI configuration...";

  try {
    const data = await fetchJson(`${backendBaseUrl}/config/status`);
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

function fetchJson(url, options = {}) {
  return fetch(url, options).then(async (response) => {
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      throw new Error(data.detail || data.error || `Request failed: ${response.status}`);
    }
    return data;
  });
}

function storageGet(key) { return new Promise((resolve) => chrome.storage.sync.get(key, resolve)); }
function storageSet(value) { return new Promise((resolve) => chrome.storage.sync.set(value, resolve)); }