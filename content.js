(function initializeHuskyGatekeeper() {
  if (globalThis.HuskyGatekeeperInjected === true) return;
const shared = globalThis.HuskyGatekeeperShared;
globalThis.HuskyGatekeeperInjected = true;

const hostname = location.hostname;
const USAGE_STORAGE_KEY = 'huskyGatekeeperUsage';
const BREAK_STORAGE_KEY = 'huskyGatekeeperBreak';
const GLOBAL_USAGE_KEY = '__all__';
const USAGE_STALE_AFTER_MS = 30 * 60 * 1000;
const USAGE_SAVE_INTERVAL_SECONDS = 5;
const ENTER_VIDEO_MIN_SECONDS = 8;
const MAX_TRACKED_TICK_GAP_MS = 10 * 1000;

const preventScroll = (event) => event.preventDefault();

function getUiMessage(messageName, fallbackText) {
  const message = chrome.i18n.getMessage(messageName);
  const uiLanguage = chrome.i18n.getUILanguage?.().toLowerCase() || '';

  if (
    uiLanguage.startsWith('zh') &&
    (!message || message === 'Ask the husky to leave' || message === 'Husky on duty')
  ) {
    return fallbackText;
  }

  return message || fallbackText;
}

let huskyIsActive = false;
let trackerRunning = false;
let currentUsageLimit = 30;
let currentBreakTime = 5;
let currentCustomDomains = [];
let currentUsageKey = '';
let currentHuskyEnabled = false;
let trackerRunId = 0;
let extensionContextValid = true;
let activeBreakEndsAt = 0;
let resetSeconds = () => {};
let stopTracker = () => {};
let stopCountdown = () => {};

function markExtensionContextInvalid() {
  extensionContextValid = false;
  trackerRunning = false;
  trackerRunId++;
}

function isExtensionContextError(error) {
  return String(error?.message || error || '').includes('Extension context invalidated');
}

function safeStorageGet(defaults, callback) {
  if (!extensionContextValid) return;

  try {
    chrome.storage.local.get(defaults, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        if (isExtensionContextError(error)) markExtensionContextInvalid();
        return;
      }

      callback(result);
    });
  } catch (error) {
    if (isExtensionContextError(error)) markExtensionContextInvalid();
  }
}

function safeStorageSet(values) {
  if (!extensionContextValid) return;

  try {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error && isExtensionContextError(error)) {
        markExtensionContextInvalid();
      }
    });
  } catch (error) {
    if (isExtensionContextError(error)) markExtensionContextInvalid();
  }
}

function safeRuntimeSendMessage(message) {
  if (!extensionContextValid) return;

  try {
    chrome.runtime.sendMessage(message, () => {
      const error = chrome.runtime.lastError;
      if (error && isExtensionContextError(error)) {
        markExtensionContextInvalid();
      }
    });
  } catch (error) {
    if (isExtensionContextError(error)) markExtensionContextInvalid();
  }
}

function safeRuntimeGetURL(path) {
  if (!extensionContextValid) return '';

  try {
    return chrome.runtime.getURL(path);
  } catch (error) {
    if (isExtensionContextError(error)) {
      markExtensionContextInvalid();
    }
    return '';
  }
}

function broadcastGlobalBreak(breakEndsAt) {
  safeRuntimeSendMessage({
    type: 'BROADCAST_GLOBAL_BREAK',
    payload: {
      type: 'SHOW_GLOBAL_HUSKY',
      breakEndsAt
    }
  });
}

function broadcastDomainBreak(usageKey, breakEndsAt) {
  safeRuntimeSendMessage({
    type: 'BROADCAST_DOMAIN_BREAK',
    payload: {
      type: 'SHOW_MONITORED_HUSKY',
      usageKey,
      breakEndsAt
    }
  });
}

function broadcastGlobalDismiss() {
  safeRuntimeSendMessage({
    type: 'BROADCAST_DISMISS',
    payload: {
      type: 'DISMISS_GLOBAL_HUSKY'
    }
  });
}

function broadcastDomainDismiss(usageKey) {
  safeRuntimeSendMessage({
    type: 'BROADCAST_DISMISS',
    payload: {
      type: 'DISMISS_MONITORED_HUSKY',
      usageKey
    }
  });
}

function resetScheduleAfterIdle() {
  safeRuntimeSendMessage({
    type: 'RESET_AFTER_IDLE'
  });
}

