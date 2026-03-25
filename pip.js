let lastHash = "";
let pinned = false;
let activePipWindow = null;
let pipCompact = false;
let pipRestoreBounds = null;
let pipOpening = false;
let settingsLoaded = false;
let playSoundOnNewPosts = false;
let notificationSound = "bell";
let notificationVolume = 1;
let audioContext = null;
let hasRenderedFeedOnce = false;
let notifiedItemKeys = new Set();
let surfacePort = null;
let lastSoundPlayedAt = 0;
const DEFAULT_PIP_WIDTH = 400;
const DEFAULT_PIP_HEIGHT = 580;
const LAUNCHER_PIP_WIDTH = 720;
const LAUNCHER_PIP_HEIGHT = 360;
const COMPACT_PIP_WIDTH = 25;
const COMPACT_PIP_HEIGHT = 25;
const supportsDocumentPiP = "documentPictureInPicture" in window;
const FEED_STORAGE_KEYS = ["tweets"];
const MIN_SOUND_GAP_MS = 2000;
const NOTIFIED_ITEM_KEY_LIMIT = 1000;
const surfaceType = document.body?.dataset.surface || "pip-window";
const isPiPWindowSurface = surfaceType === "pip-window";

function isContextInvalidatedError(error) {
  return !!error && /Extension context invalidated/i.test(String(error.message || error));
}

function hasValidExtensionContext() {
  try {
    return !!chrome?.runtime?.id;
  } catch (error) {
    return false;
  }
}

function showExtensionReloadMessage() {
  const launcher = document.getElementById("launcher");
  const feedEl = document.getElementById("f");
  if (launcher) {
    launcher.style.display = "flex";
    launcher.innerHTML =
      '<div class="launcher-card">' +
      '<div class="launcher-title">Extension Reloaded</div>' +
      '<div class="launcher-copy">This surface belongs to an older extension context. Close it and reopen the feed from the current extension.</div>' +
      '</div>';
  }
  if (feedEl) {
    feedEl.style.display = "block";
    feedEl.innerHTML = '<div class="e">Extension reloaded. Close and reopen this feed.</div>';
  }
}

function safeStorageGet(keys, callback) {
  if (!hasValidExtensionContext()) {
    showExtensionReloadMessage();
    return false;
  }
  try {
    chrome.storage.local.get(keys, (data) => {
      void chrome.runtime.lastError;
      callback(data || {});
    });
    return true;
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.warn("Storage read failed:", error);
    }
    return false;
  }
}

function safeSyncStorageGet(keys, callback) {
  if (!hasValidExtensionContext()) {
    showExtensionReloadMessage();
    return false;
  }
  try {
    chrome.storage.sync.get(keys, (data) => {
      void chrome.runtime.lastError;
      callback(data || {});
    });
    return true;
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.warn("Sync storage read failed:", error);
    }
    return false;
  }
}

function safeRuntimeMessage(message) {
  if (!hasValidExtensionContext()) {
    showExtensionReloadMessage();
    return false;
  }
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
    return true;
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.warn("Runtime message failed:", error);
    }
    return false;
  }
}

function connectFeedSurface() {
  if (surfacePort || !hasValidExtensionContext()) {
    return;
  }

  try {
    surfacePort = chrome.runtime.connect({ name: "feed-surface:" + surfaceType });
    surfacePort.onDisconnect.addListener(() => {
      surfacePort = null;
      if (!hasValidExtensionContext()) {
        showExtensionReloadMessage();
      }
    });
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.warn("Failed to connect feed surface:", error);
    }
  }
}

function isFeedStorageChange(changes, areaName) {
  return areaName === "local" && !!changes.tweets;
}

function copyStylesToWindow(targetDoc) {
  for (const sheet of document.styleSheets) {
    try {
      const style = targetDoc.createElement("style");
      for (const rule of sheet.cssRules) {
        style.textContent += rule.cssText + "\n";
      }
      targetDoc.head.appendChild(style);
    } catch (error) {
      // Some stylesheets expose cssRules but still throw SecurityError/DOMException.
      const ownerNode = sheet.ownerNode;
      if (ownerNode instanceof HTMLStyleElement) {
        targetDoc.head.appendChild(ownerNode.cloneNode(true));
      } else if (ownerNode instanceof HTMLLinkElement && ownerNode.href) {
        const link = targetDoc.createElement("link");
        link.rel = "stylesheet";
        link.href = ownerNode.href;
        targetDoc.head.appendChild(link);
      } else if (!isContextInvalidatedError(error)) {
        console.warn("Failed to copy stylesheet into PiP window:", error);
      }
    }
  }
}

