document.querySelectorAll('[data-i18n]').forEach((element) => {
  element.textContent = chrome.i18n.getMessage(element.dataset.i18n);
});

const shared = globalThis.HuskyGatekeeperShared;
const defaults = { ...shared.DEFAULT_SETTINGS };

function mergeSettingsWithDefaults(settings) {
  return shared.normalizeSettings(settings);
}

function getClampedNumberValue(inputId, fallbackValue) {
  const input = document.getElementById(inputId);
  const parsedValue = Number.parseInt(input.value, 10);
  const minValue = Number.parseInt(input.min, 10);
  const maxValue = Number.parseInt(input.max, 10);

  if (Number.isNaN(parsedValue)) {
    return fallbackValue;
  }

  return Math.min(Math.max(parsedValue, minValue), maxValue);
}

function sendMessageToAllTabs(message) {
  chrome.runtime.sendMessage({
    type: 'BROADCAST_SETTINGS',
    payload: message
  }, () => {
    void chrome.runtime.lastError;
  });
}

function ensureActiveTabContentScript(tabId, callback) {
  chrome.runtime.sendMessage({
    type: 'ENSURE_CONTENT_SCRIPT',
    tabId
  }, () => {
    void chrome.runtime.lastError;
    callback();
  });
}

const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const statusMsg = document.getElementById('statusMsg');
const activeStatus = document.getElementById('activeStatus');
const huskyEnabledInput = document.getElementById('huskyEnabled');
const blockAllInput = document.getElementById('blockAll');
const knownDomainInputs = [...document.querySelectorAll('[data-domain]')];
const formControls = [
  document.getElementById('usageLimit'),
  document.getElementById('breakTime'),
  blockAllInput,
  saveBtn,
  resetBtn,
  ...knownDomainInputs
];

function updateEnabledState() {
  const huskyEnabled = huskyEnabledInput.checked;
  const blockAllEnabled = blockAllInput.checked;

  formControls.forEach((control) => {
    control.disabled = !huskyEnabled;
    control.setAttribute('aria-disabled', String(!huskyEnabled));
  });

  knownDomainInputs.forEach((input) => {
    const disabled = !huskyEnabled || blockAllEnabled;
    input.disabled = disabled;
    input.setAttribute('aria-disabled', String(disabled));
    input.closest('.chip')?.classList.toggle('is-disabled', disabled);
  });

  document.body.classList.toggle('is-inactive', !huskyEnabled);
}

function renderSettings(settings) {
  const mergedSettings = mergeSettingsWithDefaults(settings);

  document.getElementById('usageLimit').value = mergedSettings.usageLimit;
  document.getElementById('breakTime').value = mergedSettings.breakTime;
  huskyEnabledInput.checked = mergedSettings.huskyEnabled;
  blockAllInput.checked = mergedSettings.blockAll;
  activeStatus.textContent = chrome.i18n.getMessage(
    mergedSettings.huskyEnabled
        ? 'activeStatus'
        : 'inactiveStatus'
  );

  const domainSet = new Set(mergedSettings.customDomains);
  knownDomainInputs.forEach((input) => {
    input.checked = domainSet.has(input.dataset.domain);
  });
  updateEnabledState();
}

function syncBlockAllState() {
  updateEnabledState();
}

function collectSettings() {
  return {
    huskyEnabled: huskyEnabledInput.checked,
    paused: false,
    blockAll: document.getElementById('blockAll').checked,
    usageLimit: getClampedNumberValue('usageLimit', defaults.usageLimit),
    breakTime: getClampedNumberValue('breakTime', defaults.breakTime),
    customDomains: shared.normalizeDomainList(
      knownDomainInputs
        .filter((input) => input.checked)
        .map((input) => input.dataset.domain)
    )
  };
}

function saveSettings(settings) {
  document.getElementById('usageLimit').value = settings.usageLimit;
  document.getElementById('breakTime').value = settings.breakTime;

  chrome.storage.local.set(settings, () => {
    activeStatus.textContent = chrome.i18n.getMessage(
      settings.huskyEnabled
          ? 'activeStatus'
          : 'inactiveStatus'
    );
    updateEnabledState();
    saveBtn.textContent = chrome.i18n.getMessage('savedMessage');
    setTimeout(() => {
      saveBtn.textContent = chrome.i18n.getMessage('saveButton');
    }, 1400);

    sendMessageToAllTabs({ type: 'UPDATE_HUSKY_SETTINGS', settings });
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab?.id) return;

  function requestStatus({ retried = false } = {}) {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_HUSKY_STATUS' }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      if (!retried) {
        ensureActiveTabContentScript(tab.id, () => {
          requestStatus({ retried: true });
        });
        return;
      }

      statusMsg.textContent = chrome.i18n.getMessage('statusNotInjected');
      return;
    }

    updateEnabledState();

    if (response?.isTracked) {
      statusMsg.textContent = chrome.i18n.getMessage('statusTracked', [
        response.trackedDomain || response.hostname
      ]);
    } else {
      statusMsg.textContent = chrome.i18n.getMessage('statusNotTracked', [
        response?.hostname || ''
      ]);
    }
  });
  }

  requestStatus();
});

chrome.storage.local.get(null, (settings) => {
  renderSettings(settings);
});

blockAllInput.addEventListener('change', syncBlockAllState);

huskyEnabledInput.addEventListener('change', () => {
  updateEnabledState();
  saveSettings(collectSettings());
});

saveBtn.addEventListener('click', () => {
  saveSettings(collectSettings());
});

resetBtn.addEventListener('click', () => {
  const resetSettings = {
    ...defaults,
    huskyEnabled: huskyEnabledInput.checked,
    customDomains: [...defaults.customDomains]
  };
  renderSettings(resetSettings);
  saveSettings(resetSettings);
});