function saveMonitoredBreakEntries(breakEndsAt) {
  const updates = {};
  shared.normalizeDomainList(currentCustomDomains).forEach((domain) => {
    updates[getBreakStorageKey(domain)] = {
      breakEndsAt,
      updatedAt: Date.now()
    };
  });

  if (Object.keys(updates).length) {
    safeStorageSet(updates);
  }
}

function clearMonitoredBreakEntries() {
  saveMonitoredBreakEntries(0);
}

function mergeSettingsWithDefaults(settings) {
  return shared.normalizeSettings(settings);
}

function getMatchedDomain(settings) {
  return shared.normalizeDomainList(settings.customDomains).find((domain) =>
    shared.hostnameMatchesDomain(hostname, domain)
  ) || '';
}

function getCurrentUsageKey(settings) {
  if (settings.blockAll) return GLOBAL_USAGE_KEY;
  return getMatchedDomain(settings);
}

function getUsageStorageKey(usageKey) {
  return `${USAGE_STORAGE_KEY}:${usageKey}`;
}

function getBreakStorageKey(usageKey) {
  return `${BREAK_STORAGE_KEY}:${usageKey}`;
}

function loadUsageSeconds(usageKey, callback) {
  const storageKey = getUsageStorageKey(usageKey);

  safeStorageGet({ [storageKey]: null }, (result) => {
    const entry = result[storageKey];
    const now = Date.now();

    if (!entry || typeof entry !== 'object') {
      callback(0);
      return;
    }

    if (now - Number(entry.updatedAt || 0) > USAGE_STALE_AFTER_MS) {
      callback(0);
      return;
    }

    callback(Math.max(0, Number.parseInt(entry.seconds, 10) || 0));
  });
}

function saveUsageSeconds(usageKey, seconds) {
  if (!usageKey) return;

  safeStorageSet({
    [getUsageStorageKey(usageKey)]: {
      seconds: Math.max(0, seconds),
      updatedAt: Date.now()
    }
  });
}

function resetUsageSeconds(usageKey) {
  saveUsageSeconds(usageKey, 0);
}

function resetMonitoredUsageSeconds() {
  const updates = {};
  shared.normalizeDomainList(currentCustomDomains).forEach((domain) => {
    updates[getUsageStorageKey(domain)] = {
      seconds: 0,
      updatedAt: Date.now()
    };
  });

  if (Object.keys(updates).length) {
    safeStorageSet(updates);
  }
}

function resetBreakUsageSeconds(usageKey) {
  if (usageKey === GLOBAL_USAGE_KEY) {
    resetUsageSeconds(usageKey);
    return;
  }

  resetMonitoredUsageSeconds();
}

function loadBreakEntry(usageKey, callback) {
  safeStorageGet({ [getBreakStorageKey(usageKey)]: null }, (result) => {
    const entry = result[getBreakStorageKey(usageKey)];

    if (!entry || typeof entry !== 'object') {
      callback(null);
      return;
    }

    const breakEndsAt = Number(entry.breakEndsAt || 0);
    if (!breakEndsAt || Date.now() >= breakEndsAt) {
      clearBreakEntry(usageKey);
      callback(null);
      return;
    }

    callback({ breakEndsAt });
  });
}

function saveBreakEntry(usageKey, breakEndsAt) {
  if (!usageKey) return;

  safeStorageSet({
    [getBreakStorageKey(usageKey)]: {
      breakEndsAt,
      updatedAt: Date.now()
    }
  });
}

function clearBreakEntry(usageKey) {
  if (!usageKey) return;
  saveBreakEntry(usageKey, 0);
}

