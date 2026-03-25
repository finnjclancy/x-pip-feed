// ── SCRAPER + FEED LAUNCHERS ──
// Content script on supported feed pages.
// 1) Extracts posts, optionally translates configured X accounts, then stores source-specific feed state.
// 2) Adds PiP and side panel buttons so the feed can be opened from the page.

const PLATFORM = (() => {
  const host = window.location.hostname;
  if (host === "x.com" || host === "twitter.com") return "x";
  if (host === "truthsocial.com") return "truth";
  return "unknown";
})();

const LOG_PREFIX = PLATFORM === "x" ? "[X PiP]" : "[PiP]";
const X_FEED_STORAGE_KEY = "tweets";
const TRUTH_FEED_STORAGE_KEY = "truthTweets";
const TRUTH_PROFILE_URL = "https://truthsocial.com/@realDonaldTrump";
const TRUTH_ACCOUNT = "realDonaldTrump";
const TRUTH_ACCOUNT_LOOKUP_PATH = "/api/v1/accounts/lookup?acct=" + encodeURIComponent(TRUTH_ACCOUNT);
const TRUTH_AUTHOR_NAME = "Donald J. Trump";
const TRUTH_HEADER_SCAN_LINES = 18;
const SCRAPE_FAST_FALLBACK_INTERVAL_MS = 50;
const SCRAPE_SLOW_FALLBACK_INTERVAL_MS = 500;
const SCRAPE_FAST_FALLBACK_WINDOW_MS = 3000;
const SCRAPE_MUTATION_DEBOUNCE_MS = 50;
const SCRAPE_TIMEOUT_MS = 30000;
let scraperMode = false;
let scrapeIntervalId = null;
let scrapeMutationTimeoutId = null;
let scrapeObserver = null;
let scrapeInFlight = false;
let pagePiPActive = false;
const FOLLOWING_TAB_LABELS = ["following", "abonnements"];
const FOLLOWING_QUERY = "filter=follows";

console.log(LOG_PREFIX, "Content script loaded:", window.location.href);

function isContextInvalidatedError(error) {
  return !!error && /Extension context invalidated/i.test(String(error.message || error));
}

function hasValidExtensionContext() {
  try {
    return !!chrome?.runtime?.id && !!chrome?.storage?.local;
  } catch (error) {
    return false;
  }
}

function stopScrapeLoop() {
  if (scrapeIntervalId) {
    clearInterval(scrapeIntervalId);
    scrapeIntervalId = null;
  }
  if (scrapeMutationTimeoutId) {
    clearTimeout(scrapeMutationTimeoutId);
    scrapeMutationTimeoutId = null;
  }
  if (scrapeObserver) {
    scrapeObserver.disconnect();
    scrapeObserver = null;
  }
  scrapeInFlight = false;
}

function safeStorageLocalGet(keys, callback) {
  if (!hasValidExtensionContext()) {
    stopScrapeLoop();
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
      console.warn(LOG_PREFIX, "Storage read failed:", error);
    }
    stopScrapeLoop();
    return false;
  }
}

function safeStorageLocalSet(value, callback) {
  if (!hasValidExtensionContext()) {
    stopScrapeLoop();
    return false;
  }
  try {
    chrome.storage.local.set(value, () => {
      void chrome.runtime.lastError;
      if (callback) callback();
    });
    return true;
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.warn(LOG_PREFIX, "Storage write failed:", error);
    }
    stopScrapeLoop();
    return false;
  }
}

function safeSendRuntimeMessage(message, callback) {
  if (!hasValidExtensionContext()) {
    stopScrapeLoop();
    return false;
  }
  try {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      if (callback) callback(response);
    });
    return true;
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.warn(LOG_PREFIX, "Runtime message failed:", error);
    }
    stopScrapeLoop();
    return false;
  }
}

function normalizeText(value) {
  return (value || "").trim().toLowerCase();
}

function stripHtmlToText(html) {
  if (!html) {
    return "";
  }

  const container = document.createElement("div");
  container.innerHTML = String(html);
  container.querySelectorAll(".quote-inline, .recipients-inline, script, style").forEach((node) => {
    node.remove();
  });
  return (container.textContent || container.innerText || "").trim();
}

function getItemKey(item) {
  if (item?.isRetweet) {
    return [
      item.source || PLATFORM,
      "repost",
      item.repostedByAccount || item.retweetedBy || item.retweetContext || "RT",
      item.url || "",
      item.account || "",
      item.originalAccount || "",
    ].join("|");
  }
  return item.url || [
    item.source || PLATFORM,
    item.account || "",
    item.timestamp || "",
    item.text || "",
  ].join("|");
}

function extractHandleFromHref(href) {
  const value = String(href || "").trim();
  if (!value) {
    return "";
  }

  const cleanHref = value.split("?")[0].split("#")[0];
  const statusMatch = cleanHref.match(/^\/([A-Za-z0-9_]+)\/status\/\d+$/);
  if (statusMatch) {
    return statusMatch[1];
  }

  const profileMatch = cleanHref.match(/^\/([A-Za-z0-9_]+)$/);
  if (profileMatch) {
    return profileMatch[1];
  }

  return "";
}

