const hoverSpeedInput = document.getElementById("hover-speed");
const adjustmentStepInput = document.getElementById("adjustment-step");
const overlayIdleHideDelayInput = document.getElementById("overlay-idle-hide-delay");
const decreaseHoverButton = document.getElementById("decrease-hover");
const increaseHoverButton = document.getElementById("increase-hover");
const decreaseStepButton = document.getElementById("decrease-step");
const increaseStepButton = document.getElementById("increase-step");
const decreaseOverlayIdleHideDelayButton = document.getElementById("decrease-overlay-idle-hide-delay");
const increaseOverlayIdleHideDelayButton = document.getElementById("increase-overlay-idle-hide-delay");
const showHoverSlowZoneHintInput = document.getElementById("show-hover-slow-zone-hint");
const showDownieInput = document.getElementById("show-downie");
const showReaderInput = document.getElementById("show-reader");
const readerTokenInput = document.getElementById("reader-token");
const saveTokenButton = document.getElementById("save-token");
const status = document.getElementById("status");
const DEFAULT_HOVER_SPEED = 1;
const DEFAULT_ADJUSTMENT_STEP = 0.1;
const DEFAULT_OVERLAY_IDLE_HIDE_DELAY = 2;
const DEFAULT_SHOW_HOVER_SLOW_ZONE_HINT = false;
const DEFAULT_SHOW_DOWNIE = true;
const DEFAULT_SHOW_READER = true;
const MIN_HOVER_SPEED = 0;
const MIN_ADJUSTMENT_STEP = 0.01;
const MIN_OVERLAY_IDLE_HIDE_DELAY = 0;
const MAX_HOVER_SPEED = 16;
const MAX_ADJUSTMENT_STEP = 16;
const MAX_OVERLAY_IDLE_HIDE_DELAY = 60;
const PRECISION = 2;
const STEP = 0.25;

const roundToPrecision = (value) => {
  const factor = 10 ** PRECISION;
  return Math.round(value * factor) / factor;
};

const formatValue = (value) => roundToPrecision(value).toFixed(PRECISION);

const clampHoverSpeed = (value) => {
  const rounded = roundToPrecision(value);
  return Math.min(MAX_HOVER_SPEED, Math.max(MIN_HOVER_SPEED, rounded));
};

const clampAdjustmentStep = (value) => {
  const rounded = roundToPrecision(value);
  return Math.min(MAX_ADJUSTMENT_STEP, Math.max(MIN_ADJUSTMENT_STEP, rounded));
};

const normalizeHoverSpeed = (value) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_HOVER_SPEED;
  }

  return clampHoverSpeed(value);
};

const normalizeAdjustmentStep = (value) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_ADJUSTMENT_STEP;
  }

  return clampAdjustmentStep(value);
};

const clampOverlayIdleHideDelay = (value) => {
  const rounded = roundToPrecision(value);
  return Math.min(MAX_OVERLAY_IDLE_HIDE_DELAY, Math.max(MIN_OVERLAY_IDLE_HIDE_DELAY, rounded));
};

const normalizeOverlayIdleHideDelay = (value) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_OVERLAY_IDLE_HIDE_DELAY;
  }

  return clampOverlayIdleHideDelay(value);
};

const showStatus = (message) => {
  status.textContent = message;
  window.clearTimeout(showStatus.timeoutId);
  showStatus.timeoutId = window.setTimeout(() => {
    status.textContent = "";
  }, 1400);
};

const syncInput = (input, value) => {
  input.value = formatValue(value);
};

const saveHoverSpeed = (value) => {
  const nextValue = normalizeHoverSpeed(value);
  chrome.storage.local.set({ hoverSpeed: nextValue }, () => {
    syncInput(hoverSpeedInput, nextValue);
    showStatus(nextValue === 0 ? "Hover preview off" : "Saved");
  });
};

const saveAdjustmentStep = (value) => {
  const nextValue = normalizeAdjustmentStep(value);
  chrome.storage.local.set({ adjustmentStep: nextValue }, () => {
    syncInput(adjustmentStepInput, nextValue);
    showStatus("Step saved");
  });
};

const saveOverlayIdleHideDelay = (value) => {
  const nextValue = normalizeOverlayIdleHideDelay(value);
  chrome.storage.local.set({ overlayIdleHideDelay: nextValue }, () => {
    syncInput(overlayIdleHideDelayInput, nextValue);
    showStatus(nextValue === 0 ? "Overlay idle hide off" : "Overlay timeout saved");
  });
};