function applySettings(settings, { resetUsage = false, broadcast = true } = {}) {
  const mergedSettings = mergeSettingsWithDefaults(settings);
  currentUsageLimit = mergedSettings.usageLimit;
  currentBreakTime = mergedSettings.breakTime;
  currentCustomDomains = mergedSettings.customDomains;
  currentUsageKey = getCurrentUsageKey(mergedSettings);
  currentHuskyEnabled = mergedSettings.huskyEnabled && !mergedSettings.paused && !!currentUsageKey;

  if (!currentHuskyEnabled) {
    const shouldClearCurrentBreak = mergedSettings.huskyEnabled === false && !!currentUsageKey;

    stopTracker();
    if (shouldClearCurrentBreak) {
      activeBreakEndsAt = 0;
      clearBreakEntry(currentUsageKey);
      resetUsageSeconds(currentUsageKey);
    }
    dismissOverlay({
      restartTracking: false,
      clearBreak: shouldClearCurrentBreak,
      broadcast
    });
    return;
  }

  if (huskyIsActive) {
    if (currentUsageKey === GLOBAL_USAGE_KEY && activeBreakEndsAt > Date.now()) {
      saveBreakEntry(GLOBAL_USAGE_KEY, activeBreakEndsAt);
      if (broadcast) broadcastGlobalBreak(activeBreakEndsAt);
    }
    return;
  }

  if (!huskyIsActive) {
    loadBreakEntry(currentUsageKey, (entry) => {
      if (entry) {
        activateBreak(currentUsageKey, entry.breakEndsAt, { broadcast });
        return;
      }

      startTracking(currentUsageLimit, currentBreakTime, { resetUsage });
    });
  }
}

function activateBreak(usageKey, breakEndsAt, { broadcast = true } = {}) {
  if (
    huskyIsActive &&
    currentUsageKey === usageKey &&
    Math.abs(activeBreakEndsAt - breakEndsAt) < 1000
  ) {
    return;
  }

  stopTracker({ persistUsage: false });
  huskyIsActive = true;
  activeBreakEndsAt = breakEndsAt;
  resetBreakUsageSeconds(usageKey);
  saveBreakEntry(usageKey, breakEndsAt);
  if (usageKey === GLOBAL_USAGE_KEY && broadcast) {
    broadcastGlobalBreak(breakEndsAt);
  } else if (broadcast) {
    saveMonitoredBreakEntries(breakEndsAt);
    broadcastDomainBreak(usageKey, breakEndsAt);
  }
  showHuskyUntil(breakEndsAt, () => {
    huskyIsActive = false;
    activeBreakEndsAt = 0;
    clearBreakEntry(usageKey);
    if (currentHuskyEnabled && usageKey === currentUsageKey) {
      startTracking(currentUsageLimit, currentBreakTime, { resetUsage: true });
    }
  });
}

function startTracking(usageLimit, breakTime, { resetUsage = false } = {}) {
  stopTracker();
  const runId = ++trackerRunId;
  currentUsageLimit = usageLimit;
  currentBreakTime = breakTime;
  const usageKey = currentUsageKey;

  if (resetUsage) {
    resetUsageSeconds(usageKey);
  }

  loadUsageSeconds(usageKey, (initialSeconds) => {
    if (
      !extensionContextValid ||
      runId !== trackerRunId ||
      usageKey !== currentUsageKey ||
      huskyIsActive ||
      !currentHuskyEnabled
    ) {
      return;
    }

    trackerRunning = true;
    let localSeconds = resetUsage ? 0 : initialSeconds;
    let secondsSinceSave = 0;
    let shouldPersistUsage = true;
    let lastTickAt = Date.now();

    resetSeconds = ({ clearStoredUsage = false } = {}) => {
      if (clearStoredUsage) {
        shouldPersistUsage = false;
        localSeconds = 0;
        resetUsageSeconds(usageKey);
        return;
      }

      saveUsageSeconds(usageKey, localSeconds);
    };

    const tracker = setInterval(() => {
      if (!extensionContextValid) {
        clearInterval(tracker);
        trackerRunning = false;
        return;
      }

      if (usageKey !== currentUsageKey || huskyIsActive || !currentHuskyEnabled) {
        clearInterval(tracker);
        trackerRunning = false;
        return;
      }

      const now = Date.now();

      if (document.hidden) {
        lastTickAt = now;
        return;
      }

      const elapsedMs = now - lastTickAt;
      lastTickAt = now;

      if (elapsedMs > MAX_TRACKED_TICK_GAP_MS) {
        localSeconds = 0;
        resetUsageSeconds(usageKey);
        resetScheduleAfterIdle();
        secondsSinceSave = 0;
        return;
      }

      const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
      localSeconds += elapsedSeconds;
      secondsSinceSave += elapsedSeconds;

      if (secondsSinceSave >= USAGE_SAVE_INTERVAL_SECONDS) {
        saveUsageSeconds(usageKey, localSeconds);
        secondsSinceSave = 0;
      }

      if (localSeconds >= usageLimit * 60) {
        clearInterval(tracker);
        trackerRunning = false;
        huskyIsActive = true;
        shouldPersistUsage = false;
        localSeconds = 0;
        resetUsageSeconds(usageKey);
        activateBreak(usageKey, Date.now() + breakTime * 60 * 1000);
      }
    }, 1000);

    stopTracker = ({ persistUsage = true } = {}) => {
      trackerRunning = false;
      if (persistUsage && shouldPersistUsage) {
        saveUsageSeconds(usageKey, localSeconds);
      }
      clearInterval(tracker);
      trackerRunId++;
    };
  });
}

