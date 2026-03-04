/*
  CONTENT SCRIPT

  WHAT THIS FILE DOES
  1. Runs inside webpages
  2. Watches user interactions
  3. Sends normalized actions to the background script
  4. Safely ignores expected runtime errors after extension reloads

*/

let continuumExtensionAlive = true;

(function initContinuumContentScript() {
  if (!canUseExtensionRuntime()) {
    continuumExtensionAlive = false;
    return;
  }

  sendAction({
    kind: "page_view",
    targetLabel: document.title || "Untitled Page",
    targetSelector: "document",
    pageUrl: window.location.href,
    pageTitle: document.title || ""
  });

  document.addEventListener(
    "click",
    (event) => {
      if (!continuumExtensionAlive) return;

      const element =
        event.target && event.target.closest
          ? event.target.closest(
              "button, a, input, select, textarea, [role='button'], label, div, span"
            )
          : null;

      if (!element) return;

      sendAction({
        kind: "click",
        targetLabel: getElementLabel(element),
        targetSelector: getSimpleSelector(element),
        pageUrl: window.location.href,
        pageTitle: document.title || ""
      });
    },
    true
  );

  document.addEventListener(
    "change",
    (event) => {
      if (!continuumExtensionAlive) return;

      const element = event.target;
      if (!element || !matchesFormField(element)) return;

      sendAction({
        kind: "change",
        targetLabel: getElementLabel(element),
        targetSelector: getSimpleSelector(element),
        inputName: element.name || "",
        inputType: element.type || element.tagName.toLowerCase(),
        valuePreview: getSafeValuePreview(element),
        pageUrl: window.location.href,
        pageTitle: document.title || ""
      });
    },
    true
  );

  document.addEventListener(
    "submit",
    (event) => {
      if (!continuumExtensionAlive) return;

      const form = event.target;
      if (!form) return;

      sendAction({
        kind: "submit",
        targetLabel: getElementLabel(form),
        targetSelector: getSimpleSelector(form),
        pageUrl: window.location.href,
        pageTitle: document.title || ""
      });
    },
    true
  );
})();

function sendAction(action) {
  /*
    WHY THIS IS WRAPPED
    After an unpacked extension reload, older content scripts can still be present
    in existing tabs for a moment. We do not want noisy runtime errors every time
    they try to send a message.
  */
  if (!canUseExtensionRuntime()) {
    continuumExtensionAlive = false;
    return;
  }

  try {
    chrome.runtime.sendMessage(
      {
        type: "CAPTURE_ACTION",
        payload: {
          ...action,
          timestamp: Date.now()
        }
      },
      () => {
        const err = chrome.runtime.lastError;
        if (!err) return;

        const msg = String(err.message || "");
        if (
          msg.includes("Extension context invalidated") ||
          msg.includes("Receiving end does not exist") ||
          msg.includes("The message port closed before a response was received")
        ) {
          continuumExtensionAlive = false;
          return;
        }

        console.warn("Continuum contentScript sendMessage error:", msg);
      }
    );
  } catch (error) {
    const msg = String(error && error.message ? error.message : error);
    if (msg.includes("Extension context invalidated")) {
      continuumExtensionAlive = false;
      return;
    }
    console.warn("Continuum contentScript unexpected error:", msg);
  }
}

function canUseExtensionRuntime() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
  } catch (error) {
    return false;
  }
}

function matchesFormField(element) {
  const tag = (element.tagName || "").toLowerCase();
  return tag === "input" || tag === "select" || tag === "textarea";
}

function getSafeValuePreview(element) {
  const type = (element.type || "").toLowerCase();
  const forbiddenTypes = ["password", "email", "hidden", "tel", "number"];

  if (forbiddenTypes.includes(type)) {
    return "";
  }

  if (element.tagName && element.tagName.toLowerCase() === "select") {
    return element.value ? `[selected:${String(element.value).slice(0, 30)}]` : "";
  }

  if (typeof element.value === "string" && element.value.trim()) {
    return `[entered:${element.value.trim().slice(0, 30)}]`;
  }

  return "";
}

function getElementLabel(element) {
  const aria = element.getAttribute && element.getAttribute("aria-label");
  if (aria) return aria.trim();

  const placeholder = element.getAttribute && element.getAttribute("placeholder");
  if (placeholder) return placeholder.trim();

  const name = element.getAttribute && element.getAttribute("name");
  if (name) return name.trim();

  const id = element.getAttribute && element.getAttribute("id");
  if (id) return id.trim();

  const text = (element.innerText || element.textContent || "")
    .trim()
    .replace(/\s+/g, " ");
  if (text) return text.slice(0, 80);

  return (element.tagName || "element").toLowerCase();
}

function getSimpleSelector(element) {
  const tag = (element.tagName || "").toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const classNames =
    element.className && typeof element.className === "string"
      ? "." + element.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";

  return `${tag}${id}${classNames}` || "unknown";
}