const saveToggle = (key, value, message) => {
  chrome.storage.local.set({ [key]: value }, () => {
    showStatus(message);
  });
};

chrome.storage.local.get(
  {
    hoverSpeed: DEFAULT_HOVER_SPEED,
    adjustmentStep: DEFAULT_ADJUSTMENT_STEP,
    overlayIdleHideDelay: DEFAULT_OVERLAY_IDLE_HIDE_DELAY,
    showHoverSlowZoneHint: DEFAULT_SHOW_HOVER_SLOW_ZONE_HINT,
    showDownie: DEFAULT_SHOW_DOWNIE,
    showReader: DEFAULT_SHOW_READER,
    readerToken: ""
  },
  ({ hoverSpeed, adjustmentStep, overlayIdleHideDelay, showHoverSlowZoneHint, showDownie, showReader, readerToken }) => {
    syncInput(hoverSpeedInput, normalizeHoverSpeed(Number(hoverSpeed)));
    syncInput(adjustmentStepInput, normalizeAdjustmentStep(Number(adjustmentStep)));
    syncInput(overlayIdleHideDelayInput, normalizeOverlayIdleHideDelay(Number(overlayIdleHideDelay)));
    showHoverSlowZoneHintInput.checked = showHoverSlowZoneHint !== false;
    showDownieInput.checked = showDownie !== false;
    showReaderInput.checked = showReader !== false;
    readerTokenInput.value = readerToken;
  }
);

hoverSpeedInput.addEventListener("change", () => {
  saveHoverSpeed(Number(hoverSpeedInput.value));
});

adjustmentStepInput.addEventListener("change", () => {
  saveAdjustmentStep(Number(adjustmentStepInput.value));
});

overlayIdleHideDelayInput.addEventListener("change", () => {
  saveOverlayIdleHideDelay(Number(overlayIdleHideDelayInput.value));
});

hoverSpeedInput.addEventListener("blur", () => {
  syncInput(hoverSpeedInput, normalizeHoverSpeed(Number(hoverSpeedInput.value)));
});

adjustmentStepInput.addEventListener("blur", () => {
  syncInput(adjustmentStepInput, normalizeAdjustmentStep(Number(adjustmentStepInput.value)));
});

overlayIdleHideDelayInput.addEventListener("blur", () => {
  syncInput(overlayIdleHideDelayInput, normalizeOverlayIdleHideDelay(Number(overlayIdleHideDelayInput.value)));
});

decreaseHoverButton.addEventListener("click", () => {
  saveHoverSpeed(Number(hoverSpeedInput.value) - STEP);
});

increaseHoverButton.addEventListener("click", () => {
  saveHoverSpeed(Number(hoverSpeedInput.value) + STEP);
});

decreaseStepButton.addEventListener("click", () => {
  saveAdjustmentStep(Number(adjustmentStepInput.value) - STEP);
});

increaseStepButton.addEventListener("click", () => {
  saveAdjustmentStep(Number(adjustmentStepInput.value) + STEP);
});

decreaseOverlayIdleHideDelayButton.addEventListener("click", () => {
  saveOverlayIdleHideDelay(Number(overlayIdleHideDelayInput.value) - STEP);
});

increaseOverlayIdleHideDelayButton.addEventListener("click", () => {
  saveOverlayIdleHideDelay(Number(overlayIdleHideDelayInput.value) + STEP);
});

showHoverSlowZoneHintInput.addEventListener("change", () => {
  saveToggle(
    "showHoverSlowZoneHint",
    showHoverSlowZoneHintInput.checked,
    showHoverSlowZoneHintInput.checked ? "Slow-hover hint shown" : "Slow-hover hint hidden"
  );
});

showDownieInput.addEventListener("change", () => {
  saveToggle("showDownie", showDownieInput.checked, showDownieInput.checked ? "Downie button shown" : "Downie button hidden");
});

showReaderInput.addEventListener("change", () => {
  saveToggle("showReader", showReaderInput.checked, showReaderInput.checked ? "Reader button shown" : "Reader button hidden");
});

saveTokenButton.addEventListener("click", () => {
  chrome.storage.local.set({ readerToken: readerTokenInput.value.trim() }, () => {
    showStatus("Reader token saved");
  });
});

readerTokenInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  saveTokenButton.click();
});