function createSnow() {
  const snow = document.createElement('div');
  snow.id = 'husky-gatekeeper-snow';

  Array.from({ length: 22 }, (_, index) => {
    const flake = document.createElement('span');
    flake.style.setProperty('--x', `${(index * 37) % 100}%`);
    flake.style.setProperty('--o', String(0.36 + ((index * 13) % 50) / 100));
    flake.style.animationDelay = `${-1 * ((index * 29) % 80) / 10}s`;
    flake.style.animationDuration = `${6 + ((index * 17) % 50) / 10}s`;
    snow.appendChild(flake);
  });

  return snow;
}

function createHuskyScene() {
  const scene = document.createElement('div');
  scene.id = 'husky-gatekeeper-scene';
  scene.setAttribute('aria-hidden', 'true');
  scene.innerHTML = `
    <svg viewBox="0 0 920 640" role="img" aria-label="A large husky lying across the page">
      <defs>
        <linearGradient id="husky-fur" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="#f8fbff"/>
          <stop offset="1" stop-color="#dce7ef"/>
        </linearGradient>
        <linearGradient id="husky-gray" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#485865"/>
          <stop offset="1" stop-color="#1f2c35"/>
        </linearGradient>
        <filter id="husky-shadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="28" stdDeviation="22" flood-color="#182733" flood-opacity="0.22"/>
        </filter>
      </defs>

      <ellipse cx="470" cy="585" rx="335" ry="34" fill="#152633" opacity="0.18"/>

      <g filter="url(#husky-shadow)">
        <path class="tail" d="M245 412 C116 380 79 270 140 205 C182 160 252 183 247 244 C243 294 203 310 181 284 C164 264 172 232 199 226 C222 221 236 237 235 259 C278 254 313 280 322 329 C331 381 294 418 245 412Z" fill="url(#husky-gray)"/>
        <path d="M303 297 C405 238 613 238 714 296 C803 347 803 478 719 526 C604 591 406 589 294 528 C210 482 213 349 303 297Z" fill="url(#husky-fur)"/>
        <path d="M290 296 C405 232 615 232 719 301 C677 363 591 392 500 384 C403 375 333 342 290 296Z" fill="url(#husky-gray)"/>
        <path d="M360 516 C390 548 454 560 504 550 C528 545 537 581 511 592 C453 616 365 599 329 551Z" fill="#eef5f9"/>
        <path d="M620 517 C654 548 715 553 760 535 C786 525 803 558 779 574 C720 612 633 596 586 552Z" fill="#eef5f9"/>

        <g transform="translate(500 245)">
          <path class="ear-left" d="M-162 18 L-220 -128 L-102 -63 Z" fill="#273640"/>
          <path class="ear-left" d="M-160 -5 L-196 -94 L-126 -55 Z" fill="#f0b8ac"/>
          <path class="ear-right" d="M138 16 L186 -132 L67 -60 Z" fill="#273640"/>
          <path class="ear-right" d="M130 -7 L160 -96 L92 -55 Z" fill="#f0b8ac"/>

          <path d="M-190 26 C-150 -88 71 -105 160 2 C235 91 176 215 43 232 C-108 251 -234 148 -190 26Z" fill="#f7fbff"/>
          <path d="M-185 29 C-145 -92 70 -103 158 3 C107 67 28 94 -54 83 C-121 73 -166 51 -185 29Z" fill="url(#husky-gray)"/>
          <path d="M-76 53 C-48 33 5 33 33 54 C22 89 -48 89 -76 53Z" fill="#f7fbff"/>

          <circle class="eye-open" cx="-88" cy="39" r="15" fill="#8bd7ff"/>
          <circle class="eye-open" cx="50" cy="42" r="15" fill="#8bd7ff"/>
          <circle class="eye-open" cx="-84" cy="38" r="6" fill="#15212a"/>
          <circle class="eye-open" cx="46" cy="41" r="6" fill="#15212a"/>
          <path class="eye-sleep" d="M-106 43 Q-88 57 -68 43" fill="none" stroke="#15212a" stroke-width="8" stroke-linecap="round"/>
          <path class="eye-sleep" d="M31 46 Q50 60 70 46" fill="none" stroke="#15212a" stroke-width="8" stroke-linecap="round"/>

          <path d="M-20 87 C-8 76 18 77 29 88 C25 105 -16 105 -20 87Z" fill="#17222b"/>
          <path d="M4 103 C3 128 -34 128 -48 112" fill="none" stroke="#17222b" stroke-width="7" stroke-linecap="round"/>
          <path d="M5 103 C9 128 48 127 61 111" fill="none" stroke="#17222b" stroke-width="7" stroke-linecap="round"/>
          <path d="M-38 133 C-14 153 25 154 50 133" fill="none" stroke="#d47d78" stroke-width="7" stroke-linecap="round"/>
        </g>

        <path class="paw-left" d="M278 491 C237 501 220 545 243 572 C269 602 335 587 350 551 C364 516 326 479 278 491Z" fill="#f7fbff"/>
        <path class="paw-right" d="M725 490 C769 498 789 539 769 569 C745 603 680 592 662 557 C644 522 676 481 725 490Z" fill="#f7fbff"/>
        <path d="M267 551 L330 538" stroke="#cbd9e2" stroke-width="8" stroke-linecap="round"/>
        <path d="M684 540 L747 552" stroke="#cbd9e2" stroke-width="8" stroke-linecap="round"/>
      </g>
    </svg>
  `;

  return scene;
}

