import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

const hyperliquidInfoUrl = "https://api.hyperliquid.xyz/info";

const cmeSymbols = new Set([
  "SP500",
  "XYZ100",
  "CL",
  "BRENTOIL",
  "NATGAS",
  "GOLD",
  "SILVER",
  "PLATINUM",
  "PALLADIUM",
  "COPPER",
]);

const fxSymbols = new Set(["JPY", "EUR"]);
const koreaSymbols = new Set(["SKHX", "SMSN", "HYUNDAI"]);

const discoveryOverrides = {
  SP500: { boundPct: 2, resets: 1, label: "SP500" },
  XYZ100: { boundPct: 3.5, resets: 1, label: "XYZ100" },
  GOLD: { boundPct: 4, resets: 1, label: "GOLD" },
  SILVER: { boundPct: 4, resets: 2, label: "SILVER" },
  NVDA: { boundPct: 5, resets: 1, label: "NVDA" },
  AAPL: { boundPct: 5, resets: 1, label: "AAPL" },
  CL: { boundPct: 5, resets: 2, label: "WTIOIL (CL)" },
  BRENTOIL: { boundPct: 5, resets: 2, label: "BRENTOIL" },
  COPPER: { boundPct: 5, resets: 0, label: "COPPER" },
  PLATINUM: { boundPct: 5, resets: 0, label: "PLATINUM" },
  PALLADIUM: { boundPct: 5, resets: 0, label: "PALLADIUM" },
  EWY: { boundPct: 5, resets: 0, label: "EWY" },
  EWJ: { boundPct: 5, resets: 0, label: "EWJ" },
  JPY: { boundPct: 2, resets: 0, label: "JPY" },
  EUR: { boundPct: 2, resets: 0, label: "EUR" },
};

const sourceLinks = [
  {
    label: "Hyperliquid info endpoint",
    url: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint",
  },
  {
    label: "Hyperliquid websocket",
    url: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket",
  },
  {
    label: "Hyperliquid websocket subscriptions",
    url: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions",
  },
  {
    label: "Hyperliquid websocket heartbeats",
    url: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats",
  },
  {
    label: "trade[XYZ] funding",
    url: "https://docs.trade.xyz/perp-mechanics/funding",
  },
  {
    label: "trade[XYZ] discovery bounds",
    url: "https://docs.trade.xyz/perp-mechanics/discovery-bounds",
  },
  {
    label: "trade[XYZ] discovery bounds v2 changelog",
    url: "https://docs.trade.xyz/changelog/discovery-bounds-v2",
  },
  {
    label: "trade[XYZ] funding formula update",
    url: "https://docs.trade.xyz/changelog/funding-rate-formula-update",
  },
  {
    label: "trade[XYZ] oracle time constant update",
    url: "https://docs.trade.xyz/changelog/oracle-time-constant-update",
  },
  {
    label: "trade[XYZ] specification index",
    url: "https://docs.trade.xyz/consolidated-resources/specification-index",
  },
];

const researchNotes = [
  "HIP-3 perpetuals sit on separate perp dexes. Hyperliquid's `dex` parameter selects the universe, so the dashboard queries `dex: \"xyz\"` instead of the default core perp book.",
  "trade[XYZ] funding is hourly and uses a 0.5x scaling of Hyperliquid's baseline formula. That cut the default carry profile for traditional assets roughly in half on December 19, 2025.",
  "During closed sessions, trade[XYZ] freezes the external price at the last externally-derived fair price while the oracle can keep moving via internal pricing. That is why current perp prices can embed both expected gap risk and funding carry before the next external open.",
  "Discovery Bounds v2, announced March 13, 2026, re-anchors the discovery window when the oracle reaches a trigger near the edge of the bound. Some markets can ratchet the bound one or two times before hitting a hard cap.",
  "This dashboard now runs in Hyperliquid-only mode. Live prices, mark/oracle context, and funding are streamed from Hyperliquid; the annual discount rate is a manual assumption you can set in the UI.",
  "The implied open model treats the current hourly funding rate as the carry proxy through the next external open. That is a practical heuristic, not a guaranteed realized funding path.",
];

