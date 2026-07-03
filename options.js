const adjustmentStepInput = document.getElementById("adjustment-step");
const overlayIdleHideDelayInput = document.getElementById("overlay-idle-hide-delay");
const hoverCenterWidthInput = document.getElementById("hover-center-width");
const hoverCenterSpeedInput = document.getElementById("hover-center-speed");
const hoverMiddleWidthInput = document.getElementById("hover-middle-width");
const hoverMiddleSpeedInput = document.getElementById("hover-middle-speed");
const hoverOuterWidthInput = document.getElementById("hover-outer-width");
const hoverOuterSpeedInput = document.getElementById("hover-outer-speed");
const hoverBandSummary = document.getElementById("hover-band-summary");
const showHoverSlowZoneHintInput = document.getElementById("show-hover-slow-zone-hint");
const showDownieInput = document.getElementById("show-downie");
const showReaderInput = document.getElementById("show-reader");
const feedRevealDayEndInput = document.getElementById("feed-reveal-day-end");
const readerTokenInput = document.getElementById("reader-token");
const saveTokenButton = document.getElementById("save-token");
const status = document.getElementById("status");

const DEFAULT_ADJUSTMENT_STEP = 0.1;
const DEFAULT_OVERLAY_IDLE_HIDE_DELAY = 2;
const DEFAULT_HOVER_CENTER_WIDTH_PERCENT = 20;
const DEFAULT_HOVER_CENTER_SPEED = 1;
const DEFAULT_HOVER_MIDDLE_WIDTH_PERCENT = 10;
const DEFAULT_HOVER_MIDDLE_SPEED = 1.5;
const DEFAULT_HOVER_OUTER_WIDTH_PERCENT = 10;
const DEFAULT_HOVER_OUTER_SPEED = 2;
const DEFAULT_SHOW_HOVER_SLOW_ZONE_HINT = false;
const DEFAULT_SHOW_DOWNIE = true;
const DEFAULT_SHOW_READER = true;
const DEFAULT_FEED_REVEAL_DAY_END_MINUTES = 2 * 60;
const FEED_REVEAL_DAY_END_MINUTES_KEY = "ytListsFeedRevealDayEndMinutes";
const PRECISION = 2;

const roundToPrecision = (value) => {
  const factor = 10 ** PRECISION;
  return Math.round(value * factor) / factor;
};

const formatValue = (value) => roundToPrecision(value).toFixed(PRECISION);

const clampValue = (value, min, max) => {
  const rounded = roundToPrecision(value);
  return Math.min(max, Math.max(min, rounded));
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

const formatDisplayValue = (value) => {
  const rounded = roundToPrecision(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(PRECISION).replace(/\.?0+$/, "");
};

const normalizeMinuteOfDay = (value, fallback = DEFAULT_FEED_REVEAL_DAY_END_MINUTES) => {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) {
    return fallback;
  }
  return Math.min(23 * 60 + 59, Math.max(0, minutes));
};

const formatTimeInputValue = (minutes) => {
  const normalized = normalizeMinuteOfDay(minutes);
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
};

const parseTimeInputValue = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  if (!match) {
    return NaN;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    return NaN;
  }

  return hours * 60 + minutes;
};