function createHuskyStage() {
  const stage = document.createElement('div');
  stage.id = 'husky-gatekeeper-stage';
  let videoReady = false;

  function addVideoSources(video, basename) {
    const webmUrl = safeRuntimeGetURL(`assets/${basename}.webm`);
    const mp4Url = safeRuntimeGetURL(`assets/${basename}.mp4`);

    if (!webmUrl || !mp4Url) return false;

    const webmSource = document.createElement('source');
    webmSource.src = webmUrl;
    webmSource.type = 'video/webm';

    video.appendChild(webmSource);

    const mp4Source = document.createElement('source');
    mp4Source.src = mp4Url;
    mp4Source.type = 'video/mp4';

    video.appendChild(mp4Source);
    return true;
  }

  const enterVideo = document.createElement('video');
  enterVideo.className = 'husky-real-video husky-enter-video';
  enterVideo.autoplay = true;
  enterVideo.muted = true;
  enterVideo.playsInline = true;
  enterVideo.preload = 'auto';
  const enterSourcesReady = addVideoSources(enterVideo, 'husky-enter');

  const sleepVideo = document.createElement('video');
  sleepVideo.className = 'husky-real-video husky-sleep-video';
  sleepVideo.muted = true;
  sleepVideo.loop = true;
  sleepVideo.playsInline = true;
  sleepVideo.preload = 'auto';
  const sleepSourcesReady = addVideoSources(sleepVideo, 'husky-sleep');

  const fallbackScene = createHuskyScene();
  let enterStartedAt = 0;
  let sleepStarted = false;

  function useFallback() {
    if (videoReady) return;
    stage.classList.add('use-fallback');
    setTimeout(() => fallbackScene.classList.add('sleeping'), 2600);
  }

  function useVideoMode() {
    videoReady = true;
    stage.classList.remove('use-fallback');
    fallbackScene.classList.remove('sleeping');
  }

  function startEnterVideo() {
    sleepStarted = false;
    enterStartedAt = Date.now();
    videoReady = false;
    stage.classList.remove('use-fallback');
    stage.classList.remove('sleeping');
    fallbackScene.classList.remove('sleeping');
    sleepVideo.pause();
    sleepVideo.currentTime = 0;
    if (!enterSourcesReady || !sleepSourcesReady) {
      useFallback();
      return;
    }
    enterVideo.load();
    const playPromise = enterVideo.play();
    if (playPromise) {
      playPromise.catch(useFallback);
    }
  }

  function startSleepVideo() {
    if (sleepStarted) return;

    sleepStarted = true;
    stage.classList.add('sleeping');
    sleepVideo.play().catch(useFallback);
  }

  function queueSleepVideo() {
    const playedSeconds = (Date.now() - enterStartedAt) / 1000;
    const remainingMs = Math.max(0, (ENTER_VIDEO_MIN_SECONDS - playedSeconds) * 1000);
    setTimeout(startSleepVideo, remainingMs);
  }

  enterVideo.addEventListener('ended', () => {
    queueSleepVideo();
  });

  enterVideo.addEventListener('canplay', () => {
    useVideoMode();
    enterVideo.play().catch(useFallback);
  }, { once: true });
  enterVideo.addEventListener('loadeddata', useVideoMode, { once: true });
  enterVideo.addEventListener('playing', useVideoMode);
  enterVideo.addEventListener('error', useFallback);
  sleepVideo.addEventListener('error', useFallback);

  stage.appendChild(enterVideo);
  stage.appendChild(sleepVideo);
  stage.appendChild(fallbackScene);
  stage.startHuskyVideo = startEnterVideo;

  return { stage, fallbackScene };
}