function getArticleProfileHandles(article) {
  const handles = [];
  const seen = new Set();
  article.querySelectorAll('a[href^="/"]').forEach((link) => {
    const handle = extractHandleFromHref(link.getAttribute("href"));
    if (!handle || seen.has(handle)) {
      return;
    }
    seen.add(handle);
    handles.push(handle);
  });
  return handles;
}

function getOriginalTweetAccount(article, fallbackHandles = []) {
  const timeLink = article.querySelector('time')?.closest('a[href^="/"]');
  const fromTimeLink = extractHandleFromHref(timeLink?.getAttribute("href"));
  if (fromTimeLink) {
    return fromTimeLink;
  }

  const statusLink = article.querySelector('a[href*="/status/"]');
  const fromStatusLink = extractHandleFromHref(statusLink?.getAttribute("href"));
  if (fromStatusLink) {
    return fromStatusLink;
  }

  return fallbackHandles[0] || "";
}

function isTruthPostUrl(url) {
  const value = url || "";
  return /^https:\/\/truthsocial\.com\/@realDonaldTrump\/posts\/\d+$/i.test(value) ||
    value.startsWith(TRUTH_PROFILE_URL + "#");
}

function isTruthShellText(text) {
  const normalized = normalizeText(text);
  return [
    "followers",
    "following",
    "truth search ai",
    "get more with truth+",
    "get the truth+ patriot package",
    "support small american businesses",
    "manage accounts",
    "help center",
    "proudly made in the united states of america",
  ].some((marker) => normalized.includes(marker));
}

function sanitizeTruthItems(items) {
  return (items || []).filter((item) => {
    if (item?.source !== "truth") {
      return true;
    }
    if (item.account !== TRUTH_ACCOUNT) {
      return false;
    }
    if (!item.text || isTruthShellText(item.text)) {
      return false;
    }
    return isTruthPostUrl(item.url);
  });
}

// ══════════════════════════════════════════════════════════════
// X SCRAPING
// ══════════════════════════════════════════════════════════════

function extractXTweets() {
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  const tweets = [];
  const scrapedAt = Date.now();
  articles.forEach((article, index) => {
    try {
      let isRetweet = false;
      let retweetedBy = "";
      let retweetContext = "";
      let repostedByAccount = "";
      let originalAccount = "";
      const socialCtx = article.querySelector('[data-testid="socialContext"]');
      if (socialCtx) {
        const ctxText = socialCtx.innerText || "";
        const normalizedCtxText = ctxText.toLowerCase();
        if (normalizedCtxText.includes("repost") || normalizedCtxText.includes("retweeted")) {
          isRetweet = true;
          retweetContext = ctxText.trim();
          retweetedBy = ctxText.replace(/\s*(reposted|retweeted)$/i, "").trim();
          const socialCtxLink = socialCtx.querySelector('a[href^="/"]');
          repostedByAccount = extractHandleFromHref(socialCtxLink?.getAttribute("href"));
        }
      }

      const profileHandles = getArticleProfileHandles(article);
      if (isRetweet && !repostedByAccount) {
        repostedByAccount = profileHandles[0] || "";
      }
      originalAccount = getOriginalTweetAccount(
        article,
        profileHandles.filter((handle) => handle && handle !== repostedByAccount)
      );
      const account = originalAccount || repostedByAccount || profileHandles[0] || "";

      const textElement = article.querySelector('[data-testid="tweetText"]');
      const text = textElement ? textElement.innerText : "";
      const timeElement = article.querySelector("time");
      let url = "";
      let timestamp = "";
      if (timeElement) {
        timestamp = timeElement.getAttribute("datetime") || timeElement.innerText || "";
        const timeLink = timeElement.closest("a");
        if (timeLink) url = timeLink.href;
      }

      const activityTimestamp = isRetweet
        ? new Date(scrapedAt - index).toISOString()
        : timestamp;

      if (text && (url || timestamp)) {
        tweets.push({
          source: "x",
          account,
          text,
          url,
          isRetweet,
          retweetedBy,
          retweetContext,
          repostedByAccount,
          originalAccount,
          timestamp,
          activityTimestamp,
        });
      }
    } catch (err) {}
  });
  return tweets;
}

function isFollowingUrl() {
  return window.location.pathname === "/home" && window.location.search.includes(FOLLOWING_QUERY);
}

function hasXTimelineArticles() {
  return document.querySelectorAll('article[data-testid="tweet"]').length > 0;
}

function getFollowingTab() {
  const tabs = Array.from(document.querySelectorAll('a[role="tab"], div[role="tab"]'));
  return tabs.find((tab) => {
    const label = normalizeText(tab.innerText || tab.textContent);
    return FOLLOWING_TAB_LABELS.some((name) => label === name || label.includes(name));
  }) || null;
}

function isFollowingSelected() {
  const tab = getFollowingTab();
  return !!tab && tab.getAttribute("aria-selected") === "true";
}