function formatTime() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

function formatTimestamp(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    if (isNaN(d)) return ts;
    if (Date.now() - d < 86400000) {
      return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  } catch(e) { return ts; }
}

function esc(s) {
  if (!s) return "";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function rememberPipBounds(win) {
  pipRestoreBounds = {
    width: win.outerWidth || DEFAULT_PIP_WIDTH,
    height: win.outerHeight || DEFAULT_PIP_HEIGHT,
    left: typeof win.screenX === "number" ? win.screenX : undefined,
    top: typeof win.screenY === "number" ? win.screenY : undefined,
  };
}

function togglePinnedCompactMode() {
  if (!activePipWindow || activePipWindow.closed) return;

  if (!pipCompact) {
    rememberPipBounds(activePipWindow);
    const screenLeft = typeof activePipWindow.screen?.availLeft === "number"
      ? activePipWindow.screen.availLeft
      : (typeof activePipWindow.screenX === "number" ? activePipWindow.screenX : 0);
    const screenTop = typeof activePipWindow.screen?.availTop === "number"
      ? activePipWindow.screen.availTop
      : 0;
    const screenWidth = activePipWindow.screen?.availWidth || activePipWindow.screen?.width || DEFAULT_PIP_WIDTH;
    activePipWindow.resizeTo(COMPACT_PIP_WIDTH, COMPACT_PIP_HEIGHT);
    activePipWindow.moveTo(
      Math.max(screenLeft, Math.round(screenLeft + screenWidth - COMPACT_PIP_WIDTH)),
      Math.max(screenTop, Math.round(screenTop))
    );
    pipCompact = true;
    return;
  }

  activePipWindow.resizeTo(
    pipRestoreBounds?.width || DEFAULT_PIP_WIDTH,
    pipRestoreBounds?.height || DEFAULT_PIP_HEIGHT
  );
  if (typeof pipRestoreBounds?.left === "number" && typeof pipRestoreBounds?.top === "number") {
    activePipWindow.moveTo(pipRestoreBounds.left, pipRestoreBounds.top);
  }
  pipCompact = false;
}

function resizeCurrentWindow(width, height) {
  if (!(chrome.windows?.getCurrent && chrome.windows?.update)) return;
  chrome.windows.getCurrent((w) => {
    if (w?.id !== undefined) {
      chrome.windows.update(w.id, { width, height, focused: true });
    }
  });
}

function notifyPinnedPiPState(active) {
  if (!hasValidExtensionContext()) return;
  try {
    chrome.runtime.sendMessage({ action: "setPinnedPiPActive", active }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}

function setLauncherMode(active) {
  const launcher = document.getElementById("launcher");
  if (launcher) launcher.style.display = active ? "flex" : "none";
  if (feed) feed.style.display = active ? "none" : "block";
  document.body.classList.toggle("launcher-mode", active);
}

function getSourceKey(item) {
  return item.source || "x";
}

function getFeedKey(item) {
  return [
    getSourceKey(item),
    item.isRetweet ? "1" : "0",
    item.repostedByAccount || "",
    item.retweetedBy || "",
    item.url || "",
    item.account || "",
    item.originalAccount || "",
    item.activityTimestamp || "",
    item.timestamp || "",
    item.text || "",
    item.recentCycle ?? "",
    item.isNew ? "1" : "0",
    item.isLastBatch ? "1" : "0",
  ].join("|");
}

function getStableItemKey(item) {
  if (item?.isRetweet) {
    return [
      getSourceKey(item),
      "repost",
      item.repostedByAccount || item.retweetedBy || item.retweetContext || "RT",
      item.url || "",
      item.account || "",
      item.originalAccount || "",
    ].join("|");
  }
  return item?.url || [
    getSourceKey(item),
    item?.account || "",
    item?.timestamp || "",
    item?.text || "",
  ].join("|");
}

function getTimestampValue(item) {
  const sortTimestamp = item?.activityTimestamp || item?.timestamp;
  const value = sortTimestamp ? new Date(sortTimestamp).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

function getRecencyStage(item) {
  if (item?.isNew || item?.recentCycle === 0) {
    return "new";
  }
  if (item?.isLastBatch || item?.recentCycle === 1) {
    return "last-batch";
  }
  return "";
}

function mergeFeeds(xItems) {
  return [...(xItems || [])]
    .sort((a, b) => {
      return getTimestampValue(b) - getTimestampValue(a);
    })
    .slice(0, 200);
}

function loadSettings() {
  safeSyncStorageGet(["playSoundOnNewPosts", "notificationSound", "notificationVolume"], (data) => {
    playSoundOnNewPosts = data.playSoundOnNewPosts ?? true;
    notificationSound = data.notificationSound || "bell";
    const volumePercent = Number.isFinite(data.notificationVolume) ? data.notificationVolume : 100;
    notificationVolume = Math.min(Math.max(volumePercent / 100, 0), 10);
    settingsLoaded = true;
  });
}

function ensureAudioContext() {
  if (audioContext || typeof window.AudioContext === "undefined") {
    return audioContext;
  }
  try {
    audioContext = new window.AudioContext();
  } catch (error) {
    console.warn("Audio init failed:", error);
  }
  return audioContext;
}

function playNewPostSound() {
  if (!playSoundOnNewPosts || !settingsLoaded) return;
  if (Date.now() - lastSoundPlayedAt < MIN_SOUND_GAP_MS) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  lastSoundPlayedAt = Date.now();

  const now = ctx.currentTime;
  const volume = Math.max(0.0001, notificationVolume * 0.12);
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(volume, now);
  masterGain.connect(ctx.destination);

  const playTone = (type, frequency, start, duration, peakGain) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gainNode.gain.setValueAtTime(0.0001, start);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0002, peakGain), start + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gainNode);
    gainNode.connect(masterGain);
    oscillator.start(start);
    oscillator.stop(start + duration);
  };

  if (notificationSound === "bell") {
    playTone("sine", 1046, now, 0.32, 0.7);
    playTone("sine", 1318, now + 0.03, 0.28, 0.45);
    return;
  }

  if (notificationSound === "pop") {
    playTone("square", 520, now, 0.09, 0.9);
    playTone("triangle", 760, now + 0.07, 0.08, 0.55);
    return;
  }

  playTone("triangle", 880, now, 0.16, 0.75);
  playTone("triangle", 660, now + 0.08, 0.16, 0.5);
}

function rememberItemKeys(targetSet, tweets) {
  (tweets || []).forEach((item) => {
    targetSet.add(getStableItemKey(item));
  });

  while (targetSet.size > NOTIFIED_ITEM_KEY_LIMIT) {
    const oldestKey = targetSet.values().next().value;
    if (!oldestKey) {
      break;
    }
    targetSet.delete(oldestKey);
  }
}

function hasUnnotifiedItems(tweets, notifiedKeys) {
  return (tweets || []).some((item) => {
    if (!item?.isNew) {
      return false;
    }
    return !notifiedKeys.has(getStableItemKey(item));
  });
}

function buildHTML(tweets) {
  let html = "";
  tweets.forEach((t, i) => {
    const urlAttr = t.url ? 'data-url="' + esc(t.url) + '"' : '';
    const recencyStage = getRecencyStage(t);
    const stateClass = (recencyStage ? " " + recencyStage : "") + " " + getSourceKey(t);
    const headerAccount = t.isRetweet
      ? (t.repostedByAccount || t.retweetedBy || t.account)
      : t.account;
    const rtBadge = t.isRetweet
      ? '<span class="rt-icon">\u21BB</span><span class="rt">@' + esc(t.originalAccount || t.account || "unknown") + '</span>'
      : '';
    const tsDisplay = formatTimestamp(t.activityTimestamp || t.timestamp);
    html += '<div class="t' + stateClass + '" ' + urlAttr + '>' +
      '<div class="h">' +
        '<span class="a">@' + esc(headerAccount) + '</span>' +
        rtBadge +
        (i === 0
          ? '<span class="c" id="ck">' + formatTime() + '</span>'
          : (tsDisplay ? '<span class="ts">' + esc(tsDisplay) + '</span>' : '')) +
      '</div>' +
      '<div class="x">' + esc(t.text) + '</div>' +
      '</div>';
  });
  return html;
}

function addClickHandlers(container) {
  container.querySelectorAll(".t[data-url]").forEach(el => {
    el.addEventListener("click", () => {
      window.open(el.dataset.url, "_blank");
    });
  });
}

const feed = document.getElementById("f");
const usesLauncherSurface = isPiPWindowSurface && supportsDocumentPiP;

function initializePanelControls() {
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      safeRuntimeMessage({ action: "refreshScrapersNow" });
    });
  }

  const openPipBtn = document.getElementById("open-pip-btn");
  if (openPipBtn) {
    openPipBtn.addEventListener("click", () => {
      safeRuntimeMessage({ action: "openPiPWindow" });
    });
  }

  const settingsBtn = document.getElementById("settings-btn");
  if (settingsBtn && chrome.runtime?.openOptionsPage) {
    settingsBtn.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
  }
}

