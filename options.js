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
const hideFeedVideosInput = document.getElementById("hide-feed-videos");
const feedRevealDailyLimitInput = document.getElementById("feed-reveal-daily-limit");
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
const HIDE_FEED_VIDEOS_KEY = "ytListsHideFeedVideos";
const FEED_REVEAL_DAILY_LIMIT_KEY = "ytListsFeedRevealDailyLimit";
const DEFAULT_FEED_REVEAL_DAILY_LIMIT = 3;

const normalizeFeedRevealDailyLimit = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FEED_REVEAL_DAILY_LIMIT;
  return Math.min(100, Math.max(0, Math.floor(value)));
};

const readFeedRevealDailyLimitInput = () => normalizeFeedRevealDailyLimit(feedRevealDailyLimitInput.valueAsNumber);
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
  const storageError = chrome.runtime.lastError;
  status.textContent = storageError ? "Could not save changes. Please try again." : message;
  status.dataset.error = String(Boolean(storageError) || /^(Could not|Choose)\b/.test(message));
  window.clearTimeout(showStatus.timeoutId);
  showStatus.timeoutId = window.setTimeout(() => {
    status.textContent = "";
  }, 2600);
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
  // Match the video overlay: each side stops at the edge, even if the configured
  // widths add up to more than 100%. A zero speed leaves its space at saved speed.
  const middleWidth = Math.min(getCurrentNumericSettingValue("hoverMiddleWidthPercent"), (100 - centerWidth) / 2);
  const middleSpeed = getCurrentNumericSettingValue("hoverMiddleSpeed");
  const outerWidth = Math.min(getCurrentNumericSettingValue("hoverOuterWidthPercent"), (100 - centerWidth) / 2 - middleWidth);
  const outerSpeed = getCurrentNumericSettingValue("hoverOuterSpeed");
  const segments = [];

  window.MVSOptionsUI?.updateHoverPreview({
    center: { width: centerWidth, speed: centerSpeed },
    middle: { width: middleWidth, speed: middleSpeed },
    outer: { width: outerWidth, speed: outerSpeed }
  });

  if (centerWidth > 0 && centerSpeed > 0) {
    segments.push(`Centre ${formatDisplayValue(centerWidth)}% at ${formatDisplayValue(centerSpeed)}×`);
  }

  if (middleWidth > 0 && middleSpeed > 0) {
    segments.push(`middle ${formatDisplayValue(middleWidth)}% per side at ${formatDisplayValue(middleSpeed)}×`);
  }

  if (outerWidth > 0 && outerSpeed > 0) {
    segments.push(`outer ${formatDisplayValue(outerWidth)}% per side at ${formatDisplayValue(outerSpeed)}×`);
  }

  hoverBandSummary.textContent = segments.length > 0
    ? `${segments.join(" · ")}. Elsewhere, your saved speed applies.`
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
    HIDE_FEED_VIDEOS_KEY,
    FEED_REVEAL_DAILY_LIMIT_KEY,
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
    feedRevealDailyLimitInput.value = String(normalizeFeedRevealDailyLimit(result[FEED_REVEAL_DAILY_LIMIT_KEY]));
    if (typeof result[HIDE_FEED_VIDEOS_KEY] === "boolean") {
      hideFeedVideosInput.checked = result[HIDE_FEED_VIDEOS_KEY];
    } else {
      // Match YT Lists' fallback for settings saved before the move to local storage.
      chrome.storage.sync.get([HIDE_FEED_VIDEOS_KEY], (legacy) => {
        hideFeedVideosInput.checked = legacy[HIDE_FEED_VIDEOS_KEY] === true;
      });
    }
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

hideFeedVideosInput.addEventListener("change", () => {
  const enabled = hideFeedVideosInput.checked;
  chrome.storage.local.set({ [HIDE_FEED_VIDEOS_KEY]: enabled }, () => {
    if (chrome.runtime.lastError) {
      showStatus("Could not save focus mode");
      return;
    }
    chrome.storage.sync.set({ [HIDE_FEED_VIDEOS_KEY]: enabled });
    showStatus(enabled ? "Focus mode on" : "Focus mode off");
  });
});