function json(body, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function text(body, status = 200, contentType = "text/plain; charset=utf-8") {
  return {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
    body,
  };
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function hyperInfo(body) {
  return fetchJson(hyperliquidInfoUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const mapped = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    weekday: weekdayMap[mapped.weekday],
    hour: Number(mapped.hour),
    minute: Number(mapped.minute),
    second: Number(mapped.second),
  };
}

function minutesSinceMidnight(parts) {
  return parts.hour * 60 + parts.minute + parts.second / 60;
}

function isExternalOpenNy(date, sessionType) {
  const parts = getParts(date, "America/New_York");
  const weekday = parts.weekday;
  const minutes = minutesSinceMidnight(parts);

  if (sessionType === "equity24x5") {
    if (weekday === 0) {
      return minutes >= 20 * 60;
    }
    if (weekday >= 1 && weekday <= 4) {
      return true;
    }
    if (weekday === 5) {
      return minutes < 20 * 60;
    }
    return false;
  }

  if (sessionType === "fx24x5") {
    if (weekday === 0) {
      return minutes >= 17 * 60;
    }
    if (weekday >= 1 && weekday <= 4) {
      return true;
    }
    if (weekday === 5) {
      return minutes < 17 * 60;
    }
    return false;
  }

  if (sessionType === "cme") {
    if (weekday === 0) {
      return minutes >= 18 * 60;
    }
    if (weekday >= 1 && weekday <= 3) {
      return minutes < 17 * 60 || minutes >= 18 * 60;
    }
    if (weekday === 4) {
      return minutes < 17 * 60 || minutes >= 18 * 60;
    }
    if (weekday === 5) {
      return minutes < 17 * 60;
    }
    return false;
  }

  return false;
}

function isExternalOpenKorea(date) {
  const parts = getParts(date, "Asia/Seoul");
  const weekday = parts.weekday;
  const minutes = minutesSinceMidnight(parts);

  if (weekday === 0 || weekday === 6) {
    return false;
  }

  const inPre = minutes >= 8 * 60 && minutes < 8 * 60 + 50;
  const inMain = minutes >= 9 * 60 && minutes < 15 * 60 + 30;
  const inAfterHours = minutes >= 15 * 60 + 40 && minutes < 20 * 60;

  return inPre || inMain || inAfterHours;
}

function getSessionType(symbol) {
  if (koreaSymbols.has(symbol)) {
    return "korea";
  }
  if (fxSymbols.has(symbol)) {
    return "fx24x5";
  }
  if (cmeSymbols.has(symbol)) {
    return "cme";
  }
  return "equity24x5";
}

function getSessionLabel(sessionType) {
  switch (sessionType) {
    case "korea":
      return "Korea external sessions";
    case "fx24x5":
      return "FX 24/5";
    case "cme":
      return "CME-style extended session";
    default:
      return "Equity 24/5";
  }
}

function isExternalOpen(date, sessionType) {
  if (sessionType === "korea") {
    return isExternalOpenKorea(date);
  }
  return isExternalOpenNy(date, sessionType);
}

function findNextExternalOpen(now, sessionType) {
  if (isExternalOpen(now, sessionType)) {
    return { isOpen: true, nextOpenAt: now.toISOString(), hoursToOpen: 0 };
  }

  const base = new Date(now);
  base.setUTCSeconds(0, 0);

  const maxSteps = 10 * 24 * 60;
  for (let step = 1; step <= maxSteps; step += 1) {
    const candidate = new Date(base.getTime() + step * 60 * 1000);
    if (isExternalOpen(candidate, sessionType)) {
      const hours = (candidate.getTime() - now.getTime()) / (60 * 60 * 1000);
      return {
        isOpen: false,
        nextOpenAt: candidate.toISOString(),
        hoursToOpen: hours,
      };
    }
  }

  throw new Error(`Unable to find next open for session type ${sessionType}`);
}

function getDiscoveryConfig(symbol, maxLeverage) {
  const override = discoveryOverrides[symbol];
  if (override) {
    return {
      boundPct: override.boundPct,
      resets: override.resets,
      label: override.label,
    };
  }

  return {
    boundPct: round(100 / maxLeverage, 2),
    resets: 0,
    label: symbol,
  };
}

function maxDiscoveryExcursion(boundPct, resets) {
  const step = 1 + boundPct / 100;
  const downStep = 1 - boundPct / 100;

  return {
    upPct: (step ** (resets + 1) - 1) * 100,
    downPct: (1 - downStep ** (resets + 1)) * 100,
  };
}

function buildMarketRows(metaUniverse, assetContexts, oiCaps, discountRatePct = 0) {
  const now = new Date();
  const discountRateDecimal = discountRatePct / 100;
  return metaUniverse
    .map((meta, index) => ({ meta, ctx: assetContexts[index] }))
    .filter(({ meta, ctx }) => !meta.isDelisted && ctx?.markPx && ctx?.oraclePx)
    .map(({ meta, ctx }) => {
      const symbol = meta.name.replace(/^xyz:/, "");
      const sessionType = getSessionType(symbol);
      const nextOpen = findNextExternalOpen(now, sessionType);
      const maxLeverage = Number(meta.maxLeverage);
      const markPx = Number(ctx.markPx);
      const oraclePx = Number(ctx.oraclePx);
      const midPx = ctx.midPx ? Number(ctx.midPx) : markPx;
      const fundingRateHourly = Number(ctx.funding);
      const hoursToOpen = nextOpen.hoursToOpen;
      const fundingCarry = fundingRateHourly * hoursToOpen;
      const discountCarry = discountRateDecimal * (hoursToOpen / 8760);
      const totalCarry = fundingCarry + discountCarry;
      const impliedOpenPx = markPx * Math.exp(totalCarry);
      const openInterestBase = Number(ctx.openInterest || 0);
      const openInterestUsd = openInterestBase * oraclePx;
      const oiCapUsd = Number(oiCaps.get(meta.name) || 0);
      const discovery = getDiscoveryConfig(symbol, maxLeverage);
      const excursion = maxDiscoveryExcursion(discovery.boundPct, discovery.resets);

      return {
        coin: meta.name,
        symbol,
        displayName: discovery.label,
        sessionType,
        sessionLabel: getSessionLabel(sessionType),
        maxLeverage,
        marginMode: meta.marginMode || "cross-or-standard",
        markPx: round(markPx, 6),
        midPx: round(midPx, 6),
        oraclePx: round(oraclePx, 6),
        fundingRateHourly: round(fundingRateHourly, 10),
        premium: round(Number(ctx.premium || 0), 8),
        openInterest: round(openInterestBase, 8),
        premiumPct: round(Number(ctx.premium || 0) * 100, 3),
        fundingRateHourlyPct: round(fundingRateHourly * 100, 4),
        fundingAprPct: round(fundingRateHourly * 24 * 365 * 100, 2),
        fundingPer1mPerHourUsd: round(1_000_000 * fundingRateHourly, 2),
        discountRatePct: round(discountRatePct, 4),
        discountCarryPct: round(discountCarry * 100, 3),
        fundingCarryPct: round(fundingCarry * 100, 3),
        totalCarryPct: round((Math.exp(totalCarry) - 1) * 100, 3),
        impliedOpenPx: round(impliedOpenPx, 6),
        impliedGapPct: round(((impliedOpenPx / markPx) - 1) * 100, 3),
        basisToOraclePct: round(((markPx / oraclePx) - 1) * 100, 3),
        openInterestUsd: round(openInterestUsd, 2),
        oiCapUsd: round(oiCapUsd, 2),
        oiUtilizationPct: oiCapUsd > 0 ? round((openInterestUsd / oiCapUsd) * 100, 2) : null,
        nextExternalOpenAt: nextOpen.nextOpenAt,
        hoursToNextExternalOpen: round(hoursToOpen, 2),
        isExternalOpen: nextOpen.isOpen,
        discoveryBoundPct: discovery.boundPct,
        discoveryResets: discovery.resets,
        maxDiscoverableUpPct: round(excursion.upPct, 2),
        maxDiscoverableDownPct: round(excursion.downPct, 2),
        dayVolumeUsd: round(Number(ctx.dayNtlVlm || 0), 2),
      };
    })
    .sort((left, right) => right.totalCarryPct - left.totalCarryPct);
}

async function buildDashboard() {
  const [metaAndAssetCtxs, perpDexLimits] = await Promise.all([
    hyperInfo({ type: "metaAndAssetCtxs", dex: "xyz" }),
    hyperInfo({ type: "perpDexLimits", dex: "xyz" }),
  ]);

  const [meta, assetContexts] = metaAndAssetCtxs;
  const oiCaps = new Map(perpDexLimits.coinToOiCap || []);
  const defaultDiscountRatePct = 0;
  const markets = buildMarketRows(meta.universe, assetContexts, oiCaps, defaultDiscountRatePct);
  const internalCount = markets.filter((market) => !market.isExternalOpen).length;

  return {
    asOf: new Date().toISOString(),
    dex: "xyz",
    wsUrl: "wss://api.hyperliquid.xyz/ws",
    heartbeatMs: 30000,
    defaultDiscountRatePct,
    marketCount: markets.length,
    marketsInInternalSession: internalCount,
    methodology: {
      formula: "implied_open = mark_price × exp((funding_rate_hourly × hours_to_open) + (annual_discount_rate × hours_to_open / 8760))",
      caveat:
        "This uses the current hourly funding rate as a flat carry assumption until the next external session. The discount leg is a manual assumption because Hyperliquid does not publish an FFR series.",
    },
    researchNotes,
    sources: sourceLinks,
    markets,
  };
}

async function fetchFundingHistory(coin, hours) {
  const cappedHours = Math.max(6, Math.min(Number(hours) || 72, 240));
  const endTime = Date.now();
  const startTime = endTime - cappedHours * 60 * 60 * 1000;
  const history = await hyperInfo({
    type: "fundingHistory",
    dex: "xyz",
    coin,
    startTime,
    endTime,
  });

  return {
    coin,
    hours: cappedHours,
    points: history.map((row) => ({
      time: row.time,
      fundingRateHourlyPct: round(Number(row.fundingRate) * 100, 4),
      premiumPct: round(Number(row.premium) * 100, 4),
    })),
  };
}

function safeJoin(base, target) {
  const resolved = normalize(join(base, target));
  return resolved.startsWith(base) ? resolved : null;
}

async function serveStatic(pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const fullPath = safeJoin(publicDir, relativePath);
  if (!fullPath) {
    return text("Not found", 404);
  }

  try {
    const file = await readFile(fullPath);
    const extension = extname(fullPath);
    const contentType =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
      }[extension] || "application/octet-stream";

    return {
      status: 200,
      headers: { "Content-Type": contentType },
      body: file,
    };
  } catch {
    return text("Not found", 404);
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname === "/api/dashboard") {
      const payload = await buildDashboard();
      const result = json(payload);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    if (url.pathname === "/api/funding-history") {
      const coin = url.searchParams.get("coin");
      if (!coin) {
        const result = json({ error: "coin is required" }, 400);
        response.writeHead(result.status, result.headers);
        response.end(result.body);
        return;
      }

      const payload = await fetchFundingHistory(coin, url.searchParams.get("hours"));
      const result = json(payload);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    const result = await serveStatic(url.pathname);
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  } catch (error) {
    const result = json({ error: formatError(error) }, 500);
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  }
});

server.listen(port, () => {
  console.log(`Implied open dashboard running at http://localhost:${port}`);
});
