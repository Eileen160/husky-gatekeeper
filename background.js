importScripts('shared.js');

const shared = globalThis.HuskyGatekeeperShared;
const USAGE_STORAGE_KEY = 'huskyGatekeeperUsage';
const BREAK_STORAGE_KEY = 'huskyGatekeeperBreak';
const GLOBAL_USAGE_KEY = '__all__';
const MONITORED_USAGE_KEY = '__monitored__';
const LIMIT_ALARM_PREFIX = 'husky-limit:';
const SLEEP_WAKE_GRACE_MS = 15 * 1000;

function getUsageStorageKey(usageKey) {
  return `${USAGE_STORAGE_KEY}:${usageKey}`;
}

function getBreakStorageKey(usageKey) {
  return `${BREAK_STORAGE_KEY}:${usageKey}`;
}

function getLimitAlarmName(usageKey) {
  return `${LIMIT_ALARM_PREFIX}${usageKey}`;
}

function getUsageKeyFromLimitAlarm(alarmName) {
  if (!alarmName.startsWith(LIMIT_ALARM_PREFIX)) return '';
  return alarmName.slice(LIMIT_ALARM_PREFIX.length);
}

function getHostname(url) {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return '';
    return parsedUrl.hostname;
  } catch (_error) {
    return '';
  }
}

function getMatchedDomain(settings, hostname) {
  return shared.normalizeDomainList(settings.customDomains).find((domain) =>
    shared.hostnameMatchesDomain(hostname, domain)
  ) || '';
}

function sendMessageToTab(tabId, message, retryCount = 2) {
  chrome.tabs.sendMessage(tabId, message, () => {
    const error = chrome.runtime.lastError;
    if (!error || retryCount <= 0) return;

    setTimeout(() => {
      sendMessageToTab(tabId, message, retryCount - 1);
    }, 350);
  });
}

function ensureContentScript(tabId, callback = () => {}) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => globalThis.HuskyGatekeeperInjected === true
  }, (results) => {
    if (chrome.runtime.lastError) {
      callback(false);
      return;
    }

    if (results?.[0]?.result === true) {
      callback(true);
      return;
    }

    chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css']
    }, () => {
      void chrome.runtime.lastError;
      chrome.scripting.executeScript({
        target: { tabId },
        files: ['shared.js', 'content.js']
      }, () => {
        callback(!chrome.runtime.lastError);
      });
    });
  });
}

function broadcastToTabs(message) {
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    tabs.forEach((tab) => {
      if (!tab.id) return;
      sendMessageToTab(tab.id, message);
    });
  });
}

function getMonitoredDomains(settings) {
  return shared.normalizeDomainList(settings.customDomains);
}

function resetUsageForSchedule(usageKey, settings, callback = () => {}) {
  const usageKeys = usageKey === MONITORED_USAGE_KEY
    ? getMonitoredDomains(settings)
    : [usageKey];
  const updates = {};

  usageKeys.forEach((key) => {
    updates[getUsageStorageKey(key)] = {
      seconds: 0,
      updatedAt: Date.now()
    };
  });

  chrome.storage.local.set(updates, callback);
}

function rescheduleFullLimitAfterWake(usageKey, settings) {
  resetUsageForSchedule(usageKey, settings, () => {
    chrome.alarms.clear(getLimitAlarmName(usageKey), () => {
      chrome.alarms.create(getLimitAlarmName(usageKey), {
        when: Date.now() + settings.usageLimit * 60 * 1000
      });
    });
  });
}

function createBreak(usageKey, breakTime, settings) {
  if (!usageKey) return;

  const breakEndsAt = Date.now() + breakTime * 60 * 1000;

  if (usageKey === MONITORED_USAGE_KEY) {
    const updates = {};
    getMonitoredDomains(settings).forEach((domain) => {
      updates[getUsageStorageKey(domain)] = {
        seconds: 0,
        updatedAt: Date.now()
      };
      updates[getBreakStorageKey(domain)] = {
        breakEndsAt,
        updatedAt: Date.now()
      };
    });

    chrome.storage.local.set(updates, () => {
      broadcastToTabs({ type: 'SHOW_MONITORED_HUSKY', breakEndsAt });
    });
    return;
  }

  chrome.storage.local.set({
    [getUsageStorageKey(usageKey)]: {
      seconds: 0,
      updatedAt: Date.now()
    },
    [getBreakStorageKey(usageKey)]: {
      breakEndsAt,
      updatedAt: Date.now()
    }
  }, () => {
    broadcastToTabs(usageKey === GLOBAL_USAGE_KEY
      ? { type: 'SHOW_GLOBAL_HUSKY', breakEndsAt }
      : { type: 'SHOW_DOMAIN_HUSKY', usageKey, breakEndsAt });
  });
}

function getScheduledUsageKeys(settings) {
  if (!settings.huskyEnabled || settings.paused) return [];
  if (settings.blockAll) return [GLOBAL_USAGE_KEY];
  return getMonitoredDomains(settings).length ? [MONITORED_USAGE_KEY] : [];
}

function clearLimitAlarms(callback = () => {}) {
  chrome.alarms.getAll((alarms) => {
    const names = alarms
      .map((alarm) => alarm.name)
      .filter((name) => name.startsWith(LIMIT_ALARM_PREFIX));

    if (!names.length) {
      callback();
      return;
    }

    let remaining = names.length;
    names.forEach((name) => {
      chrome.alarms.clear(name, () => {
        remaining--;
        if (remaining === 0) callback();
      });
    });
  });
}

function scheduleLimitAlarms(settings) {
  clearLimitAlarms(() => {
    getScheduledUsageKeys(settings).forEach((usageKey) => {
      chrome.alarms.create(getLimitAlarmName(usageKey), {
        when: Date.now() + settings.usageLimit * 60 * 1000
      });
    });
  });
}