const saveFeedRevealDailyLimit = (value) => {
  const limit = normalizeFeedRevealDailyLimit(value);
  chrome.storage.local.set({ [FEED_REVEAL_DAILY_LIMIT_KEY]: limit }, () => {
    if (chrome.runtime.lastError) {
      showStatus("Could not save daily unblocks");
      return;
    }
    feedRevealDailyLimitInput.value = String(limit);
    showStatus("Daily unblocks saved");
  });
};

feedRevealDailyLimitInput.addEventListener("change", () => saveFeedRevealDailyLimit(readFeedRevealDailyLimitInput()));
feedRevealDailyLimitInput.addEventListener("blur", () => {
  feedRevealDailyLimitInput.value = String(readFeedRevealDailyLimitInput());
});
document.querySelectorAll("[data-feed-reveal-delta]").forEach((button) => {
  button.addEventListener("click", () => {
    saveFeedRevealDailyLimit(readFeedRevealDailyLimitInput() + Number(button.dataset.feedRevealDelta));
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[HIDE_FEED_VIDEOS_KEY]) {
    hideFeedVideosInput.checked = changes[HIDE_FEED_VIDEOS_KEY].newValue === true;
  }
  if (changes[FEED_REVEAL_DAILY_LIMIT_KEY]) {
    feedRevealDailyLimitInput.value = String(normalizeFeedRevealDailyLimit(changes[FEED_REVEAL_DAILY_LIMIT_KEY].newValue));
  }
});

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

const iconLabels = { pip: "Picture-in-picture", "download-x": "X download", downie: "Downie", reader: "Reader", raindrop: "Raindrop" };
let iconOrder = Object.keys(iconLabels);
const renderIconOrder = (focusAction, focusDelta) => {
  const list = document.getElementById("icon-order");
  list.replaceChildren();
  iconOrder.forEach((action, index) => {
    const row = document.createElement("div");
    row.className = "setting-row icon-order-row";
    const label = document.createElement("span");
    label.className = "setting-title";
    const position = document.createElement("span");
    position.className = "order-number";
    position.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.textContent = iconLabels[action];
    label.append(position, name);
    const controls = document.createElement("div");
    controls.className = "order-controls";
    [-1, 1].forEach((delta) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "save-button";
      button.textContent = delta === -1 ? "←" : "→";
      button.setAttribute("aria-label", `Move ${iconLabels[action]} ${delta === -1 ? "left" : "right"}`);
      button.disabled = index + delta < 0 || index + delta >= iconOrder.length;
      button.addEventListener("click", () => {
        [iconOrder[index], iconOrder[index + delta]] = [iconOrder[index + delta], iconOrder[index]];
        chrome.storage.local.set({ iconOrder }, () => {
          const error = chrome.runtime.lastError;
          showStatus(error ? "Could not save icon order" : "Icon order saved");
        });
        renderIconOrder(action, delta);
      });
      controls.appendChild(button);
      if (action === focusAction && delta === focusDelta) {
        // Restore keyboard focus after rebuilding the reordered list.
        queueMicrotask(() => (button.disabled ? controls.querySelector("button:not(:disabled)") : button)?.focus());
      }
    });
    row.append(label, controls);
    list.appendChild(row);
  });
};
const showRaindropInput = document.getElementById("show-raindrop");
chrome.storage.local.get(["iconOrder", "showRaindrop"], (result) => {
  iconOrder = [...new Set([...(Array.isArray(result.iconOrder) ? result.iconOrder : []), ...Object.keys(iconLabels)])]
    .filter((action) => Object.hasOwn(iconLabels, action));
  renderIconOrder();
  showRaindropInput.checked = result.showRaindrop !== false;
});
showRaindropInput.addEventListener("change", () => saveToggle("showRaindrop", showRaindropInput.checked, "Raindrop visibility saved"));

const showReaderPanelInput = document.getElementById("show-reader-panel");
chrome.storage.local.get(["showReaderPanel"], ({ showReaderPanel }) => {
  showReaderPanelInput.checked = showReaderPanel === true;
});
showReaderPanelInput.addEventListener("change", () => {
  saveToggle("showReaderPanel", showReaderPanelInput.checked, "Reader panel visibility saved");
});