function refresh() {
  if (usesLauncherSurface && !pinned) return;
  if (!safeStorageGet(FEED_STORAGE_KEYS, (data) => {
    const tweets = mergeFeeds(data.tweets);
    if (!tweets.length) {
      if (!lastHash) feed.innerHTML = '<div class="e">Waiting for posts...</div>';
      return;
    }
    const newHash = tweets.map(getFeedKey).join("|");
    if (newHash === lastHash) return;
    const shouldPlaySound = !usesLauncherSurface &&
      hasRenderedFeedOnce &&
      hasUnnotifiedItems(tweets, notifiedItemKeys);
    lastHash = newHash;
    feed.innerHTML = buildHTML(tweets);
    addClickHandlers(feed);
    rememberItemKeys(notifiedItemKeys, tweets);
    if (!usesLauncherSurface && shouldPlaySound) {
      playNewPostSound();
    }
    if (!usesLauncherSurface) hasRenderedFeedOnce = true;
  })) {
    return;
  }
}

loadSettings();
refresh();
setInterval(() => {
  const ck = document.getElementById("ck");
  if (ck) ck.textContent = formatTime();
}, 1000);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (isFeedStorageChange(changes, areaName)) {
    refresh();
    return;
  }
  if (areaName === "sync" && Object.prototype.hasOwnProperty.call(changes, "playSoundOnNewPosts")) {
    playSoundOnNewPosts = changes.playSoundOnNewPosts.newValue ?? true;
    settingsLoaded = true;
  }
  if (areaName === "sync" && Object.prototype.hasOwnProperty.call(changes, "notificationSound")) {
    notificationSound = changes.notificationSound.newValue || "bell";
    settingsLoaded = true;
  }
  if (areaName === "sync" && Object.prototype.hasOwnProperty.call(changes, "notificationVolume")) {
    const volumePercent = Number.isFinite(changes.notificationVolume.newValue)
      ? changes.notificationVolume.newValue
      : 100;
    notificationVolume = Math.min(Math.max(volumePercent / 100, 0), 10);
    settingsLoaded = true;
  }
});