function showHuskyUntil(breakEndsAt, onBreakEnd) {
  document.getElementById('husky-gatekeeper-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'husky-gatekeeper-overlay';
  overlay.style.setProperty('opacity', '1', 'important');

  const countdown = document.createElement('div');
  countdown.id = 'husky-gatekeeper-countdown';

  const label = document.createElement('p');
  label.className = 'husky-label';
  label.textContent = getUiMessage('overlayLabel', '哈士奇執勤中');

  const time = document.createElement('p');
  time.className = 'husky-time';
  time.textContent = '0:00';

  countdown.appendChild(label);
  countdown.appendChild(time);

  const { stage, fallbackScene } = createHuskyStage();
  const leaveButton = document.createElement('button');
  leaveButton.id = 'husky-gatekeeper-leave';
  leaveButton.type = 'button';
  leaveButton.textContent = getUiMessage('leaveButton', '讓哈士奇離開');
  leaveButton.addEventListener('click', () => {
    dismissOverlay();
  });
  let countdownCancelled = false;

  stopCountdown = () => {
    countdownCancelled = true;
  };

  function updateCountdown() {
    if (countdownCancelled) return;

    const seconds = Math.max(0, Math.ceil((breakEndsAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    time.textContent = `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;

    if (seconds > 0) {
      setTimeout(updateCountdown, 1000);
      return;
    }

    huskyIsActive = false;
    activeBreakEndsAt = 0;
    overlay.style.transition = 'opacity 0.8s ease';
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.remove();
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
      document.removeEventListener('wheel', preventScroll);
      document.removeEventListener('touchmove', preventScroll);
      onBreakEnd();
    }, 800);
  }

  overlay.appendChild(createSnow());
  countdown.appendChild(leaveButton);
  overlay.appendChild(countdown);
  overlay.appendChild(stage);
  document.body.appendChild(overlay);
  stage.startHuskyVideo?.();

  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  document.addEventListener('wheel', preventScroll, { passive: false });
  document.addEventListener('touchmove', preventScroll, { passive: false });

  document.querySelectorAll('video, audio').forEach((media) => {
    if (overlay.contains(media)) return;
    if (typeof media.pause === 'function') media.pause();
  });

  setTimeout(() => fallbackScene.classList.add('sleeping'), 2600);
  updateCountdown();
}

function dismissOverlay({ restartTracking = true, clearBreak = true, broadcast = true } = {}) {
  const overlay = document.getElementById('husky-gatekeeper-overlay');
  if (!overlay) return;

  const dismissedUsageKey = currentUsageKey;
  huskyIsActive = false;
  activeBreakEndsAt = 0;
  stopCountdown();

  if (clearBreak) {
    clearBreakEntry(dismissedUsageKey);
    resetUsageSeconds(dismissedUsageKey);
    if (dismissedUsageKey === GLOBAL_USAGE_KEY && broadcast) {
      broadcastGlobalDismiss();
    } else if (broadcast) {
      clearMonitoredBreakEntries();
      broadcastDomainDismiss(dismissedUsageKey);
    }
  }

  overlay.style.transition = 'opacity 0.5s ease';
  overlay.style.opacity = '0';
  setTimeout(() => {
    overlay.remove();
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    document.removeEventListener('wheel', preventScroll);
    document.removeEventListener('touchmove', preventScroll);
    if (restartTracking && currentHuskyEnabled && dismissedUsageKey === currentUsageKey) {
      startTracking(currentUsageLimit, currentBreakTime);
    }
  }, 500);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_HUSKY_STATUS') {
    sendResponse({
      huskyIsActive,
      hostname,
      trackerRunning,
      customDomains: currentCustomDomains,
      isTracked: currentHuskyEnabled,
      trackedDomain: currentUsageKey,
      breakEndsAt: activeBreakEndsAt,
      hasFocus: document.hasFocus(),
      isHidden: document.hidden
    });
    return;
  }

  if (message.type === 'UPDATE_HUSKY_SETTINGS') {
    stopTracker();
    applySettings(message.settings, { resetUsage: true });
  }

  if (message.type === 'DISMISS_HUSKY') {
    dismissOverlay();
  }

  if (message.type === 'SHOW_GLOBAL_HUSKY') {
    const breakEndsAt = Number(message.breakEndsAt || 0);
    if (!breakEndsAt || Date.now() >= breakEndsAt) return;

    safeStorageGet(null, (settings) => {
      const mergedSettings = mergeSettingsWithDefaults(settings);
      if (!mergedSettings.huskyEnabled || mergedSettings.paused || !mergedSettings.blockAll) return;

      currentUsageLimit = mergedSettings.usageLimit;
      currentBreakTime = mergedSettings.breakTime;
      currentCustomDomains = mergedSettings.customDomains;
      currentUsageKey = GLOBAL_USAGE_KEY;
      currentHuskyEnabled = true;
      activateBreak(GLOBAL_USAGE_KEY, breakEndsAt, { broadcast: false });
    });
  }

  if (message.type === 'SHOW_DOMAIN_HUSKY') {
    const usageKey = shared.normalizeDomainEntry(message.usageKey);
    const breakEndsAt = Number(message.breakEndsAt || 0);
    if (!usageKey || !breakEndsAt || Date.now() >= breakEndsAt) return;

    safeStorageGet(null, (settings) => {
      const mergedSettings = mergeSettingsWithDefaults(settings);
      if (
        !mergedSettings.huskyEnabled ||
        mergedSettings.paused ||
        mergedSettings.blockAll ||
        getMatchedDomain(mergedSettings) !== usageKey
      ) {
        return;
      }

      currentUsageLimit = mergedSettings.usageLimit;
      currentBreakTime = mergedSettings.breakTime;
      currentCustomDomains = mergedSettings.customDomains;
      currentUsageKey = usageKey;
      currentHuskyEnabled = true;
      activateBreak(usageKey, breakEndsAt, { broadcast: false });
    });
  }

  if (message.type === 'SHOW_MONITORED_HUSKY') {
    const breakEndsAt = Number(message.breakEndsAt || 0);
    if (!breakEndsAt || Date.now() >= breakEndsAt) return;

    safeStorageGet(null, (settings) => {
      const mergedSettings = mergeSettingsWithDefaults(settings);
      const usageKey = getMatchedDomain(mergedSettings);

      if (
        !mergedSettings.huskyEnabled ||
        mergedSettings.paused ||
        mergedSettings.blockAll ||
        !usageKey
      ) {
        return;
      }

      currentUsageLimit = mergedSettings.usageLimit;
      currentBreakTime = mergedSettings.breakTime;
      currentCustomDomains = mergedSettings.customDomains;
      currentUsageKey = usageKey;
      currentHuskyEnabled = true;
      activateBreak(usageKey, breakEndsAt, { broadcast: false });
    });
  }

  if (message.type === 'DISMISS_GLOBAL_HUSKY') {
    if (currentUsageKey !== GLOBAL_USAGE_KEY && !huskyIsActive) return;
    dismissOverlay({ restartTracking: false, clearBreak: false, broadcast: false });
  }

  if (message.type === 'DISMISS_DOMAIN_HUSKY') {
    const usageKey = shared.normalizeDomainEntry(message.usageKey);
    if (!usageKey || currentUsageKey !== usageKey || !huskyIsActive) return;
    dismissOverlay({ restartTracking: false, clearBreak: false, broadcast: false });
  }

  if (message.type === 'DISMISS_MONITORED_HUSKY') {
    if (!huskyIsActive) return;

    safeStorageGet(null, (settings) => {
      const mergedSettings = mergeSettingsWithDefaults(settings);
      if (!getMatchedDomain(mergedSettings)) return;
      dismissOverlay({ restartTracking: false, clearBreak: false, broadcast: false });
    });
  }
});

window.addEventListener('pagehide', () => {
  resetSeconds();
});

safeStorageGet(null, (settings) => {
  applySettings(settings, { broadcast: false });
});

})();
