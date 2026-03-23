// ── BACKGROUND SERVICE WORKER ──
// Manages dedicated inactive scraper tabs and periodic refresh.
// The user's active tab is never repurposed for scraping.

let xScraperTabId = null;
let truthScraperTabId = null;
let pipWindowId = null;
let pipWindowCompact = false;
let pipWindowRestoreBounds = null;
let pinnedPiPActive = false;
let sessionClosing = false;
let translationCache = null;
const translationRequests = new Map();
const X_SCRAPER_URL = "https://x.com/home?filter=follows";
const TRUTH_SCRAPER_URL = "https://truthsocial.com/@realDonaldTrump";
const DEFAULT_PIP_WIDTH = 400;
const DEFAULT_PIP_HEIGHT = 580;
const LAUNCHER_PIP_WIDTH = 720;
const LAUNCHER_PIP_HEIGHT = 360;
const COMPACT_PIP_WIDTH = 25;
const COMPACT_PIP_HEIGHT = 25;
const TRANSLATION_CACHE_STORAGE_KEY = "translationCacheV1";
const TRANSLATION_CACHE_LIMIT = 500;

const SCRAPERS = {
  x: {
    label: "X",
    storageKey: "xScraperTabId",
    url: X_SCRAPER_URL,
  },
  truth: {
    label: "Truth",
    storageKey: "truthScraperTabId",
    url: TRUTH_SCRAPER_URL,
  },
};

function safeBroadcastRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}

function getScraperTabId(kind) {
  return kind === "truth" ? truthScraperTabId : xScraperTabId;
}

function setScraperTabId(kind, tabId) {
  if (kind === "truth") {
    truthScraperTabId = tabId;
    return;
  }
  xScraperTabId = tabId;
}

function isTrackedScraperTab(tabId) {
  return tabId === xScraperTabId || tabId === truthScraperTabId;
}

// ── Default settings ──
const DEFAULTS = {
  refreshInterval: 20,
  playSoundOnNewPosts: true,
  notificationSound: "bell",
  notificationVolume: 100,
  translateAccounts: [
    { username: "AJABreaking", fromLang: "ar" },
    { username: "idfonline", fromLang: "he" },
    { username: "mb_ghalibaf", fromLang: "fa" },
    { username: "Attaqa2", fromLang: "ar" },
    { username: "anasalhajji", fromLang: "ar" },
    { username: "Rahbarenghelab_", fromLang: "fa" },
    { username: "Khamenei_fa", fromLang: "fa" },
    { username: "alilarijani_ir", fromLang: "fa" },
  ],
};

function sanitizeRefreshInterval(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULTS.refreshInterval;
  }
  return Math.min(Math.max(parsed, 10), 30);
}

function scheduleRefreshAlarm(refreshInterval) {
  chrome.alarms.create("refreshScraper", {
    periodInMinutes: sanitizeRefreshInterval(refreshInterval) / 60,
  });
}

function clearRefreshSchedule() {
  chrome.alarms.clear("refreshScraper");
}

function normalizeTranslateAccounts(accounts) {
  if (!Array.isArray(accounts)) {
    return DEFAULTS.translateAccounts;
  }

  return accounts
    .map((account) => {
      const username = String(account?.username || "").trim().replace(/^@/, "");
      const fromLang = String(account?.fromLang || "").trim().toLowerCase();
      if (!username || !fromLang) {
        return null;
      }
      return { username, fromLang };
    })
    .filter(Boolean)
    .slice(0, 100);
}

async function getSettings() {
  const data = await chrome.storage.sync.get([
    "refreshInterval",
    "playSoundOnNewPosts",
    "notificationSound",
    "notificationVolume",
    "translateAccounts",
  ]);
  return {
    refreshInterval: sanitizeRefreshInterval(data.refreshInterval),
    playSoundOnNewPosts: data.playSoundOnNewPosts ?? DEFAULTS.playSoundOnNewPosts,
    notificationSound: data.notificationSound || DEFAULTS.notificationSound,
    notificationVolume: Number.isFinite(data.notificationVolume)
      ? data.notificationVolume
      : DEFAULTS.notificationVolume,
    translateAccounts: normalizeTranslateAccounts(data.translateAccounts),
  };
}

