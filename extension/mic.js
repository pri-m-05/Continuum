document.getElementById("grantBtn").addEventListener("click", async () => {
  const status = document.getElementById("status");
  status.textContent = "Requesting microphone permission...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((t) => t.stop());

    chrome.storage.local.set({ continuum_mic_primed: true }, () => {
      chrome.runtime.sendMessage({ type: "MIC_PERMISSION_PRIMED", payload: { primed: true } }, () => {
        status.textContent = "Microphone permission granted ✅ You can close this tab.";
      });
    });
  } catch (e) {
    chrome.storage.local.set({ continuum_mic_primed: false }, () => {
      chrome.runtime.sendMessage({ type: "MIC_PERMISSION_PRIMED", payload: { primed: false } }, () => {
        status.textContent = `Denied ❌ (${e.message}).`;
      });
    });
  }
});
