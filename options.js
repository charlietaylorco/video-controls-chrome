const hoverSpeedInput = document.getElementById("hover-speed");
const adjustmentStepInput = document.getElementById("adjustment-step");
const decreaseHoverButton = document.getElementById("decrease-hover");
const increaseHoverButton = document.getElementById("increase-hover");
const decreaseStepButton = document.getElementById("decrease-step");
const increaseStepButton = document.getElementById("increase-step");
const showDownieInput = document.getElementById("show-downie");
const showReaderInput = document.getElementById("show-reader");
const readerTokenInput = document.getElementById("reader-token");
const saveTokenButton = document.getElementById("save-token");
const status = document.getElementById("status");
const DEFAULT_HOVER_SPEED = 1;
const DEFAULT_ADJUSTMENT_STEP = 0.1;
const DEFAULT_SHOW_DOWNIE = true;
const DEFAULT_SHOW_READER = true;
const MIN_HOVER_SPEED = 0;
const MIN_ADJUSTMENT_STEP = 0.01;
const MAX_HOVER_SPEED = 16;
const MAX_ADJUSTMENT_STEP = 16;
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

const saveToggle = (key, value, message) => {
  chrome.storage.local.set({ [key]: value }, () => {
    showStatus(message);
  });
};

chrome.storage.local.get(
  {
    hoverSpeed: DEFAULT_HOVER_SPEED,
    adjustmentStep: DEFAULT_ADJUSTMENT_STEP,
    showDownie: DEFAULT_SHOW_DOWNIE,
    showReader: DEFAULT_SHOW_READER,
    readerToken: ""
  },
  ({ hoverSpeed, adjustmentStep, showDownie, showReader, readerToken }) => {
    syncInput(hoverSpeedInput, normalizeHoverSpeed(Number(hoverSpeed)));
    syncInput(adjustmentStepInput, normalizeAdjustmentStep(Number(adjustmentStep)));
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

hoverSpeedInput.addEventListener("blur", () => {
  syncInput(hoverSpeedInput, normalizeHoverSpeed(Number(hoverSpeedInput.value)));
});

adjustmentStepInput.addEventListener("blur", () => {
  syncInput(adjustmentStepInput, normalizeAdjustmentStep(Number(adjustmentStepInput.value)));
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