async function getTranslationCache() {
  if (translationCache) {
    return translationCache;
  }

  const data = await chrome.storage.session.get(TRANSLATION_CACHE_STORAGE_KEY);
  translationCache = data[TRANSLATION_CACHE_STORAGE_KEY] || {};
  return translationCache;
}

function pruneTranslationCache(cache) {
  const entries = Object.entries(cache || {});
  if (entries.length <= TRANSLATION_CACHE_LIMIT) {
    return cache;
  }

  entries.sort((a, b) => {
    return (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0);
  });

  return Object.fromEntries(entries.slice(0, TRANSLATION_CACHE_LIMIT));
}

async function persistTranslationCache() {
  if (!translationCache) {
    return;
  }

  translationCache = pruneTranslationCache(translationCache);
  await chrome.storage.session.set({
    [TRANSLATION_CACHE_STORAGE_KEY]: translationCache,
  });
}

function getTranslationCacheKey(text, fromLang) {
  return fromLang + "\n" + text;
}

async function translateViaGoogle(text, fromLang) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", fromLang);
  url.searchParams.set("tl", "en");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Translation request failed: " + response.status);
  }

  const data = await response.json();
  let translated = "";
  if (Array.isArray(data?.[0])) {
    data[0].forEach((part) => {
      if (part?.[0]) {
        translated += part[0];
      }
    });
  }

  return translated || text;
}

async function translateText(text, fromLang) {
  if (!text || !fromLang) {
    return text;
  }

  const cacheKey = getTranslationCacheKey(text, fromLang);
  const cache = await getTranslationCache();
  const cachedEntry = cache[cacheKey];
  if (cachedEntry?.translated) {
    cachedEntry.updatedAt = Date.now();
    return cachedEntry.translated;
  }

  if (translationRequests.has(cacheKey)) {
    return translationRequests.get(cacheKey);
  }

  const request = (async () => {
    try {
      const translated = await translateViaGoogle(text, fromLang);
      cache[cacheKey] = {
        translated,
        updatedAt: Date.now(),
      };
      await persistTranslationCache();
      return translated;
    } catch (error) {
      console.warn("[BG] Translation failed:", error);
      return text;
    }
  })();

  translationRequests.set(cacheKey, request);

  try {
    return await request;
  } finally {
    translationRequests.delete(cacheKey);
  }
}

async function translateBatch(items) {
  const requests = Array.isArray(items) ? items : [];
  const translations = new Array(requests.length);
  let nextIndex = 0;
  const workerCount = Math.min(4, requests.length);

  async function worker() {
    while (nextIndex < requests.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const request = requests[currentIndex];
      translations[currentIndex] = await translateText(
        String(request?.text || ""),
        String(request?.fromLang || "").trim().toLowerCase(),
      );
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return translations;
}

async function safeSendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // Ignore tabs where the content script is not present.
  }
}

async function getCenteredPopupBounds(width, height) {
  try {
    const win = await chrome.windows.getLastFocused();
    if (typeof win?.left !== "number" || typeof win?.top !== "number" || !win.width || !win.height) {
      return {};
    }
    return {
      left: Math.max(0, Math.round(win.left + (win.width - width) / 2)),
      top: Math.max(0, Math.round(win.top + (win.height - height) / 2)),
    };
  } catch (e) {
    return {};
  }
}

async function getTopRightPopupBounds(targetWindowId, width, height) {
  try {
    const [targetWindow, displays] = await Promise.all([
      chrome.windows.get(targetWindowId),
      chrome.system.display.getInfo(),
    ]);
    const centerX = (targetWindow.left || 0) + (targetWindow.width || width) / 2;
    const centerY = (targetWindow.top || 0) + (targetWindow.height || height) / 2;
    const display = displays.find((d) => {
      const area = d.workArea;
      return centerX >= area.left &&
        centerX <= area.left + area.width &&
        centerY >= area.top &&
        centerY <= area.top + area.height;
    }) || displays[0];

    if (!display?.workArea) return {};

    return {
      left: Math.max(display.workArea.left, Math.round(display.workArea.left + display.workArea.width - width)),
      top: Math.max(display.workArea.top, Math.round(display.workArea.top)),
    };
  } catch (e) {
    return {};
  }
}