function clearActiveBreaks(settings) {
  const updates = {};
  [GLOBAL_USAGE_KEY, ...shared.normalizeDomainList(settings.customDomains)].forEach((usageKey) => {
    updates[getBreakStorageKey(usageKey)] = {
      breakEndsAt: 0,
      updatedAt: Date.now()
    };
  });
  chrome.storage.local.set(updates);
}

function applySettingsInBackground(rawSettings) {
  const settings = shared.normalizeSettings(rawSettings);
  clearLimitAlarms(() => {
    if (!settings.huskyEnabled) {
      clearActiveBreaks(settings);
      broadcastToTabs({ type: 'DISMISS_GLOBAL_HUSKY' });
      shared.normalizeDomainList(settings.customDomains).forEach((usageKey) => {
        broadcastToTabs({ type: 'DISMISS_DOMAIN_HUSKY', usageKey });
      });
      return;
    }

    injectAllOpenTabs(() => {
      scheduleLimitAlarms(settings);
    });
  });
}

function notifyTabOfActiveBreak(tabId, url) {
  const hostname = getHostname(url);
  if (!hostname) return;

  chrome.storage.local.get(null, (storedSettings) => {
    const settings = shared.normalizeSettings(storedSettings);
    if (!settings.huskyEnabled || settings.paused) return;

    const usageKey = settings.blockAll
      ? GLOBAL_USAGE_KEY
      : getMatchedDomain(settings, hostname);
    if (!usageKey) return;

    chrome.storage.local.get({ [getBreakStorageKey(usageKey)]: null }, (result) => {
      const entry = result[getBreakStorageKey(usageKey)];
      const breakEndsAt = Number(entry?.breakEndsAt || 0);
      if (!breakEndsAt || Date.now() >= breakEndsAt) return;

      sendMessageToTab(tabId, settings.blockAll
        ? { type: 'SHOW_GLOBAL_HUSKY', breakEndsAt }
        : { type: 'SHOW_DOMAIN_HUSKY', usageKey, breakEndsAt });
    });
  });
}

function injectAllOpenTabs(callback = () => {}) {
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    if (!tabs.length) {
      callback();
      return;
    }

    let remaining = tabs.length;
    tabs.forEach((tab) => {
      if (!tab.id) {
        remaining--;
        if (remaining === 0) callback();
        return;
      }

      ensureContentScript(tab.id, () => {
        notifyTabOfActiveBreak(tab.id, tab.url || '');
        remaining--;
        if (remaining === 0) callback();
      });
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message.type !== 'BROADCAST_GLOBAL_BREAK' &&
    message.type !== 'BROADCAST_DOMAIN_BREAK' &&
    message.type !== 'BROADCAST_DISMISS' &&
    message.type !== 'BROADCAST_SETTINGS' &&
    message.type !== 'ENSURE_CONTENT_SCRIPT' &&
    message.type !== 'RESET_AFTER_IDLE'
  ) {
    return;
  }

  if (message.type === 'ENSURE_CONTENT_SCRIPT') {
    ensureContentScript(message.tabId, (ok) => {
      sendResponse({ ok });
    });
    return true;
  }

  if (message.type === 'RESET_AFTER_IDLE') {
    chrome.storage.local.get(null, (storedSettings) => {
      const settings = shared.normalizeSettings(storedSettings);
      const scheduledUsageKey = settings.blockAll ? GLOBAL_USAGE_KEY : MONITORED_USAGE_KEY;

      if (getScheduledUsageKeys(settings).includes(scheduledUsageKey)) {
        rescheduleFullLimitAfterWake(scheduledUsageKey, settings);
      }

      sendResponse({ ok: true });
    });
    return true;
  }

  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    tabs.forEach((tab) => {
      if (!tab.id || tab.id === sender.tab?.id) return;

      ensureContentScript(tab.id, () => {
        sendMessageToTab(tab.id, message.payload);
      });
    });
    sendResponse({ ok: true });
  });

  if (message.type === 'BROADCAST_SETTINGS' && message.payload?.type === 'UPDATE_HUSKY_SETTINGS') {
    applySettingsInBackground(message.payload.settings);
  }

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const usageKey = getUsageKeyFromLimitAlarm(alarm.name);
  if (!usageKey) return;

  chrome.storage.local.get(null, (storedSettings) => {
    const settings = shared.normalizeSettings(storedSettings);
    if (!getScheduledUsageKeys(settings).includes(usageKey)) return;

    if (Date.now() - alarm.scheduledTime > SLEEP_WAKE_GRACE_MS) {
      rescheduleFullLimitAfterWake(usageKey, settings);
      return;
    }

    createBreak(usageKey, settings.breakTime, settings);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  notifyTabOfActiveBreak(tabId, tab.url || changeInfo.url || '');
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    notifyTabOfActiveBreak(tabId, tab.url || '');
  });
});

chrome.runtime.onInstalled.addListener(() => {
  injectAllOpenTabs(() => {
    chrome.storage.local.get(null, (storedSettings) => {
      applySettingsInBackground(storedSettings);
    });
  });
});

chrome.runtime.onStartup.addListener(() => {
  injectAllOpenTabs(() => {
    chrome.storage.local.get(null, (storedSettings) => {
      applySettingsInBackground(storedSettings);
    });
  });
});

injectAllOpenTabs(() => {
  chrome.storage.local.get(null, (storedSettings) => {
    const settings = shared.normalizeSettings(storedSettings);
    if (settings.huskyEnabled) {
      scheduleLimitAlarms(settings);
    }
  });
});
