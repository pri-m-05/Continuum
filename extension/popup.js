function isUpgradeLimitError(message) {
  return /Free plan limit reached/i.test(String(message || ""));
}

async function openUpgradePage(reason = "") {
  await sendMessage({
    type: "OPEN_UPGRADE_PAGE",
    payload: { reason }
  });
  window.close();
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("openWorkspaceBtn").addEventListener("click", openWorkspaceFromPopup);
  document.getElementById("openLibraryBtn").addEventListener("click", () =>
    sendMessage({ type: "OPEN_LIBRARY" })
  );
  document.getElementById("openSettingsBtn").addEventListener("click", () =>
    sendMessage({ type: "OPEN_OPTIONS_PAGE" })
  );

  document.getElementById("startMeetingBtn").addEventListener("click", handleStartMeeting);
  document.getElementById("stopMeetingBtn").addEventListener("click", handleStopMeeting);

  await checkBackend();
  await refreshMeetingStatus();
});

async function openWorkspaceFromPopup() {
  try {
    const activeTab = await getActiveTab();
    if (!activeTab || typeof activeTab.windowId !== "number") {
      throw new Error("No active Chrome window was found.");
    }

    if (!chrome.sidePanel || !chrome.sidePanel.open) {
      throw new Error("This Chrome build does not expose the Side Panel API here.");
    }

    // Global panel for the current window
    await chrome.sidePanel.setOptions({
      path: "sidepanel.html",
      enabled: true
    });

    await chrome.sidePanel.open({
      windowId: activeTab.windowId
    });

    window.close();
  } catch (error) {
    // Fallback to background if direct open fails
    try {
      const res = await sendMessage({ type: "OPEN_WORKSPACE" });
      if (!res.ok) {
        throw new Error(res.error || "Could not open workspace.");
      }
      window.close();
    } catch (fallbackError) {
      alert(`Could not open side panel: ${fallbackError.message}`);
    }
  }
}

async function checkBackend() {
  const statusEl = document.getElementById("status");
  try {
    const res = await sendMessage({ type: "PING_BACKEND" });
    statusEl.textContent = res.ok
      ? "Backend connected."
      : "Backend responded unexpectedly.";
  } catch (e) {
    statusEl.textContent = `Backend error: ${e.message}`;
  }
}

async function refreshMeetingStatus() {
  try {
    const res = await sendMessage({ type: "GET_MEETING_STATUS" });
    document.getElementById("meetingStatus").textContent =
      `Meeting status: ${res.status || "idle"}`;
  } catch (e) {
    document.getElementById("meetingStatus").textContent =
      `Meeting status error: ${e.message}`;
  }
}

async function handleStartMeeting() {
  try {
    await sendMessage({ type: "START_MEETING_CAPTURE" });
    await refreshMeetingStatus();
  } catch (e) {
    if (isUpgradeLimitError(e.message)) {
      await openUpgradePage(e.message);
      return;
    }

    alert(e.message);
  }
}

async function handleStopMeeting() {
  try {
    await sendMessage({ type: "STOP_MEETING_CAPTURE" });
    await refreshMeetingStatus();
  } catch (e) {
    alert(e.message);
  }
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs.length ? tabs[0] : null);
    });
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!response) {
        return reject(new Error("No response from background."));
      }
      if (response.ok === false && response.error) {
        return reject(new Error(response.error));
      }
      resolve(response);
    });
  });
}