async function broadcastPiPStatus(active) {
  const tabs = await chrome.tabs.query({
    url: [
      "https://x.com/*",
      "https://twitter.com/*",
      "https://truthsocial.com/*",
    ],
  });
  for (const tab of tabs) {
    await safeSendToTab(tab.id, { action: "pipStatusChanged", active });
  }
}

async function ensureScraperTab(kind) {
  const config = SCRAPERS[kind];
  let tabId = getScraperTabId(kind);
  if (tabId) {
    try {
      await chrome.tabs.get(tabId);
      return tabId;
    } catch (e) {
      setScraperTabId(kind, null);
      tabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    url: config.url,
    active: false,
    pinned: true,
  });
  setScraperTabId(kind, tab.id);
  await chrome.storage.local.set({ [config.storageKey]: tab.id });
  console.log("[BG] Created " + config.label + " scraper tab:", tab.id);
  return tab.id;
}

async function ensureScraperTabs() {
  await Promise.all([
    ensureScraperTab("x"),
    ensureScraperTab("truth"),
  ]);
}

async function removeTabIfPresent(tabId) {
  if (!tabId) {
    return;
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {}
}

async function refreshScraperTabs() {
  if (sessionClosing) {
    return;
  }

  const data = await chrome.storage.local.get("pipActive");
  if (!data.pipActive) {
    clearRefreshSchedule();
    return;
  }

  await Promise.all(Object.keys(SCRAPERS).map(async (kind) => {
    const config = SCRAPERS[kind];
    try {
      const tabId = await ensureScraperTab(kind);
      await chrome.tabs.reload(tabId);
      console.log("[BG] Refreshed " + config.label + " scraper tab:", tabId);
    } catch (e) {
      console.warn("[BG] " + config.label + " refresh failed:", e);
      setScraperTabId(kind, null);
      await chrome.storage.local.remove(config.storageKey);
    }
  }));
}

function scheduleRefreshLoop(refreshInterval) {
  const intervalSeconds = sanitizeRefreshInterval(refreshInterval);
  clearRefreshSchedule();

  if (intervalSeconds >= 30) {
    scheduleRefreshAlarm(intervalSeconds);
  }
}

// ── Alarm-based refresh ──
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshScraper") {
    refreshScraperTabs();
  }
});

async function startPiP() {
  const settings = await getSettings();
  await chrome.storage.local.set({ pipActive: true, tweets: [], truthTweets: [] });
  await ensureScraperTabs();
  await broadcastPiPStatus(true);
  scheduleRefreshLoop(settings.refreshInterval);
  console.log("[BG] PiP started, refreshing every", settings.refreshInterval, "s");
}

async function stopPiPInternal() {
  clearRefreshSchedule();
  await chrome.storage.local.set({ pipActive: false });

  const tabsToRemove = [xScraperTabId, truthScraperTabId].filter(Boolean);
  xScraperTabId = null;
  truthScraperTabId = null;
  await Promise.all(tabsToRemove.map(removeTabIfPresent));

  pipWindowCompact = false;
  pipWindowRestoreBounds = null;
  pinnedPiPActive = false;
  await chrome.storage.local.remove([
    "scraperTabId",
    "xScraperTabId",
    "truthScraperTabId",
    "tweets",
    "truthTweets",
  ]);
  await broadcastPiPStatus(false);
  console.log("[BG] PiP stopped — alarms cleared, scraper tabs closed");
}

async function stopPiP() {
  if (sessionClosing) {
    return;
  }

  sessionClosing = true;
  try {
    await stopPiPInternal();
  } finally {
    sessionClosing = false;
  }
}