function ensureFollowingTimeline() {
  return new Promise((resolve) => {
    if (!isFollowingUrl()) {
      window.location.replace("https://x.com/home?filter=follows");
      resolve(false);
      return;
    }

    if (isFollowingSelected() || hasXTimelineArticles()) {
      resolve(true);
      return;
    }

    const deadline = Date.now() + 15000;

    const trySwitch = () => {
      const tab = getFollowingTab();
      if (!tab) {
        if (hasXTimelineArticles()) {
          cleanup();
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          cleanup();
          resolve(isFollowingUrl());
        }
        return;
      }

      if (tab.getAttribute("aria-selected") === "true") {
        cleanup();
        resolve(true);
        return;
      }

      tab.click();

      setTimeout(() => {
        if (tab.getAttribute("aria-selected") === "true" || isFollowingSelected() || hasXTimelineArticles()) {
          cleanup();
          resolve(true);
        } else if (Date.now() >= deadline) {
          cleanup();
          resolve(isFollowingUrl());
        }
      }, 700);
    };

    const observer = new MutationObserver(() => {
      trySwitch();
    });

    const intervalId = setInterval(() => {
      trySwitch();
      if (Date.now() >= deadline) {
        cleanup();
        resolve(false);
      }
    }, 500);

    const cleanup = () => {
      observer.disconnect();
      clearInterval(intervalId);
    };

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });

    trySwitch();
  });
}

async function getTranslateAccountMap() {
  try {
    const response = await new Promise((resolve) => {
      if (!safeSendRuntimeMessage({ action: "getSettings" }, resolve)) {
        resolve(null);
      }
    });

    const accounts = Array.isArray(response?.translateAccounts)
      ? response.translateAccounts
      : [];
    const accountMap = new Map();

    accounts.forEach((account) => {
      const username = normalizeText(account?.username).replace(/^@/, "");
      const fromLang = normalizeText(account?.fromLang);
      if (!username || !fromLang) {
        return;
      }
      accountMap.set(username, fromLang);
    });

    return accountMap;
  } catch (error) {
    return new Map();
  }
}

async function translateTweets(tweets) {
  const accountMap = await getTranslateAccountMap();
  if (!accountMap.size) {
    return tweets;
  }

  const translationJobs = [];
  const translationIndexesByKey = new Map();

  tweets.forEach((tweet) => {
    const account = normalizeText(tweet.account).replace(/^@/, "");
    const fromLang = accountMap.get(account);
    if (!fromLang || !tweet.text) {
      return;
    }

    const jobKey = fromLang + "\n" + tweet.text;
    let jobIndex = translationIndexesByKey.get(jobKey);
    if (jobIndex === undefined) {
      jobIndex = translationJobs.length;
      translationIndexesByKey.set(jobKey, jobIndex);
      translationJobs.push({
        text: tweet.text,
        fromLang,
      });
    }

    tweet.translationJobIndex = jobIndex;
  });

  if (!translationJobs.length) {
    return tweets;
  }

  try {
    const response = await new Promise((resolve) => {
      if (!safeSendRuntimeMessage({ action: "translateBatch", items: translationJobs }, resolve)) {
        resolve(null);
      }
    });

    const translations = Array.isArray(response?.translations)
      ? response.translations
      : [];

    tweets.forEach((tweet) => {
      if (typeof tweet.translationJobIndex !== "number") {
        return;
      }

      const translated = translations[tweet.translationJobIndex];
      if (translated) {
        tweet.text = translated;
      }
      delete tweet.translationJobIndex;
    });
  } catch (error) {
    tweets.forEach((tweet) => {
      delete tweet.translationJobIndex;
    });
  }

  return tweets;
}

// ══════════════════════════════════════════════════════════════
// TRUTH SCRAPING
// ══════════════════════════════════════════════════════════════