const readerPanelThemeInput = document.getElementById("reader-panel-theme");
const normalizeReaderPanelTheme = value => ["light", "dark"].includes(value) ? value : "system";
chrome.storage.local.get(["readerPanelTheme"], ({ readerPanelTheme }) => {
  readerPanelThemeInput.value = normalizeReaderPanelTheme(readerPanelTheme);
});
readerPanelThemeInput.addEventListener("change", () => {
  chrome.storage.local.set({ readerPanelTheme: normalizeReaderPanelTheme(readerPanelThemeInput.value) }, () => {
    showStatus(chrome.runtime.lastError ? "Could not save appearance" : "Appearance saved");
  });
});

const recentSavesLauncherInput = document.getElementById("show-recent-saves-launcher");
const recentSavesPositionInput = document.getElementById("recent-saves-launcher-position");
const normalizeRecentSavesPosition = value => ["top-left", "top-right", "bottom-left", "bottom-right"].includes(value) ? value : "bottom-left";
chrome.storage.local.get(["showRecentSavesLauncher", "recentSavesLauncherPosition"], values => {
  recentSavesLauncherInput.checked = values.showRecentSavesLauncher !== false;
  recentSavesPositionInput.value = normalizeRecentSavesPosition(values.recentSavesLauncherPosition);
});
recentSavesLauncherInput.addEventListener("change", () => {
  saveToggle("showRecentSavesLauncher", recentSavesLauncherInput.checked, "Recent saves shortcut visibility saved");
});
recentSavesPositionInput.addEventListener("change", () => {
  chrome.storage.local.set({ recentSavesLauncherPosition: normalizeRecentSavesPosition(recentSavesPositionInput.value) }, () => {
    showStatus(chrome.runtime.lastError ? "Could not save shortcut position" : "Recent saves shortcut position saved");
  });
});

// The configured default is separate from each timer session's chosen duration.
const watchTimerDefaultInput = document.getElementById('watch-timer-default-minutes');
let watchTimerDefaultMinutes = 15;
chrome.storage.local.get(['watchTimerDefaultMinutes'], values => {
  const value = values.watchTimerDefaultMinutes;
  watchTimerDefaultMinutes = Number.isInteger(value) && value >= 1 && value <= 180 ? value : 15;
  watchTimerDefaultInput.value = String(watchTimerDefaultMinutes);
});
watchTimerDefaultInput.addEventListener('change', () => {
  const value = watchTimerDefaultInput.valueAsNumber;
  if (!Number.isInteger(value) || value < 1 || value > 180) {
    watchTimerDefaultInput.value = String(watchTimerDefaultMinutes); showStatus('Choose 1–180 whole minutes'); return;
  }
  chrome.storage.local.set({ watchTimerDefaultMinutes: value }, () => {
    if (!chrome.runtime.lastError) watchTimerDefaultMinutes = value;
    else watchTimerDefaultInput.value = String(watchTimerDefaultMinutes);
    showStatus(chrome.runtime.lastError ? 'Could not save timer default' : 'Viewing timer default saved');
  });
});

