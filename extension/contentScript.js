/*
  CONTENT SCRIPT

  WHAT THIS FILE DOES
  1. Runs inside webpages
  2. Watches user interactions
  3. Sends normalized actions to the background script
  4. Safely ignores expected runtime errors after extension reloads
  5. Renders the guided-run overlay when a saved document is being replayed
*/

let continuumExtensionAlive = true;
let currentGuideState = null;
let guideRoot = null;
let guideHighlight = null;
let guideArrow = null;
let guidePositionFrame = null;
let guideLastUrl = window.location.href;

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
      if (isGuideUiTarget(event.target)) return;

      const element =
        event.target && event.target.closest
          ? event.target.closest(
              "button, a, input, select, textarea, [role='button'], label, div, span"
            )
          : null;

      if (!element) return;

      handleGuideInteraction("click", element, event.target);

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
      if (isGuideUiTarget(event.target)) return;

      const element = event.target;
      if (!element || !matchesFormField(element)) return;

      handleGuideInteraction("change", element, event.target);

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
      if (isGuideUiTarget(event.target)) return;

      const form = event.target;
      if (!form) return;

      handleGuideInteraction("submit", form, event.target);

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

  window.addEventListener("load", syncGuidedRunStateFromBackground);
  window.addEventListener("resize", scheduleGuidePositionUpdate);
  window.addEventListener("scroll", scheduleGuidePositionUpdate, true);
  window.setInterval(checkForGuideUrlChange, 700);

  syncGuidedRunStateFromBackground();
})();