function parseTruthTimestamp(relativeText) {
  const normalized = normalizeText(relativeText);
  if (!normalized) return "";
  const now = Date.now();
  if (normalized === "just now") {
    return new Date(now).toISOString();
  }

  const match = normalized.match(/^(\d+)\s*([smhdw])$/);
  if (!match) {
    return "";
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const deltas = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return new Date(now - (amount * deltas[unit])).toISOString();
}

function buildTruthPostUrl(postId) {
  if (/^\d+$/.test(postId)) {
    return "https://truthsocial.com/@" + TRUTH_ACCOUNT + "/posts/" + postId;
  }
  return TRUTH_PROFILE_URL + "#" + encodeURIComponent(postId || "latest");
}

function getTruthPostContainers() {
  const mirrorPosts = Array.from(document.querySelectorAll('.post-container[data-testid^="post-"], [data-testid^="post-"].post-container'));
  if (mirrorPosts.length) {
    return mirrorPosts;
  }

  const statusContainers = Array.from(document.querySelectorAll('[id^="status-"]'));
  if (statusContainers.length) {
    return statusContainers;
  }

  const officialAnchors = Array.from(document.querySelectorAll(
    'a[href^="/@' + TRUTH_ACCOUNT + '/posts/"], a[href*="/users/' + TRUTH_ACCOUNT + '/statuses/"]'
  ));

  const containers = [];
  const seen = new Set();
  officialAnchors.forEach((anchor) => {
    const container = anchor.closest('article, [data-testid], [role="article"], div[tabindex], section');
    if (!container || seen.has(container)) {
      return;
    }
    seen.add(container);
    containers.push(container);
  });

  return containers;
}

function getTruthPostLinks() {
  const links = [];
  const seen = new Set();
  Array.from(document.querySelectorAll('a[href*="/posts/"], a[href*="/statuses/"]')).forEach((anchor) => {
    const href = anchor.getAttribute("href");
    if (!href) return;
    try {
      const resolved = new URL(href, window.location.origin).href;
      if (seen.has(resolved)) return;
      seen.add(resolved);
      links.push(resolved);
    } catch (e) {}
  });
  return links;
}

function isTruthRelativeTimeLine(line) {
  return /^(just now|\d+\s*[smhdw])$/i.test(line);
}

function isTruthMetricsLine(line) {
  return /^\d+(\.\d+)?[kmb]?$/i.test(line) || /^0?\d:\d{2}(?:\s*\/\s*0?\d:\d{2})?$/.test(line);
}

function isTruthNoiseLine(line) {
  return /^(avatar|profile header|followed by .+|follow|unfollow|truths|replies|media|show more|reply|retruth|share|like|bookmark|more|pinned truth)$/i.test(line);
}

function findTruthPostHeader(lines, index) {
  if (lines[index] !== TRUTH_AUTHOR_NAME) {
    return null;
  }

  const endIndex = Math.min(lines.length, index + TRUTH_HEADER_SCAN_LINES);
  let handleIndex = -1;
  let timeIndex = -1;
  let pinned = false;

  for (let i = index + 1; i < endIndex; i++) {
    const normalized = normalizeText(lines[i]);
    if (handleIndex === -1 && normalized === "@" + TRUTH_ACCOUNT.toLowerCase()) {
      handleIndex = i;
      continue;
    }
    if (normalized === "pinned truth") {
      pinned = true;
      continue;
    }
    if (isTruthRelativeTimeLine(lines[i])) {
      timeIndex = i;
      break;
    }
    if (lines[i] === "·" && isTruthRelativeTimeLine(lines[i + 1] || "")) {
      timeIndex = i + 1;
      break;
    }
  }

  if (handleIndex === -1 || timeIndex === -1 || timeIndex < handleIndex) {
    return null;
  }

  return {
    handleIndex,
    timeIndex,
    relativeText: lines[timeIndex],
    pinned,
    nextIndex: timeIndex + 1,
  };
}

function isTruthPostStart(lines, index) {
  return !!findTruthPostHeader(lines, index);
}

function extractTruthRelativeTimeFromLines(lines, startIndex) {
  for (let i = startIndex; i < Math.min(lines.length, startIndex + TRUTH_HEADER_SCAN_LINES); i++) {
    if (isTruthRelativeTimeLine(lines[i])) {
      return { relativeText: lines[i], nextIndex: i + 1 };
    }
    if (lines[i] === "·" && isTruthRelativeTimeLine(lines[i + 1] || "")) {
      return { relativeText: lines[i + 1], nextIndex: i + 2 };
    }
  }

  return { relativeText: "", nextIndex: startIndex };
}

function buildTruthFallbackUrlFromText(text, index) {
  const key = encodeURIComponent((text || "latest").slice(0, 120));
  return TRUTH_PROFILE_URL + "#post-" + index + "-" + key;
}

function extractTruthPostsFromPageText() {
  const bodyClone = document.body?.cloneNode(true);
  if (bodyClone) {
    bodyClone.querySelectorAll("#xpip-btn").forEach((node) => node.remove());
    bodyClone.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
  }
  const rawText = ((bodyClone && bodyClone.innerText) || document.body?.innerText || "").trim();
  if (!rawText) {
    return [];
  }

  const lines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const links = getTruthPostLinks();
  const posts = [];

  for (let i = 0; i < lines.length; i++) {
    const header = findTruthPostHeader(lines, i);
    if (!header) {
      continue;
    }

    const { relativeText, nextIndex, pinned } = header;
    if (!relativeText) {
      continue;
    }

    const bodyParts = [];
    let cursor = nextIndex;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (isTruthPostStart(lines, cursor)) {
        break;
      }
      if (normalizeText(line) === "@" + TRUTH_ACCOUNT.toLowerCase()) {
        cursor++;
        continue;
      }
      if (line === TRUTH_AUTHOR_NAME || line === "·" || isTruthNoiseLine(line) || isTruthMetricsLine(line)) {
        cursor++;
        continue;
      }
      bodyParts.push(line);
      cursor++;
    }

    let text = bodyParts.join("\n\n").trim();
    if (!text && pinned) {
      text = "[Pinned Truth]";
    }
    if (!text) {
      text = "[Media post]";
    }
    if (!text) {
      i = cursor;
      continue;
    }

    const postIndex = posts.length;
    posts.push({
      source: "truth",
      account: TRUTH_ACCOUNT,
      text,
      url: links[postIndex] || buildTruthFallbackUrlFromText(text, postIndex),
      timestamp: parseTruthTimestamp(relativeText),
      isRetweet: false,
      retweetedBy: "",
      isPinned: pinned,
    });

    i = cursor - 1;
  }

  return posts;
}