const numericSettings = {
  adjustmentStep: {
    input: adjustmentStepInput,
    defaultValue: DEFAULT_ADJUSTMENT_STEP,
    min: 0.01,
    max: 16,
    status: () => "Step saved"
  },
  overlayIdleHideDelay: {
    input: overlayIdleHideDelayInput,
    defaultValue: DEFAULT_OVERLAY_IDLE_HIDE_DELAY,
    min: 0,
    max: 60,
    status: (value) => (value === 0 ? "Overlay idle hide off" : "Overlay timeout saved")
  },
  hoverCenterWidthPercent: {
    input: hoverCenterWidthInput,
    defaultValue: DEFAULT_HOVER_CENTER_WIDTH_PERCENT,
    min: 0,
    max: 100,
    status: () => "Saved"
  },
  hoverCenterSpeed: {
    input: hoverCenterSpeedInput,
    defaultValue: DEFAULT_HOVER_CENTER_SPEED,
    min: 0,
    max: 16,
    status: () => "Saved"
  },
  hoverMiddleWidthPercent: {
    input: hoverMiddleWidthInput,
    defaultValue: DEFAULT_HOVER_MIDDLE_WIDTH_PERCENT,
    min: 0,
    max: 100,
    status: () => "Saved"
  },
  hoverMiddleSpeed: {
    input: hoverMiddleSpeedInput,
    defaultValue: DEFAULT_HOVER_MIDDLE_SPEED,
    min: 0,
    max: 16,
    status: () => "Saved"
  },
  hoverOuterWidthPercent: {
    input: hoverOuterWidthInput,
    defaultValue: DEFAULT_HOVER_OUTER_WIDTH_PERCENT,
    min: 0,
    max: 100,
    status: () => "Saved"
  },
  hoverOuterSpeed: {
    input: hoverOuterSpeedInput,
    defaultValue: DEFAULT_HOVER_OUTER_SPEED,
    min: 0,
    max: 16,
    status: () => "Saved"
  }
};

const normalizeSettingValue = (settingName, value, fallback = numericSettings[settingName].defaultValue) => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const config = numericSettings[settingName];
  return clampValue(value, config.min, config.max);
};

const getCurrentNumericSettingValue = (settingName) => {
  const config = numericSettings[settingName];
  return normalizeSettingValue(settingName, Number(config.input.value), config.defaultValue);
};

const updateHoverBandSummary = () => {
  const centerWidth = getCurrentNumericSettingValue("hoverCenterWidthPercent");
  const centerSpeed = getCurrentNumericSettingValue("hoverCenterSpeed");
  const middleWidth = getCurrentNumericSettingValue("hoverMiddleWidthPercent");
  const middleSpeed = getCurrentNumericSettingValue("hoverMiddleSpeed");
  const outerWidth = getCurrentNumericSettingValue("hoverOuterWidthPercent");
  const outerSpeed = getCurrentNumericSettingValue("hoverOuterSpeed");
  const segments = [];

  if (centerWidth > 0 && centerSpeed > 0) {
    segments.push(`center ${formatDisplayValue(centerWidth)}% @ ${formatDisplayValue(centerSpeed)}x`);
  }

  if (middleWidth > 0 && middleSpeed > 0) {
    segments.push(`next ${formatDisplayValue(middleWidth)}% per side @ ${formatDisplayValue(middleSpeed)}x`);
  }

  if (outerWidth > 0 && outerSpeed > 0) {
    segments.push(`next ${formatDisplayValue(outerWidth)}% per side @ ${formatDisplayValue(outerSpeed)}x`);
  }

  hoverBandSummary.textContent = segments.length > 0
    ? `${segments.join(" | ")} | outside bands uses the saved speed`
    : "Hover preview disabled. Everywhere uses the saved speed.";
};

const saveNumericSetting = (settingName, value) => {
  const config = numericSettings[settingName];
  const nextValue = normalizeSettingValue(settingName, value);

  chrome.storage.local.set({ [settingName]: nextValue }, () => {
    syncInput(config.input, nextValue);
    updateHoverBandSummary();
    showStatus(config.status(nextValue));
  });
};