// ── Messages ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "startPiP") {
    startPiP().then(() => sendResponse({ ok: true })).catch((error) => {
      console.warn("[BG] startPiP failed:", error);
      sendResponse({ ok: false });
    });
    return true;
  }
  if (msg.action === "stopPiP") {
    stopPiP().then(() => sendResponse({ ok: true })).catch((error) => {
      console.warn("[BG] stopPiP failed:", error);
      sendResponse({ ok: false });
    });
    return true;
  }
  if (msg.action === "scrapeDone") {
    console.log("[BG] Scrape done:", msg.source || "unknown", msg.count, "items");
  }
  if (msg.action === "getSettings") {
    getSettings().then((settings) => sendResponse(settings)).catch((error) => {
      console.warn("[BG] getSettings failed:", error);
      sendResponse(DEFAULTS);
    });
    return true;
  }
  if (msg.action === "isScraperTab") {
    sendResponse({ isScraper: isTrackedScraperTab(sender.tab?.id) });
    return true;
  }
  if (msg.action === "getPipStatus") {
    chrome.storage.local.get("pipActive", (data) => {
      sendResponse({ active: !!data.pipActive });
    });
    return true;
  }
  if (msg.action === "openPiPWindow") {
    openPiPSession().then(() => sendResponse({ ok: true })).catch((error) => {
      console.warn("[BG] openPiPWindow failed:", error);
      sendResponse({ ok: false });
    });
    return true;
  }
  if (msg.action === "closePiPWindow") {
    closePiPSession().then(() => sendResponse({ ok: true })).catch((error) => {
      console.warn("[BG] closePiPWindow failed:", error);
      sendResponse({ ok: false });
    });
    return true;
  }
  if (msg.action === "setPinnedPiPActive") {
    pinnedPiPActive = !!msg.active;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === "togglePiPWindow") {
    togglePiPFromShortcut().then(() => sendResponse({ ok: true })).catch((error) => {
      console.warn("[BG] togglePiPWindow failed:", error);
      sendResponse({ ok: false });
    });
    return true;
  }
  if (msg.action === "translateBatch") {
    translateBatch(msg.items).then((translations) => {
      sendResponse({ translations });
    }).catch((error) => {
      console.warn("[BG] translateBatch failed:", error);
      sendResponse({ translations: [] });
    });
    return true;
  }
  if (msg.action === "refreshScrapersNow") {
    refreshScraperTabs().then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      console.warn("[BG] refreshScrapersNow failed:", error);
      sendResponse({ ok: false });
    });
    return true;
  }
});

async function openPiPWindow() {
  if (pipWindowId) {
    try {
      await chrome.windows.get(pipWindowId);
      chrome.windows.update(pipWindowId, { focused: true });
      return;
    } catch (e) {
      pipWindowId = null;
    }
  }
  const centeredBounds = await getCenteredPopupBounds(LAUNCHER_PIP_WIDTH, LAUNCHER_PIP_HEIGHT);
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL("pip.html"),
    type: "popup",
    width: LAUNCHER_PIP_WIDTH,
    height: LAUNCHER_PIP_HEIGHT,
    left: centeredBounds.left,
    top: centeredBounds.top,
    focused: true,
  });
  pipWindowId = w.id;
  pipWindowCompact = false;
  pipWindowRestoreBounds = {
    width: w.width || DEFAULT_PIP_WIDTH,
    height: w.height || DEFAULT_PIP_HEIGHT,
    left: w.left,
    top: w.top,
  };
  setTimeout(() => {
    chrome.windows.update(w.id, { focused: true }).catch(() => {});
  }, 300);
}

async function openPiPSession() {
  await startPiP();
  await openPiPWindow();
}

async function closePiPSession() {
  if (sessionClosing) {
    return;
  }

  sessionClosing = true;
  try {
    const currentPiPWindowId = pipWindowId;
    pipWindowId = null;

    if (currentPiPWindowId) {
      try {
        await chrome.windows.remove(currentPiPWindowId);
      } catch (e) {}
    }

    await stopPiPInternal();
  } finally {
    sessionClosing = false;
  }
}

