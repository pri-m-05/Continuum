const UPGRADE_CONTACT_EMAIL = "pmamman@uwaterloo.ca";

const DEFAULT_SETTINGS = {
  userAccount: {
    user_id: "",
    email: "",
    name: "",
    plan: "free",
    usage: {},
    limits: {}
  }
};

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("requestUpgradeBtn").addEventListener("click", requestUpgrade);
  document.getElementById("openSettingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

  await loadUpgradePage();
});

async function loadUpgradePage() {
  const result = await storageGet("continuum_settings");
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(result.continuum_settings || {}),
    userAccount: {
      ...DEFAULT_SETTINGS.userAccount,
      ...((result.continuum_settings || {}).userAccount || {})
    }
  };

  const account = settings.userAccount || DEFAULT_SETTINGS.userAccount;
  const usage = account.usage || {};
  const limits = account.limits || {};
  const reason = new URLSearchParams(window.location.search).get("reason") || "";

  document.getElementById("reasonText").textContent =
    reason || "Compare plans and request an upgrade.";

  document.getElementById("currentPlanText").textContent =
    `Current plan: ${account.plan || "free"} • ${account.name || account.email || "beta user"}`;

  document.getElementById("currentUsageText").textContent =
    [
      formatUsageLine("Docs", usage.documents_generated, limits.documents_generated),
      formatUsageLine("Screenshots", usage.screenshots_saved, limits.screenshots_saved),
      formatUsageLine("Meetings", usage.meetings_uploaded, limits.meetings_uploaded),
      formatUsageLine("External docs", usage.external_docs_generated, limits.external_docs_generated),
    ].join(" • ");
}

function formatUsageLine(label, used = 0, limit = null) {
  const safeUsed = Number(used || 0);
  if (limit == null) return `${label}: ${safeUsed} used • Unlimited`;
  return `${label}: ${safeUsed}/${Number(limit)} used`;
}

async function requestUpgrade() {
  const result = await storageGet("continuum_settings");
  const settings = result.continuum_settings || {};
  const account = settings.userAccount || DEFAULT_SETTINGS.userAccount;
  const reason = new URLSearchParams(window.location.search).get("reason") || "";
  const status = document.getElementById("upgradeStatus");

  if (!UPGRADE_CONTACT_EMAIL || UPGRADE_CONTACT_EMAIL.includes("replace-with-your-email")) {
    status.textContent = "Set UPGRADE_CONTACT_EMAIL in upgrade.js first.";
    return;
  }

  if (!account.email && !account.user_id) {
    status.textContent = "Connect a beta account first in Settings.";
    return;
  }

  const usage = account.usage || {};
  const subject = encodeURIComponent(`Continuum upgrade request - ${account.email || account.user_id || "beta-user"}`);
  const body = encodeURIComponent(
`Hi,

I'd like to request a Continuum paid upgrade.

Name: ${account.name || ""}
Email: ${account.email || ""}
User ID: ${account.user_id || ""}

Current plan: ${account.plan || "free"}
Reason:
${reason || "Reached a free plan limit and would like to continue."}

Usage:
- Docs: ${Number(usage.documents_generated || 0)}
- Screenshots: ${Number(usage.screenshots_saved || 0)}
- Meetings: ${Number(usage.meetings_uploaded || 0)}
- External docs: ${Number(usage.external_docs_generated || 0)}

Thanks.`
  );

  window.location.href = `mailto:${UPGRADE_CONTACT_EMAIL}?subject=${subject}&body=${body}`;
}

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.sync.get(key, resolve));
}