// ── Auto-pin to top on first interaction ──
// Document PiP needs a user gesture — any click/touch on this page counts
async function pinToTop() {
  const pinBtn = document.getElementById("pin-btn");

  try {
    if (pinned) return;
    if (pipOpening) return;
    if (!supportsDocumentPiP) return;
    if (!hasValidExtensionContext()) {
      showExtensionReloadMessage();
      return;
    }

    if (pinBtn) {
      pinBtn.disabled = true;
      pinBtn.textContent = "Opening...";
    }

    const ctx = ensureAudioContext();
    if (ctx?.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    pipOpening = true;
    const pipWin = await window.documentPictureInPicture.requestWindow({
      width: 400,
      height: 580,
    });
    pinned = true;
    activePipWindow = pipWin;
    pipCompact = false;
    rememberPipBounds(pipWin);
    notifyPinnedPiPState(true);

    const doc = pipWin.document;
    copyStylesToWindow(doc);
    doc.body.innerHTML = '<div id="f"><div class="e">Loading...</div></div>';
    const pipFeed = doc.getElementById("f");

    let pipHash = "";
    let si = null;
    let ci = null;
    let storageListener = null;
    let pipHasRenderedOnce = false;
    let pipNotifiedItemKeys = new Set();
    function pipRefresh() {
      if (!safeStorageGet(FEED_STORAGE_KEYS, (data) => {
        const tweets = mergeFeeds(data.tweets);
        const h = tweets.map(getFeedKey).join("|");
        if (h === pipHash) return;
        const shouldPlaySound = pipHasRenderedOnce &&
          hasUnnotifiedItems(tweets, pipNotifiedItemKeys);
        pipHash = h;
        pipFeed.innerHTML = buildHTML(tweets) || '<div class="e">Waiting for posts...</div>';
        addClickHandlers(pipFeed);
        rememberItemKeys(pipNotifiedItemKeys, tweets);
        if (shouldPlaySound) {
          playNewPostSound();
        }
        pipHasRenderedOnce = true;
      })) {
        clearInterval(si);
        clearInterval(ci);
      }
    }

    pipRefresh();
    storageListener = (changes, areaName) => {
      if (isFeedStorageChange(changes, areaName)) {
        pipRefresh();
      }
    };
    chrome.storage.onChanged.addListener(storageListener);
    si = setInterval(pipRefresh, 5000);
    ci = setInterval(() => {
      const ck = doc.getElementById("ck");
      if (ck) ck.textContent = formatTime();
    }, 1000);

    pipWin.addEventListener("pagehide", () => {
      clearInterval(si);
      clearInterval(ci);
      if (storageListener) {
        chrome.storage.onChanged.removeListener(storageListener);
      }
      pinned = false;
      activePipWindow = null;
      pipCompact = false;
      pipRestoreBounds = null;
      notifyPinnedPiPState(false);
      window.close();
    });

    // Minimize this host window — user only sees the PiP
    if (chrome.windows?.getCurrent && chrome.windows?.update) {
      chrome.windows.getCurrent((w) => {
        if (w?.id !== undefined) {
          chrome.windows.update(w.id, { state: "minimized" });
        }
      });
    }

  } catch(e) {
    if (isContextInvalidatedError(e)) {
      showExtensionReloadMessage();
      return;
    }
    console.error("PiP failed:", e?.name ? e.name + ": " + e.message : e);
    if (pinBtn) {
      pinBtn.disabled = false;
      pinBtn.textContent = "Open PiP";
    }
  } finally {
    pipOpening = false;
  }
}

window.addEventListener("error", (event) => {
  if (isContextInvalidatedError(event.error || event.message)) {
    event.preventDefault();
    showExtensionReloadMessage();
  }
});

window.addEventListener("unhandledrejection", (event) => {
  if (isContextInvalidatedError(event.reason)) {
    event.preventDefault();
    showExtensionReloadMessage();
  }
});

if (!hasValidExtensionContext()) {
  showExtensionReloadMessage();
} else {
  connectFeedSurface();
  initializePanelControls();

  if (usesLauncherSurface) {
    setLauncherMode(true);
    resizeCurrentWindow(LAUNCHER_PIP_WIDTH, LAUNCHER_PIP_HEIGHT);
    const pinBtn = document.getElementById("pin-btn");
    if (pinBtn) {
      pinBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        pinToTop();
      });
    }
    const launcher = document.getElementById("launcher");
    if (launcher) launcher.addEventListener("click", pinToTop);
  } else {
    setLauncherMode(false);
    if (isPiPWindowSurface) {
      resizeCurrentWindow(DEFAULT_PIP_WIDTH, DEFAULT_PIP_HEIGHT);
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "toggleCompactPinnedPiP") {
    togglePinnedCompactMode();
  }
});

window.addEventListener("beforeunload", () => {
  notifyPinnedPiPState(false);
});
