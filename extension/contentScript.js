/*
  CONTENT SCRIPT

  WHAT THIS FILE DOES:
  1. Runs inside webpages
  2. Watches user interactions
  3. Sends normalized actions to the background script

*/

(function initContinuumContentScript() {
  /*
    Send one page_view event when the script starts.
    WHY:
    This gives the backend context about which page the workflow started on.
  */
  sendAction({
    kind: "page_view",
    targetLabel: document.title || "Untitled Page",
    targetSelector: "document",
    pageUrl: window.location.href,
    pageTitle: document.title || ""
  });

  /*
    Capture clicks.
    WHY:
    Clicks are the clearest signal for procedural user behavior.
  */
  document.addEventListener(
    "click",
    (event) => {
      const element = event.target && event.target.closest
        ? event.target.closest("button, a, input, select, textarea, [role='button'], label, div, span")
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

  /*
    Capture change events on inputs.
    WHY:
    Documentation often needs to mention what fields were edited,
    but we avoid capturing sensitive values by default.
  */
  document.addEventListener(
    "change",
    (event) => {
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

  /*
    Capture form submit events.
    WHY:
    Submit is usually the strongest signal that a workflow step is complete.
  */
  document.addEventListener(
    "submit",
    (event) => {
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
    Normalize timestamp before sending.
    WHY:
    The backend needs timing to reduce duplicates and group nearby actions.
  */
  chrome.runtime.sendMessage({
    type: "CAPTURE_ACTION",
    payload: {
      ...action,
      timestamp: Date.now()
    }
  });
}

function matchesFormField(element) {
  const tag = (element.tagName || "").toLowerCase();
  return tag === "input" || tag === "select" || tag === "textarea";
}

function getSafeValuePreview(element) {
  /*
    Avoid leaking sensitive values.
    WHY:
    This extension should help document processes, not collect secrets.
  */
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
  /*
    Build a human-readable label.
    WHY:
    The generated documentation should describe user actions in plain language.
  */
  const aria = element.getAttribute && element.getAttribute("aria-label");
  if (aria) return aria.trim();

  const placeholder = element.getAttribute && element.getAttribute("placeholder");
  if (placeholder) return placeholder.trim();

  const name = element.getAttribute && element.getAttribute("name");
  if (name) return name.trim();

  const id = element.getAttribute && element.getAttribute("id");
  if (id) return id.trim();

  const text = (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ");
  if (text) return text.slice(0, 80);

  return (element.tagName || "element").toLowerCase();
}

function getSimpleSelector(element) {
  /*
    Create a small selector-like hint.
    WHY:
    This helps distinguish actions on similar elements without building
    a fragile full DOM path.
  */
  const tag = (element.tagName || "").toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const classNames =
    element.className && typeof element.className === "string"
      ? "." + element.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";

  return `${tag}${id}${classNames}` || "unknown";
}