function sendAction(action) {
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

function isGuideUiTarget(target) {
  return !!(target && target.closest && target.closest("[data-continuum-guide-ui='1']"));
}

async function syncGuidedRunStateFromBackground() {
  if (!canUseExtensionRuntime()) return;

  try {
    const response = await sendRuntimeMessage({ type: "GET_GUIDED_RUN_STATE" });
    applyGuidedRunState(response.guidedRun || null, { recovering: window.location.href !== guideLastUrl });
    guideLastUrl = window.location.href;
  } catch (_) {
    applyGuidedRunState(null);
  }
}

function applyGuidedRunState(state, opts = {}) {
  currentGuideState = state;

  if (!state || !state.currentStep) {
    destroyGuideUi();
    return;
  }

  ensureGuideUi();
  renderGuideCard(state, opts);
  highlightCurrentGuideTarget(opts);
}

function ensureGuideUi() {
  if (guideRoot) return;

  guideRoot = document.createElement("div");
  guideRoot.setAttribute("data-continuum-guide-ui", "1");
  guideRoot.id = "continuum-guide-root";
  guideRoot.innerHTML = `
    <style>
      #continuum-guide-root {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483646;
        width: min(360px, calc(100vw - 32px));
        font-family: Arial, sans-serif;
        color: #18141f;
      }
      .continuum-guide-card {
        background: rgba(255,255,255,0.98);
        border: 1px solid #e7defb;
        border-radius: 18px;
        box-shadow: 0 16px 42px rgba(30, 23, 58, 0.2);
        backdrop-filter: blur(12px);
        overflow: hidden;
      }
      .continuum-guide-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px 10px;
        border-bottom: 1px solid #f0eafb;
        cursor: move;
      }
      .continuum-guide-close {
        border: none;
        background: transparent;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 18px;
        color: #5b4a91;
        flex: 0 0 auto;
      }
      .continuum-guide-close:hover {
        background: #f5f0ff;
      }
      .continuum-guide-headcopy {
        min-width: 0;
      }
      .continuum-guide-title {
        font-size: 13px;
        font-weight: 700;
        color: #5b4a91;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 4px;
      }
      .continuum-guide-subtitle {
        font-size: 14px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .continuum-guide-body {
        padding: 14px;
        display: grid;
        gap: 12px;
      }
      .continuum-guide-step {
        font-size: 12px;
        color: #5f5a6b;
      }
      .continuum-guide-instruction {
        font-size: 16px;
        line-height: 1.45;
        font-weight: 700;
      }
      .continuum-guide-status {
        font-size: 13px;
        line-height: 1.45;
        color: #4d4561;
        background: #f8f5ff;
        border: 1px solid #eee7fb;
        border-radius: 12px;
        padding: 10px 12px;
      }
      .continuum-guide-status.warn {
        background: #fff7eb;
        border-color: #f3dbad;
        color: #725000;
      }
      .continuum-guide-shot {
        width: 100%;
        display: none;
        border-radius: 14px;
        border: 1px solid #eee7fb;
        max-height: 170px;
        object-fit: cover;
      }
      .continuum-guide-shot.visible {
        display: block;
      }
      .continuum-guide-actions {
        display: flex;
        gap: 8px;
      }
      .continuum-guide-actions button {
        flex: 1 1 0;
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 13px;
        cursor: pointer;
        border: 1px solid #d9d0ef;
        background: #fff;
        color: #241f31;
      }
      .continuum-guide-actions button:hover {
        background: #faf7ff;
      }
      #continuum-guide-highlight {
        position: fixed;
        z-index: 2147483644;
        pointer-events: none;
        border: 3px solid #7c3aed;
        border-radius: 14px;
        box-shadow: 0 0 0 7px rgba(124, 58, 237, 0.18);
        animation: continuumGuidePulse 1.5s ease-in-out infinite;
      }
      #continuum-guide-arrow {
        position: fixed;
        z-index: 2147483645;
        pointer-events: none;
        background: #7c3aed;
        color: white;
        border-radius: 999px;
        padding: 8px 12px;
        font-size: 13px;
        font-weight: 700;
        box-shadow: 0 10px 24px rgba(124, 58, 237, 0.28);
        white-space: nowrap;
      }
      @keyframes continuumGuidePulse {
        0%, 100% { box-shadow: 0 0 0 7px rgba(124, 58, 237, 0.18); }
        50% { box-shadow: 0 0 0 11px rgba(124, 58, 237, 0.10); }
      }
    </style>
    <div class="continuum-guide-card">
      <div class="continuum-guide-header" id="continuumGuideDragHandle">
        <button class="continuum-guide-close" id="continuumGuideExitBtn" title="Exit guided run">×</button>
        <div class="continuum-guide-headcopy">
          <div class="continuum-guide-title">Guided Run</div>
          <div class="continuum-guide-subtitle" id="continuumGuideDocTitle"></div>
        </div>
      </div>
      <div class="continuum-guide-body">
        <div class="continuum-guide-step" id="continuumGuideStepMeta"></div>
        <div class="continuum-guide-instruction" id="continuumGuideInstruction"></div>
        <div class="continuum-guide-status" id="continuumGuideStatus"></div>
        <img class="continuum-guide-shot" id="continuumGuideScreenshot" alt="Guide step screenshot" />
        <div class="continuum-guide-actions">
          <button id="continuumGuideBackBtn">Back</button>
          <button id="continuumGuideNextBtn">Next</button>
        </div>
      </div>
    </div>
  `;

  document.documentElement.appendChild(guideRoot);

  guideHighlight = document.createElement("div");
  guideHighlight.id = "continuum-guide-highlight";
  document.documentElement.appendChild(guideHighlight);

  guideArrow = document.createElement("div");
  guideArrow.id = "continuum-guide-arrow";
  guideArrow.textContent = "Next click →";
  document.documentElement.appendChild(guideArrow);

  guideRoot.querySelector("#continuumGuideExitBtn").addEventListener("click", exitGuidedRun);
  guideRoot.querySelector("#continuumGuideBackBtn").addEventListener("click", () => moveGuideStep(-1));
  guideRoot.querySelector("#continuumGuideNextBtn").addEventListener("click", () => moveGuideStep(1));
  initGuideDrag(guideRoot.querySelector(".continuum-guide-card"), guideRoot.querySelector("#continuumGuideDragHandle"));
}

function destroyGuideUi() {
  currentGuideState = null;
  if (guideRoot) guideRoot.remove();
  if (guideHighlight) guideHighlight.remove();
  if (guideArrow) guideArrow.remove();
  guideRoot = null;
  guideHighlight = null;
  guideArrow = null;
}

function initGuideDrag(card, handle) {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  handle.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    dragging = true;
    const rect = card.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    card.style.position = "fixed";
    card.style.left = `${rect.left}px`;
    card.style.top = `${rect.top}px`;
    card.style.right = "auto";
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    card.style.left = `${Math.max(8, event.clientX - offsetX)}px`;
    card.style.top = `${Math.max(8, event.clientY - offsetY)}px`;
  });

  const stopDrag = (event) => {
    dragging = false;
    if (event && handle.hasPointerCapture && handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  };

  handle.addEventListener("pointerup", stopDrag);
  handle.addEventListener("pointercancel", stopDrag);
}

function renderGuideCard(state, opts = {}) {
  const currentStep = state.currentStep || {};
  guideRoot.querySelector("#continuumGuideDocTitle").textContent = state.documentTitle || "Guided Run";
  guideRoot.querySelector("#continuumGuideStepMeta").textContent = `Step ${state.currentIndex + 1} of ${state.totalSteps}`;
  guideRoot.querySelector("#continuumGuideInstruction").textContent = currentStep.instruction || "Follow the highlighted step.";

  const statusEl = guideRoot.querySelector("#continuumGuideStatus");
  const screenshotEl = guideRoot.querySelector("#continuumGuideScreenshot");

  let statusText = "Highlighting the expected action on the page.";
  let warn = false;

  if (opts.offPath) {
    statusText = "You may no longer be following the guide. The expected step is still highlighted.";
    warn = true;
  } else if (opts.missingTarget) {
    statusText = "Couldn't find the expected element on this page. Use the screenshot for reference or continue manually.";
    warn = true;
  } else if (opts.recovering) {
    statusText = "Page changed. Trying to relocate the next guided step...";
  }

  statusEl.textContent = statusText;
  statusEl.classList.toggle("warn", warn);

  if ((opts.missingTarget || opts.recovering) && currentStep.screenshot_url) {
    screenshotEl.src = currentStep.screenshot_url;
    screenshotEl.classList.add("visible");
  } else {
    screenshotEl.removeAttribute("src");
    screenshotEl.classList.remove("visible");
  }

  guideRoot.querySelector("#continuumGuideBackBtn").disabled = state.currentIndex <= 0;
  guideRoot.querySelector("#continuumGuideNextBtn").disabled = state.currentIndex >= state.totalSteps - 1;
}