async function togglePiPCompactMode() {
  if (pinnedPiPActive) {
    safeBroadcastRuntimeMessage({ action: "toggleCompactPinnedPiP" });
    return;
  }

  if (!pipWindowId) return;

  let pipWindow;
  try {
    pipWindow = await chrome.windows.get(pipWindowId);
  } catch (e) {
    pipWindowId = null;
    pipWindowCompact = false;
    pipWindowRestoreBounds = null;
    return;
  }

  if (!pipWindowCompact) {
    pipWindowRestoreBounds = {
      width: pipWindow.width || DEFAULT_PIP_WIDTH,
      height: pipWindow.height || DEFAULT_PIP_HEIGHT,
      left: pipWindow.left,
      top: pipWindow.top,
    };
    const compactBounds = await getTopRightPopupBounds(pipWindowId, COMPACT_PIP_WIDTH, COMPACT_PIP_HEIGHT);
    await chrome.windows.update(pipWindowId, {
      state: "normal",
      width: COMPACT_PIP_WIDTH,
      height: COMPACT_PIP_HEIGHT,
      left: compactBounds.left,
      top: compactBounds.top,
      focused: true,
    });
    pipWindowCompact = true;
    return;
  }

  await chrome.windows.update(pipWindowId, {
    state: "normal",
    width: pipWindowRestoreBounds?.width || DEFAULT_PIP_WIDTH,
    height: pipWindowRestoreBounds?.height || DEFAULT_PIP_HEIGHT,
    left: pipWindowRestoreBounds?.left,
    top: pipWindowRestoreBounds?.top,
    focused: true,
  });
  pipWindowCompact = false;
}

async function togglePiPFromShortcut() {
  const data = await chrome.storage.local.get("pipActive");

  if (data.pipActive) {
    await closePiPSession();
    return;
  }

  await openPiPSession();
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === pipWindowId && !sessionClosing) {
    pipWindowId = null;
    pipWindowCompact = false;
    pipWindowRestoreBounds = null;
    pinnedPiPActive = false;
    stopPiP();
  }
});

// ── Toolbar icon click ──
chrome.action.onClicked.addListener(async () => {
  await togglePiPFromShortcut();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-pip-window") {
    await togglePiPFromShortcut();
  }
  if (command === "toggle-pip-compact") {
    await togglePiPCompactMode();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !Object.prototype.hasOwnProperty.call(changes, "refreshInterval")) {
    return;
  }

  chrome.storage.local.get("pipActive").then((data) => {
    if (!data.pipActive || sessionClosing) {
      return;
    }

    scheduleRefreshLoop(changes.refreshInterval.newValue);
  }).catch(() => {});
});

// ── Restore state after service worker restart ──
chrome.storage.local.get(["scraperTabId", "xScraperTabId", "truthScraperTabId", "pipActive"], (data) => {
  xScraperTabId = data.xScraperTabId || data.scraperTabId || null;
  truthScraperTabId = data.truthScraperTabId || null;

  if (!data.pipActive) {
    return;
  }

  const tabChecks = [];
  if (xScraperTabId) tabChecks.push(chrome.tabs.get(xScraperTabId));
  if (truthScraperTabId) tabChecks.push(chrome.tabs.get(truthScraperTabId));

  if (!tabChecks.length) {
    stopPiP();
    return;
  }

  Promise.allSettled(tabChecks).then((results) => {
    if (results.some((result) => result.status === "rejected")) {
      stopPiP();
      return;
    }

    getSettings().then((settings) => {
      scheduleRefreshLoop(settings.refreshInterval);
    }).catch(() => {});
  });
});

// ── Clean up if a scraper tab is closed manually ──
chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessionClosing) {
    return;
  }

  if (!isTrackedScraperTab(tabId)) {
    return;
  }

  if (tabId === xScraperTabId) {
    xScraperTabId = null;
  }
  if (tabId === truthScraperTabId) {
    truthScraperTabId = null;
  }

  console.log("[BG] A scraper tab was closed manually — closing PiP session");
  closePiPSession().catch((error) => {
    console.warn("[BG] Failed to close PiP session after scraper tab removal:", error);
  });
});
