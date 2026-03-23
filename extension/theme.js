(() => {
  const THEME_KEY = "continuum_ui_theme";

  function applyTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    return next;
  }

  function getStoredTheme() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== "undefined" && chrome.storage?.sync) {
          chrome.storage.sync.get(THEME_KEY, (res) => {
            resolve(res?.[THEME_KEY] || "dark");
          });
          return;
        }
      } catch (_) {}
      resolve(localStorage.getItem(THEME_KEY) || "dark");
    });
  }

  function setStoredTheme(theme) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.sync) {
        chrome.storage.sync.set({ [THEME_KEY]: theme });
      } else {
        localStorage.setItem(THEME_KEY, theme);
      }
    } catch (_) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (_) {}
    }
  }

  function updateToggleButtons(theme) {
    document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
      btn.textContent = theme === "dark" ? "☀" : "☾";
      btn.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
      btn.setAttribute("title", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    });
  }

  async function bootTheme() {
    const theme = applyTheme(await getStoredTheme());
    updateToggleButtons(theme);

    document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
      if (btn.dataset.themeBound === "1") return;
      btn.dataset.themeBound = "1";

      btn.addEventListener("click", async () => {
        const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
        const next = current === "dark" ? "light" : "dark";
        applyTheme(next);
        setStoredTheme(next);
        updateToggleButtons(next);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootTheme);
  } else {
    bootTheme();
  }
})();