function highlightCurrentGuideTarget(opts = {}) {
  if (!currentGuideState?.currentStep || !guideHighlight || !guideArrow) return;

  const target = findGuideTarget(currentGuideState.currentStep);
  if (!target) {
    guideHighlight.style.display = "none";
    guideArrow.style.display = "none";
    renderGuideCard(currentGuideState, { ...opts, missingTarget: true });
    return;
  }

  target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  updateGuideHighlight(target);
  renderGuideCard(currentGuideState, opts);
}

function findGuideTarget(step) {
  const selector = (step.target_selector || "").trim();
  if (selector) {
    try {
      const direct = document.querySelector(selector);
      if (direct) return direct;
    } catch (_) {}
  }

  const label = normalizeGuideText(step.target_label || step.input_name || "");
  if (!label) return null;

  const candidates = Array.from(document.querySelectorAll("button, a, input, select, textarea, label, [role='button']"));
  for (const candidate of candidates) {
    const candidateText = normalizeGuideText(getElementLabel(candidate));
    if (!candidateText) continue;
    if (candidateText === label || candidateText.includes(label) || label.includes(candidateText)) {
      return candidate;
    }
  }

  return null;
}

function normalizeGuideText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function updateGuideHighlight(target) {
  if (!guideHighlight || !guideArrow) return;
  const rect = target.getBoundingClientRect();
  guideHighlight.style.display = "block";
  guideHighlight.style.top = `${Math.max(6, rect.top - 6)}px`;
  guideHighlight.style.left = `${Math.max(6, rect.left - 6)}px`;
  guideHighlight.style.width = `${Math.max(20, rect.width + 12)}px`;
  guideHighlight.style.height = `${Math.max(20, rect.height + 12)}px`;

  guideArrow.style.display = "block";
  const arrowTop = Math.max(8, rect.top - 44);
  const arrowLeft = Math.max(8, Math.min(window.innerWidth - 150, rect.left));
  guideArrow.style.top = `${arrowTop}px`;
  guideArrow.style.left = `${arrowLeft}px`;
}

function scheduleGuidePositionUpdate() {
  if (!currentGuideState?.currentStep) return;
  if (guidePositionFrame) cancelAnimationFrame(guidePositionFrame);
  guidePositionFrame = requestAnimationFrame(() => {
    const target = findGuideTarget(currentGuideState.currentStep);
    if (target) updateGuideHighlight(target);
  });
}

function handleGuideInteraction(kind, matchedElement) {
  if (!currentGuideState?.currentStep) return;

  const currentStep = currentGuideState.currentStep;
  const expectedTarget = findGuideTarget(currentStep);
  const kindMatches = (currentStep.action_kind || "click") === kind;
  const targetMatches = expectedTarget && (matchedElement === expectedTarget || expectedTarget.contains(matchedElement));

  if (kindMatches && targetMatches) {
    moveGuideStep(1);
    return;
  }

  renderGuideCard(currentGuideState, { offPath: true });
}

async function moveGuideStep(delta) {
  if (!currentGuideState) return;

  try {
    const response = await sendRuntimeMessage({ type: "GUIDED_RUN_STEP", payload: { delta } });
    const nextState = response.guidedRun || null;
    if (!nextState) {
      destroyGuideUi();
      return;
    }

    currentGuideState = nextState;
    const targetUrl = currentGuideState.currentStep?.page_url || "";
    const currentUrl = window.location.href;
    if (targetUrl && stripHash(targetUrl) !== stripHash(currentUrl)) {
      renderGuideCard(currentGuideState, { recovering: true });
      window.location.href = targetUrl;
      return;
    }

    highlightCurrentGuideTarget();
  } catch (_) {}
}

async function exitGuidedRun() {
  try {
    await sendRuntimeMessage({ type: "EXIT_GUIDED_RUN" });
  } catch (_) {}
  destroyGuideUi();
}

function stripHash(url) {
  return String(url || "").split("#")[0];
}

async function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error("No response from background."));
      if (response.ok === false && response.error) return reject(new Error(response.error));
      resolve(response);
    });
  });
}

function checkForGuideUrlChange() {
  if (!currentGuideState) return;
  if (window.location.href === guideLastUrl) return;
  guideLastUrl = window.location.href;
  syncGuidedRunStateFromBackground();
}