function extractTruthRelativeTime(contentRoot, container) {
  const spanMatch = Array.from(contentRoot.querySelectorAll("span"))
    .map((span) => (span.innerText || "").trim())
    .find((value) => value.includes("@" + TRUTH_ACCOUNT));
  if (spanMatch) {
    return spanMatch.split("·").pop()?.trim() || "";
  }

  const timeElement = container.querySelector("time");
  if (timeElement) {
    return (timeElement.innerText || timeElement.getAttribute("datetime") || "").trim();
  }

  const textMatch = (container.innerText || "").match(/\b(just now|\d+\s*[smhdw])\b/i);
  if (textMatch) {
    return textMatch[1];
  }

  return "";
}

function isPinnedTruthContainer(container) {
  const directPinnedMarker = Array.from(
    container.querySelectorAll('span, div, p, a, time')
  ).some((node) => normalizeText(node.textContent || "") === "pinned truth");

  if (directPinnedMarker) {
    return true;
  }

  const accountRow = container.querySelector('[data-testid="account"]');
  if (!accountRow) {
    return false;
  }

  const rowText = (accountRow.innerText || "")
    .split("\n")
    .map((part) => normalizeText(part))
    .filter(Boolean);

  return rowText.includes("pinned truth");
}

function extractTruthTextFromAriaLabel(container) {
  const statusNode = container.matches?.('[data-testid="status"]')
    ? container
    : container.querySelector?.('[data-testid="status"]');
  const ariaLabel = statusNode?.getAttribute?.("aria-label") || container.getAttribute?.("aria-label") || "";
  if (!ariaLabel) {
    return "";
  }

  const prefix = TRUTH_AUTHOR_NAME + ", ";
  let body = ariaLabel.startsWith(prefix) ? ariaLabel.slice(prefix.length) : ariaLabel;
  body = body.replace(new RegExp(",\\s+[A-Z][a-z]{2}\\s+\\d{1,2},\\s+(?:\\d{4},\\s+)?\\d{1,2}:\\d{2}\\s+[AP]M,\\s*" + TRUTH_ACCOUNT + "$"), "");
  body = body.replace(new RegExp(",\\s*" + TRUTH_ACCOUNT + "$"), "");
  return body.trim();
}

function extractTruthTextFromGenericContainer(container) {
  const ariaLabelText = extractTruthTextFromAriaLabel(container);
  if (ariaLabelText) {
    return ariaLabelText;
  }

  const nestedParagraphText = Array.from(container.querySelectorAll('p > p, [id^="status-"] p > p, [id^="status-"] div[lang], [id^="status-"] p'))
    .map((node) => (node.innerText || "").trim())
    .filter(Boolean)
    .filter((text, index, arr) => arr.indexOf(text) === index)
    .filter((text) => {
      const normalized = normalizeText(text);
      if (normalized === "pip") return false;
      if (normalized === normalizeText(TRUTH_AUTHOR_NAME)) return false;
      if (normalized === "@" + TRUTH_ACCOUNT.toLowerCase()) return false;
      if (normalized === TRUTH_ACCOUNT.toLowerCase()) return false;
      if (normalized === "pinned truth") return false;
      if (normalized === "verification badge") return false;
      if (normalized.includes("@" + TRUTH_ACCOUNT.toLowerCase()) && /\b(just now|\d+\s*[smhdw])\b/i.test(text)) return false;
      if (/^(reply|retruth|share|like|bookmark|more)$/i.test(text)) return false;
      if (/^\d+[smhdw]$/i.test(text) || /^just now$/i.test(text)) return false;
      return text.length >= 2;
    });
  if (nestedParagraphText.length) {
    return nestedParagraphText.join("\n\n").trim();
  }

  const candidates = Array.from(container.querySelectorAll(
    '[data-testid="statusContent"], [data-testid="status-content"], div[lang], p, span'
  ));

  const seen = new Set();
  const parts = [];
  candidates.forEach((node) => {
    const text = (node.innerText || "").trim();
    const normalized = normalizeText(text);
    if (!text || seen.has(text)) return;
    if (normalized === "pip") return;
    if (normalized === normalizeText(TRUTH_AUTHOR_NAME)) return;
    if (normalized === "@"+ TRUTH_ACCOUNT.toLowerCase()) return;
    if (normalized === TRUTH_ACCOUNT.toLowerCase()) return;
    if (normalized === "pinned truth") return;
    if (normalized === "verification badge") return;
    if (normalized.includes("@" + TRUTH_ACCOUNT.toLowerCase()) && /\b(just now|\d+\s*[smhdw])\b/i.test(text)) return;
    if (/^(reply|retruth|share|like|bookmark|more)$/i.test(text)) return;
    if (/^\d+[smhdw]$/i.test(text) || /^just now$/i.test(text)) return;
    if (text.length < 2) return;
    seen.add(text);
    parts.push(text);
  });

  return parts.join("\n\n").trim();
}