// Pairing is optional. Request exactly the chosen origin during this click;
// no third-party service credentials leave the extension.
(() => {
  const site = document.getElementById('cloud-origin'), token = document.getElementById('cloud-token');
  const connect = document.getElementById('cloud-connect'), migrate = document.getElementById('cloud-import');
  const open = document.getElementById('cloud-open'), disconnect = document.getElementById('cloud-disconnect');
  const output = document.getElementById('cloud-status'), exportButton = document.getElementById('cloud-export');
  if (!site || !globalThis.MVSRecentSavesCloud) return;
  const shortcut = document.getElementById('cloud-use-shortcut');
  chrome.storage.local.get({ recentSavesOpenWebsite: false }, values => { shortcut.checked = values.recentSavesOpenWebsite === true; });
  shortcut.addEventListener('change', () => chrome.storage.local.set({ recentSavesOpenWebsite: shortcut.checked }, () => {
    if (chrome.runtime.lastError) { shortcut.checked = !shortcut.checked; output.textContent = 'Could not save shortcut preference.'; }
  }));
  let busy = false, paired = null;
  const errors = {
    invalid_pairing: 'Enter the device token generated in Watchlater Settings.', permission_required: 'Website permission is missing. Connect again to grant access.', sign_in_required: 'Sign in to Watchlater in this Chrome profile, then choose Connect / verify again. Local data is retained; JSON export also works without pairing.',
    pairing_expired: 'The device token expired or was revoked. Generate a new token on the website and connect again.',
    account_changed: 'The website account changed. Verify the intended account and connect again before importing.',
    reader_account_changed: 'Reader credentials changed. Verify the website account and connect again before importing.',
    network_error: 'The website could not be reached. Retained changes will retry automatically.', server_error: 'The website could not accept this batch. Retained changes will retry automatically.',
    incomplete_acknowledgement: 'The website did not confirm the whole batch. The import is retained for retry.', invalid_response: 'The website returned an invalid response. Check its deployment.',
    rate_limited: 'The website is rate limited. Retained changes will retry automatically.', storage_error: 'Could not save cloud sync settings. Local history is retained.',
    pairing_required: 'Connect and verify the website first.', connection_changed: 'Connection changed. Check the current account before importing.'
  };
  const send = message => new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'recent-saves-cloud', ...message }, reply => resolve(chrome.runtime.lastError ? { ok: false, code: 'storage_error' } : reply || { ok: false, code: 'storage_error' }));
  });
  const render = value => {
    paired = value;
    if (value?.origin && document.activeElement !== site) site.value = value.origin;
    connect.disabled = busy; disconnect.disabled = busy || !value?.connected;
    migrate.disabled = busy || !value?.connected || ['importing', 'paused'].includes(value.phase);
    open.disabled = busy; exportButton.disabled = busy;
    if (!value?.ok || value.code) output.textContent = errors[value?.code] || 'The connection needs attention. Local history is retained.';
    else if (value.phase === 'importing') output.textContent = `Importing retained history: ${value.imported} confirmed. You can close this page; the import resumes automatically.`;
    else if (value.ready) output.textContent = `Website ready. ${value.imported} imported. Changes sync automatically.${value.syncedAt ? ' Last confirmed ' + new Date(value.syncedAt).toLocaleString() + '.' : ''}`;
    else if (value.connected) output.textContent = 'Connection verified. Choose Import history to copy retained data and enable sync. Local Recent saves stays available and remains the default.';
    else output.textContent = 'Not connected. Recent saves continues to open locally.';
    if (value?.retryAt) output.textContent += ` Next retry after ${new Date(value.retryAt).toLocaleTimeString()}.`;
  };
  const refresh = async () => render(await send({ action: 'status' }));
  connect.addEventListener('click', () => {
    const origin = MVSRecentSavesCloud.origin(site.value.trim());
    if (!origin) { output.textContent = errors.invalid_pairing; return; }
    if (!chrome.permissions?.request) { output.textContent = errors.permission_required; return; }
    busy = true; render(paired);
    // The user gesture must reach permissions.request synchronously.
    chrome.permissions.request({ origins: [origin + '/*'] }, async granted => {
      if (chrome.runtime.lastError || !granted) { busy = false; await refresh(); output.textContent = errors.permission_required; return; }
      const result = await send({ action: 'connect', origin, token: token.value.trim() });
      busy = false;
      if (result.ok) { token.value = ''; render(result); }
      else { await refresh(); output.textContent = errors[result.code] || 'Could not verify this website.'; }
    });
  });
  migrate.addEventListener('click', async () => { busy = true; render(paired); const result = await send({ action: 'import' }); busy = false; render(result); });
  disconnect.addEventListener('click', async () => { busy = true; render(paired); const result = await send({ action: 'disconnect' }); busy = false; token.value = ''; render(result); });
  open.addEventListener('click', () => chrome.tabs.create({ url: MVSRecentSavesCloud.SITE + '/' }));
  exportButton.addEventListener('click', async () => {
    busy = true; render(paired);
    const records = [], seen = new Set(); let cursor = null;
    try {
      do {
        const result = await send({ action: 'export', cursor });
        if (!result.ok || !Array.isArray(result.items)) throw new Error(result.code || 'storage_error');
        records.push(...result.items); output.textContent = `Exporting local history… ${records.length} records`;
        cursor = result.nextCursor || null;
        if (cursor) { const key = JSON.stringify(cursor); if (seen.has(key)) throw new Error('storage_error'); seen.add(key); }
      } while (cursor);
      const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records })], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `recent-saves-local-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000); output.textContent = `Export downloaded: ${records.length} retained records. Import it in Watchlater Settings.`;
    } catch (e) { output.textContent = errors[e.message] || 'Could not export local history. Local data is retained.'; }
    finally { const message = output.textContent; busy = false; render(paired); output.textContent = message; }
  });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.recentSavesCloud) void refresh(); });
  void refresh();
})();