chrome.storage.local.get(
  [
    "hoverSpeed",
    ...Object.keys(numericSettings),
    "showHoverSlowZoneHint",
    "showDownie",
    "showReader",
    FEED_REVEAL_DAY_END_MINUTES_KEY,
    "readerToken"
  ],
  (result) => {
    const legacyHoverSpeed = Number(result.hoverSpeed);
    const hasSavedHoverBandSettings =
      result.hoverCenterSpeed !== undefined ||
      result.hoverCenterWidthPercent !== undefined ||
      result.hoverMiddleSpeed !== undefined ||
      result.hoverMiddleWidthPercent !== undefined ||
      result.hoverOuterSpeed !== undefined ||
      result.hoverOuterWidthPercent !== undefined;

    Object.entries(numericSettings).forEach(([settingName, config]) => {
      const rawValue =
        settingName === "hoverCenterSpeed" && result.hoverCenterSpeed === undefined
          ? legacyHoverSpeed
          : !hasSavedHoverBandSettings &&
              legacyHoverSpeed === 0 &&
              (settingName === "hoverMiddleSpeed" || settingName === "hoverOuterSpeed")
            ? 0
          : Number(result[settingName]);
      syncInput(
        config.input,
        normalizeSettingValue(settingName, rawValue, config.defaultValue)
      );
    });

    showHoverSlowZoneHintInput.checked =
      typeof result.showHoverSlowZoneHint === "boolean"
        ? result.showHoverSlowZoneHint
        : DEFAULT_SHOW_HOVER_SLOW_ZONE_HINT;
    showDownieInput.checked =
      typeof result.showDownie === "boolean" ? result.showDownie : DEFAULT_SHOW_DOWNIE;
    showReaderInput.checked =
      typeof result.showReader === "boolean" ? result.showReader : DEFAULT_SHOW_READER;
    feedRevealDayEndInput.value = formatTimeInputValue(
      normalizeMinuteOfDay(
        result[FEED_REVEAL_DAY_END_MINUTES_KEY],
        DEFAULT_FEED_REVEAL_DAY_END_MINUTES
      )
    );
    readerTokenInput.value = typeof result.readerToken === "string" ? result.readerToken : "";
    updateHoverBandSummary();
  }
);

Object.entries(numericSettings).forEach(([settingName, config]) => {
  config.input.addEventListener("change", () => {
    saveNumericSetting(settingName, Number(config.input.value));
  });

  config.input.addEventListener("blur", () => {
    syncInput(
      config.input,
      normalizeSettingValue(settingName, Number(config.input.value), config.defaultValue)
    );
    updateHoverBandSummary();
  });

  config.input.addEventListener("input", () => {
    updateHoverBandSummary();
  });
});

document.querySelectorAll(".stepper[data-setting]").forEach((button) => {
  button.addEventListener("click", () => {
    const settingName = button.dataset.setting;
    const delta = Number(button.dataset.delta);
    const config = numericSettings[settingName];

    if (!config || !Number.isFinite(delta)) {
      return;
    }

    saveNumericSetting(settingName, Number(config.input.value) + delta);
  });
});

const saveToggle = (key, value, message) => {
  chrome.storage.local.set({ [key]: value }, () => {
    showStatus(message);
  });
};

showHoverSlowZoneHintInput.addEventListener("change", () => {
  saveToggle(
    "showHoverSlowZoneHint",
    showHoverSlowZoneHintInput.checked,
    showHoverSlowZoneHintInput.checked ? "Slow-hover hint shown" : "Slow-hover hint hidden"
  );
});

showDownieInput.addEventListener("change", () => {
  saveToggle(
    "showDownie",
    showDownieInput.checked,
    showDownieInput.checked ? "Downie button shown" : "Downie button hidden"
  );
});

showReaderInput.addEventListener("change", () => {
  saveToggle(
    "showReader",
    showReaderInput.checked,
    showReaderInput.checked ? "Reader button shown" : "Reader button hidden"
  );
});

const saveFeedRevealDayEnd = () => {
  const minutes = normalizeMinuteOfDay(parseTimeInputValue(feedRevealDayEndInput.value));

  chrome.storage.local.set({ [FEED_REVEAL_DAY_END_MINUTES_KEY]: minutes }, () => {
    feedRevealDayEndInput.value = formatTimeInputValue(minutes);
    showStatus("Focus day end saved");
  });
};

feedRevealDayEndInput.addEventListener("change", saveFeedRevealDayEnd);
feedRevealDayEndInput.addEventListener("blur", () => {
  feedRevealDayEndInput.value = formatTimeInputValue(
    normalizeMinuteOfDay(
      parseTimeInputValue(feedRevealDayEndInput.value),
      DEFAULT_FEED_REVEAL_DAY_END_MINUTES
    )
  );
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