function extractTruthPostText(contentRoot) {
  if (!contentRoot) return "";
  const genericText = extractTruthTextFromGenericContainer(contentRoot);
  if (genericText) {
    return genericText;
  }
  const children = Array.from(contentRoot.children);
  const parts = [];
  children.forEach((child, index) => {
    if (index === 0 || index === children.length - 1) {
      return;
    }
    const text = (child.innerText || "").trim();
    if (text) {
      parts.push(text);
    }
  });
  return parts.join("\n\n").trim();
}

function extractTruthPosts() {
  const posts = getTruthPostContainers();
  const extractedPosts = posts.map((post) => {
    try {
      const dataTestId = post.getAttribute("data-testid") || "";
      const statusId = (post.id || "").replace(/^status-/, "");
      const postId = dataTestId.startsWith("post-")
        ? dataTestId.replace(/^post-/, "")
        : (statusId || dataTestId);
      const contentRoot = post.querySelector(".flex-1") || post;
      if (!contentRoot) return null;

      const relativeText = extractTruthRelativeTime(contentRoot, post);
      const text = extractTruthTextFromGenericContainer(post) || extractTruthPostText(contentRoot);
      const link = post.querySelector('a[href^="/@' + TRUTH_ACCOUNT + '/posts/"], a[href*="/users/' + TRUTH_ACCOUNT + '/statuses/"]');
      const resolvedUrl = link ? new URL(link.getAttribute("href"), window.location.origin).href : buildTruthPostUrl(postId);

      if (!text) {
        return null;
      }

      return {
        source: "truth",
        account: TRUTH_ACCOUNT,
        text,
        url: resolvedUrl,
        timestamp: parseTruthTimestamp(relativeText),
        isRetweet: false,
        retweetedBy: "",
        isPinned: isPinnedTruthContainer(post),
      };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);

  if (extractedPosts.length) {
    return sanitizeTruthItems(extractedPosts);
  }

  const fallbackPosts = extractTruthPostsFromPageText();
  const mergedPosts = [];

  [...fallbackPosts, ...extractedPosts].forEach((item) => {
    const normalizedText = normalizeText(item.text || "");
    if (!item.text) {
      return;
    }

    const existingIndex = mergedPosts.findIndex((existingItem) => {
      const existingText = normalizeText(existingItem.text || "");
      const sameRealUrl = !!existingItem.url && !!item.url && existingItem.url === item.url;
      const sameAccount = (existingItem.account || "") === (item.account || "");
      const textContains =
        !!existingText &&
        !!normalizedText &&
        (existingText.includes(normalizedText) || normalizedText.includes(existingText));

      return sameRealUrl || (sameAccount && textContains);
    });

    if (existingIndex === -1) {
      mergedPosts.push(item);
      return;
    }

    const existingItem = mergedPosts[existingIndex];
    const existingTextLength = (existingItem.text || "").length;
    const nextTextLength = (item.text || "").length;
    const hasExistingRealUrl = !!existingItem.url && !existingItem.url.startsWith(TRUTH_PROFILE_URL + "#post-");
    const hasNextRealUrl = !!item.url && !item.url.startsWith(TRUTH_PROFILE_URL + "#post-");

    if (nextTextLength > existingTextLength || (!hasExistingRealUrl && hasNextRealUrl)) {
      mergedPosts[existingIndex] = {
        ...existingItem,
        ...item,
        text: nextTextLength > existingTextLength ? item.text : existingItem.text,
        url: hasNextRealUrl ? item.url : existingItem.url,
        isPinned: !!(existingItem.isPinned || item.isPinned),
      };
      return;
    }

    if (item.isPinned && !existingItem.isPinned) {
      mergedPosts[existingIndex] = {
        ...existingItem,
        isPinned: true,
      };
    }
  });

  return sanitizeTruthItems(mergedPosts);
}

function parseTruthApiStatus(status) {
  const accountHandle = normalizeText(
    status?.account?.acct || status?.account?.username || status?.account?.username_or_handle
  ).replace(/^@/, "");

  if (accountHandle !== TRUTH_ACCOUNT.toLowerCase()) {
    return null;
  }

  if (status?.reblog) {
    return null;
  }

  let text = stripHtmlToText(status?.content || "") || stripHtmlToText(status?.spoiler_text || "");
  if (!text && Array.isArray(status?.media_attachments) && status.media_attachments.length) {
    text = "[Media post]";
  }
  if (!text) {
    return null;
  }

  const statusId = String(status?.id || "").trim();
  return {
    source: "truth",
    account: TRUTH_ACCOUNT,
    text,
    url: status?.url || buildTruthPostUrl(statusId),
    timestamp: String(status?.created_at || "").trim(),
    activityTimestamp: String(status?.created_at || "").trim(),
    isRetweet: false,
    retweetedBy: "",
    isPinned: !!status?.pinned,
  };
}

async function fetchTruthPostsViaApi() {
  if (window.location.hostname !== "truthsocial.com") {
    return [];
  }

  const lookupResponse = await fetch(TRUTH_ACCOUNT_LOOKUP_PATH, {
    credentials: "include",
    headers: {
      accept: "application/json",
    },
    cache: "no-store",
  });
  if (!lookupResponse.ok) {
    throw new Error("Truth account lookup failed: " + lookupResponse.status);
  }

  const account = await lookupResponse.json();
  const accountId = String(account?.id || "").trim();
  if (!accountId) {
    throw new Error("Truth account lookup returned no id");
  }

  const statusesUrl = new URL("/api/v1/accounts/" + accountId + "/statuses", window.location.origin);
  statusesUrl.searchParams.set("limit", "40");

  const statusesResponse = await fetch(statusesUrl.toString(), {
    credentials: "include",
    headers: {
      accept: "application/json",
    },
    cache: "no-store",
  });
  if (!statusesResponse.ok) {
    throw new Error("Truth statuses fetch failed: " + statusesResponse.status);
  }

  const statuses = await statusesResponse.json();
  if (!Array.isArray(statuses)) {
    throw new Error("Truth statuses response was not an array");
  }

  return sanitizeTruthItems(statuses.map(parseTruthApiStatus).filter(Boolean));
}

// ══════════════════════════════════════════════════════════════
// SHARED STORAGE
// ══════════════════════════════════════════════════════════════

function storeItems(storageKey, items, label) {
  function getStoredRecentCycle(item) {
    if (Number.isFinite(item?.recentCycle)) {
      return item.recentCycle;
    }
    if (item?.isNew) {
      return 0;
    }
    if (item?.isLastBatch) {
      return 1;
    }
    if (item?.isRecentLabel) {
      return 1;
    }
    return 2;
  }

  function applyRecentCycle(item, cycle) {
    const boundedCycle = Math.min(Math.max(cycle, 0), 2);
    item.recentCycle = boundedCycle;
    item.isNew = boundedCycle === 0;
    item.isRecentLabel = false;
    item.isLastBatch = boundedCycle === 1;
  }

  if (!safeStorageLocalGet([storageKey], (data) => {
    const existing = storageKey === TRUTH_FEED_STORAGE_KEY
      ? sanitizeTruthItems(data[storageKey] || [])
      : (data[storageKey] || []);
    existing.forEach((item) => {
      applyRecentCycle(item, getStoredRecentCycle(item) + 1);
    });

    const seen = new Set(existing.map(getItemKey));
    const newItems = items.filter((item) => {
      const key = getItemKey(item);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    newItems.forEach((item) => {
      applyRecentCycle(item, 0);
    });

    const mergedItems = [...newItems, ...existing].slice(0, 200);
    const merged = storageKey === TRUTH_FEED_STORAGE_KEY
      ? sanitizeTruthItems(mergedItems)
      : mergedItems;
    safeStorageLocalSet({ [storageKey]: merged }, () => {
      console.log(LOG_PREFIX, "Saved", merged.length, label, "(" + newItems.length + " new)");
    });
  })) {
    return;
  }
}

async function collectItemsForCurrentPlatform() {
  if (PLATFORM === "x") {
    if (!isFollowingSelected()) {
      const switched = await ensureFollowingTimeline();
      if (!switched || (!isFollowingSelected() && !isFollowingUrl() && !hasXTimelineArticles())) {
        console.warn(LOG_PREFIX, "Waiting for Following timeline before scraping");
        return [];
      }
    }
    const tweets = extractXTweets();
    if (!tweets.length) return [];
    return translateTweets(tweets);
  }

  if (PLATFORM === "truth") {
    try {
      const truthPosts = await fetchTruthPostsViaApi();
      if (truthPosts.length) {
        return truthPosts;
      }
    } catch (error) {
      console.warn(LOG_PREFIX, "Truth API fallback failed:", error);
    }

    return extractTruthPosts();
  }

  return [];
}

function currentStorageKey() {
  return PLATFORM === "truth" ? TRUTH_FEED_STORAGE_KEY : X_FEED_STORAGE_KEY;
}

function currentItemLabel() {
  return PLATFORM === "truth" ? "truth posts" : "tweets";
}

function startScrapeLoop() {
  if (scrapeIntervalId || scrapeObserver) return;

  const startedAt = Date.now();
  const deadline = Date.now() + SCRAPE_TIMEOUT_MS;
  let scrapeActive = true;
  const finishScrape = (items) => {
    if (!scrapeActive) {
      return;
    }
    scrapeActive = false;
    stopScrapeLoop();

    if (items.length > 0) {
      storeItems(currentStorageKey(), items, currentItemLabel());
    }

    safeSendRuntimeMessage({
      action: "scrapeDone",
      count: items.length,
      source: PLATFORM,
    });
  };

  const scheduleFallbackRun = () => {
    if (!scrapeActive || scrapeIntervalId) {
      return;
    }

    const elapsed = Date.now() - startedAt;
    const delay = elapsed < SCRAPE_FAST_FALLBACK_WINDOW_MS
      ? SCRAPE_FAST_FALLBACK_INTERVAL_MS
      : SCRAPE_SLOW_FALLBACK_INTERVAL_MS;

    scrapeIntervalId = setTimeout(async () => {
      scrapeIntervalId = null;
      if (!scrapeActive) {
        return;
      }
      await runScrape();
      if (scrapeActive) {
        scheduleFallbackRun();
      }
    }, delay);
  };

  const runScrape = async () => {
    if (scrapeInFlight) return;
    if (Date.now() >= deadline) {
      finishScrape([]);
      return;
    }

    scrapeInFlight = true;

    try {
      const items = await collectItemsForCurrentPlatform();

      if (items.length > 0) {
        finishScrape(items);
      } else if (Date.now() >= deadline) {
        finishScrape([]);
      }
    } finally {
      scrapeInFlight = false;
    }
  };

  const scheduleScrape = (delay = 0) => {
    if (scrapeMutationTimeoutId) {
      return;
    }

    scrapeMutationTimeoutId = setTimeout(() => {
      scrapeMutationTimeoutId = null;
      void runScrape();
    }, delay);
  };

  scrapeObserver = new MutationObserver(() => {
    scheduleScrape(SCRAPE_MUTATION_DEBOUNCE_MS);
  });

  scrapeObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  scheduleFallbackRun();
  scheduleScrape(0);
}

// ══════════════════════════════════════════════════════════════
// PiP (one click, always-on-top, reads from chrome.storage)
// ══════════════════════════════════════════════════════════════

function setPiPButtonState(active) {
  pagePiPActive = !!active;
  const btn = document.getElementById("xpip-btn");
  if (!btn) return;
  btn.style.background = active ? "#e0245e" : "#1d9bf0";
  btn.textContent = active ? "Stop" : "PiP";
}

async function syncPiPButtonState() {
  try {
    const resp = await new Promise((resolve) => {
      if (!safeSendRuntimeMessage({ action: "getPipStatus" }, resolve)) {
        resolve(null);
      }
    });
    setPiPButtonState(!!resp?.active);
  } catch (e) {}
}

function togglePiPWindowFromPage() {
  const action = pagePiPActive ? "closePiPWindow" : "openPiPWindow";
  safeSendRuntimeMessage({ action }, (resp) => {
    if (resp?.ok === false) {
      console.warn(LOG_PREFIX, "Failed to toggle PiP window");
    }
    syncPiPButtonState();
  });
}

function toggleSidePanelFromPage() {
  safeSendRuntimeMessage({ action: "toggleSidePanel" }, (resp) => {
    if (resp?.ok === false) {
      console.warn(LOG_PREFIX, "Failed to toggle side panel");
    }
  });
}

// ══════════════════════════════════════════════════════════════
// BUTTON
// ══════════════════════════════════════════════════════════════

function addFeedButtons() {
  if (scraperMode || document.getElementById("xpip-launchers") || !document.body) return;

  const launcher = document.createElement("div");
  launcher.id = "xpip-launchers";
  launcher.setAttribute("style", `
    position: fixed !important;
    top: 20px !important;
    right: 20px !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 8px !important;
    z-index: 2147483647 !important;
  `);

  const btn = document.createElement("button");
  btn.id = "xpip-btn";
  btn.textContent = "PiP";
  btn.setAttribute("style", `
    width: 58px !important;
    height: 36px !important;
    background: #1d9bf0 !important;
    color: white !important;
    border-radius: 999px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-weight: 700 !important;
    font-size: 12px !important;
    cursor: pointer !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4) !important;
    font-family: -apple-system, sans-serif !important;
    border: none !important;
    padding: 0 12px !important;
  `);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    togglePiPWindowFromPage();
  }, true);

  const panelBtn = document.createElement("button");
  panelBtn.id = "xpanel-btn";
  panelBtn.textContent = "Panel";
  panelBtn.setAttribute("style", `
    width: 58px !important;
    height: 36px !important;
    background: #16181c !important;
    color: white !important;
    border-radius: 999px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-weight: 700 !important;
    font-size: 12px !important;
    cursor: pointer !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4) !important;
    font-family: -apple-system, sans-serif !important;
    border: 1px solid rgba(255,255,255,0.18) !important;
    padding: 0 12px !important;
  `);

  panelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    toggleSidePanelFromPage();
  }, true);

  launcher.appendChild(btn);
  launcher.appendChild(panelBtn);
  document.body.appendChild(launcher);
}

if (hasValidExtensionContext()) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (scraperMode) return;

    if (msg.action === "pipStatusChanged") {
      setPiPButtonState(!!msg.active);
    }
    if (msg.action === "togglePiP") {
      togglePiPWindowFromPage();
    }
  });
}

async function initializeScraperTab() {
  try {
    const resp = await new Promise((resolve) => {
      if (!safeSendRuntimeMessage({ action: "isScraperTab" }, resolve)) {
        resolve(null);
      }
    });
    scraperMode = !!resp?.isScraper;
  } catch (e) {
    scraperMode = false;
  }

  if (document.body) {
    addFeedButtons();
    syncPiPButtonState();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      addFeedButtons();
      syncPiPButtonState();
    }, { once: true });
  }

  if (!scraperMode) {
    return;
  }

  if (PLATFORM === "x") {
    await ensureFollowingTimeline();
  }

  startScrapeLoop();
}

initializeScraperTab();
