const state = {
  dashboard: null,
  marketsByCoin: new Map(),
  selectedCoin: null,
  filteredMarkets: [],
  derivedMarkets: [],
  derivedMarketsByCoin: new Map(),
  derivedCacheKey: null,
  fundingHistoryByCoin: new Map(),
  showDiscoveryExplainer: false,
  renderTimer: null,
  stream: {
    socket: null,
    reconnectTimer: null,
    pingTimer: null,
    status: "connecting",
    retryCount: 0,
    lastMessageAt: null,
  },
};

const elements = {
  summaryCards: document.querySelector("#summaryCards"),
  marketTableBody: document.querySelector("#marketTableBody"),
  researchNotes: document.querySelector("#researchNotes"),
  sourceList: document.querySelector("#sourceList"),
  snapshotStamp: document.querySelector("#snapshotStamp"),
  streamStatus: document.querySelector("#streamStatus"),
  reconnectButton: document.querySelector("#reconnectButton"),
  searchInput: document.querySelector("#searchInput"),
  assetSelect: document.querySelector("#assetSelect"),
  sessionFilter: document.querySelector("#sessionFilter"),
  sortSelect: document.querySelector("#sortSelect"),
  discountRateInput: document.querySelector("#discountRateInput"),
  detailTitle: document.querySelector("#detailTitle"),
  detailSubtitle: document.querySelector("#detailSubtitle"),
  detailBody: document.querySelector("#detailBody"),
};

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function fmtNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
}

function fmtPrice(value) {
  if (value === null || value === undefined) {
    return "n/a";
  }

  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 3 : 5;
  return `$${fmtNumber(value, digits)}`;
}

function fmtPct(value, digits = 2) {
  if (value === null || value === undefined) {
    return "n/a";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${fmtNumber(value, digits)}%`;
}

function fmtCompactUsd(value) {
  if (value === null || value === undefined) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function fmtDateTime(iso) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function metricClass(value) {
  if (value > 0.01) {
    return "metric-up";
  }
  if (value < -0.01) {
    return "metric-down";
  }
  return "metric-flat";
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
    if (weekday === 0) return minutes >= 20 * 60;
    if (weekday >= 1 && weekday <= 4) return true;
    if (weekday === 5) return minutes < 20 * 60;
    return false;
  }

  if (sessionType === "fx24x5") {
    if (weekday === 0) return minutes >= 17 * 60;
    if (weekday >= 1 && weekday <= 4) return true;
    if (weekday === 5) return minutes < 17 * 60;
    return false;
  }

  if (sessionType === "cme") {
    if (weekday === 0) return minutes >= 18 * 60;
    if (weekday >= 1 && weekday <= 4) return minutes < 17 * 60 || minutes >= 18 * 60;
    if (weekday === 5) return minutes < 17 * 60;
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
      return {
        isOpen: false,
        nextOpenAt: candidate.toISOString(),
        hoursToOpen: (candidate.getTime() - now.getTime()) / (60 * 60 * 1000),
      };
    }
  }

  throw new Error(`Unable to find next open for ${sessionType}`);
}

function getSessionWindow(now, sessionType, sessionCache) {
  const minuteBucket = Math.floor(now.getTime() / 60000);
  const cacheKey = `${sessionType}:${minuteBucket}`;
  const cached = sessionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const computed = findNextExternalOpen(now, sessionType);
  sessionCache.set(cacheKey, computed);
  return computed;
}

function maxDiscoveryExcursion(boundPct, resets) {
  const step = 1 + boundPct / 100;
  const downStep = 1 - boundPct / 100;

  return {
    upPct: (step ** (resets + 1) - 1) * 100,
    downPct: (1 - downStep ** (resets + 1)) * 100,
  };
}

function deriveMarket(baseMarket, now, sessionCache) {
  const nextOpen = getSessionWindow(now, baseMarket.sessionType, sessionCache);
  const fundingRateHourly = Number(baseMarket.fundingRateHourly || 0);
  const discountRatePct = Number(state.discountRatePct || 0);
  const discountRateDecimal = discountRatePct / 100;
  const hoursToOpen = nextOpen.hoursToOpen;
  const fundingCarry = fundingRateHourly * hoursToOpen;
  const discountCarry = discountRateDecimal * (hoursToOpen / 8760);
  const totalCarry = fundingCarry + discountCarry;
  const markPx = Number(baseMarket.markPx);
  const oraclePx = Number(baseMarket.oraclePx);
  const openInterestBase = Number(baseMarket.openInterest || 0);
  const excursion = maxDiscoveryExcursion(baseMarket.discoveryBoundPct, baseMarket.discoveryResets);
  const impliedOpenPx = markPx * Math.exp(totalCarry);

  return {
    ...baseMarket,
    discountRatePct: round(discountRatePct, 4),
    premiumPct: round(Number(baseMarket.premium || 0) * 100, 3),
    fundingRateHourlyPct: round(fundingRateHourly * 100, 4),
    fundingAprPct: round(fundingRateHourly * 24 * 365 * 100, 2),
    fundingPer1mPerHourUsd: round(1_000_000 * fundingRateHourly, 2),
    discountCarryPct: round(discountCarry * 100, 3),
    fundingCarryPct: round(fundingCarry * 100, 3),
    totalCarryPct: round((Math.exp(totalCarry) - 1) * 100, 3),
    impliedOpenPx: round(impliedOpenPx, 6),
    impliedGapPct: round(((impliedOpenPx / markPx) - 1) * 100, 3),
    basisToOraclePct: round(((markPx / oraclePx) - 1) * 100, 3),
    openInterestUsd: round(openInterestBase * oraclePx, 2),
    oiUtilizationPct: baseMarket.oiCapUsd > 0 ? round(((openInterestBase * oraclePx) / baseMarket.oiCapUsd) * 100, 2) : null,
    maxDiscoverableUpPct: round(excursion.upPct, 2),
    maxDiscoverableDownPct: round(excursion.downPct, 2),
    nextExternalOpenAt: nextOpen.nextOpenAt,
    hoursToNextExternalOpen: round(hoursToOpen, 2),
    isExternalOpen: nextOpen.isOpen,
  };
}

function getDerivedMarkets() {
  if (!state.dashboard) {
    return [];
  }

  const now = new Date();
  const minuteBucket = Math.floor(now.getTime() / 60000);
  const cacheKey = `${minuteBucket}:${state.discountRatePct}`;
  if (state.derivedCacheKey === cacheKey) {
    return state.derivedMarkets;
  }

  const sessionCache = new Map();
  const derivedMarkets = state.dashboard.markets.map((market) => deriveMarket(market, now, sessionCache));

  state.derivedMarkets = derivedMarkets;
  state.derivedMarketsByCoin = new Map(derivedMarkets.map((market) => [market.coin, market]));
  state.derivedCacheKey = cacheKey;

  return derivedMarkets;
}

function renderAssetSelect() {
  if (!state.dashboard) {
    return;
  }

  const current = state.selectedCoin || state.dashboard.markets[0]?.coin || "";
  elements.assetSelect.innerHTML = state.dashboard.markets
    .slice()
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .map((market) => `<option value="${market.coin}" ${market.coin === current ? "selected" : ""}>${market.symbol}</option>`)
    .join("");
}

function setStreamStatus(status, copy) {
  state.stream.status = status;
  elements.streamStatus.textContent = copy;
  elements.streamStatus.className = `stream-status ${status === "live" ? "is-live" : "is-connecting"}`;
}

function renderSummaryCards(derivedMarkets) {
  const sortedMarkets = [...derivedMarkets].sort((left, right) => right.impliedGapPct - left.impliedGapPct);
  const topCarry = sortedMarkets[0];
  const internalCount = derivedMarkets.filter((market) => !market.isExternalOpen).length;

  const markup = [
    {
      label: "Discount Rate",
      value: `${fmtNumber(state.discountRatePct, 2)}%`,
      foot: "Manual annual assumption in Hyperliquid-only mode",
    },
    {
      label: "trade[XYZ] Markets",
      value: fmtNumber(derivedMarkets.length, 0),
      foot: `${fmtNumber(internalCount, 0)} currently in internal session`,
    },
    {
      label: "Highest Carry Gap",
      value: fmtPct(topCarry?.impliedGapPct ?? 0, 2),
      foot: topCarry ? `${topCarry.symbol} using current hourly funding` : "n/a",
    },
    {
      label: "Stream",
      value: state.stream.status === "live" ? "Live" : "Connecting",
      foot: state.stream.lastMessageAt ? `Last websocket message ${fmtDateTime(state.stream.lastMessageAt)}` : "Awaiting data",
    },
  ]
    .map(
      (card) => `
        <article class="summary-card">
          <div class="summary-label">${card.label}</div>
          <div class="summary-value">${card.value}</div>
          <div class="summary-foot">${card.foot}</div>
        </article>
      `,
    )
    .join("");

  elements.summaryCards.innerHTML = markup;
}

function renderResearch() {
  elements.researchNotes.innerHTML = state.dashboard.researchNotes.map((note) => `<p>${note}</p>`).join("");
  elements.sourceList.innerHTML = state.dashboard.sources
    .map((source) => `<li><a href="${source.url}" target="_blank" rel="noreferrer">${source.label}</a></li>`)
    .join("");
}

function filterAndSortMarkets() {
  if (!state.dashboard) {
    return;
  }

  const query = elements.searchInput.value.trim().toLowerCase();
  const sessionFilter = elements.sessionFilter.value;
  const sortKey = elements.sortSelect.value;

  const derivedMarkets = getDerivedMarkets();
  let markets = [...derivedMarkets];

  if (query) {
    markets = markets.filter((market) => {
      const haystack = `${market.symbol} ${market.displayName} ${market.sessionLabel}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  if (sessionFilter === "internal") {
    markets = markets.filter((market) => !market.isExternalOpen);
  } else if (sessionFilter === "open") {
    markets = markets.filter((market) => market.isExternalOpen);
  } else if (sessionFilter !== "all") {
    markets = markets.filter((market) => market.sessionType === sessionFilter);
  }

  const sorters = {
    carry: (left, right) => right.impliedGapPct - left.impliedGapPct,
    funding: (left, right) => right.fundingRateHourlyPct - left.fundingRateHourlyPct,
    utilization: (left, right) => (right.oiUtilizationPct ?? -Infinity) - (left.oiUtilizationPct ?? -Infinity),
    volume: (left, right) => right.dayVolumeUsd - left.dayVolumeUsd,
    hours: (left, right) => left.hoursToNextExternalOpen - right.hoursToNextExternalOpen,
  };

  markets.sort(sorters[sortKey]);
  state.filteredMarkets = markets;
  renderSummaryCards(derivedMarkets);
  renderMarketTable();

  if (!state.selectedCoin && markets.length > 0) {
    selectMarket(markets[0].coin);
  } else if (state.selectedCoin && !markets.some((market) => market.coin === state.selectedCoin) && markets.length > 0) {
    selectMarket(markets[0].coin);
  } else {
    renderSelectedDetail();
  }
}

function renderMarketTable() {
  const markup = state.filteredMarkets
    .map((market) => {
      const isActive = market.coin === state.selectedCoin;
      return `
        <tr data-coin="${market.coin}" class="${isActive ? "is-active" : ""}">
          <td>
            <div class="market-cell">
              <span class="market-symbol">${market.symbol}</span>
              <span class="market-meta">${market.sessionLabel}</span>
            </div>
          </td>
          <td>${fmtPrice(market.markPx)}</td>
          <td class="${metricClass(market.fundingRateHourlyPct)}">${fmtPct(market.fundingRateHourlyPct, 4)}</td>
          <td class="${metricClass(market.fundingAprPct)}">${fmtPct(market.fundingAprPct, 1)}</td>
          <td>${fmtNumber(market.hoursToNextExternalOpen, 2)}h</td>
          <td>${fmtPrice(market.impliedOpenPx)}</td>
          <td class="${metricClass(market.impliedGapPct)}">${fmtPct(market.impliedGapPct, 3)}</td>
          <td>${fmtPct(market.discoveryBoundPct, 1)} / ${market.discoveryResets} resets</td>
          <td>${market.oiUtilizationPct === null ? "n/a" : fmtPct(market.oiUtilizationPct, 1)}</td>
        </tr>
      `;
    })
    .join("");

  elements.marketTableBody.innerHTML = markup || `<tr><td colspan="9">No markets match the current filters.</td></tr>`;
}

function buildSparkline(points) {
  if (!points.length) {
    return `<div class="detail-note">No funding history returned for this window.</div>`;
  }

  const values = points.map((point) => point.fundingRateHourlyPct);
  const width = 520;
  const height = 170;
  const padding = 16;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const xStep = (width - padding * 2) / Math.max(points.length - 1, 1);

  const coords = points.map((point, index) => {
    const x = padding + xStep * index;
    const y = height - padding - ((point.fundingRateHourlyPct - min) / span) * (height - padding * 2);
    return [x, y];
  });

  const line = coords.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const area = `${line} L${coords.at(-1)[0]},${height - padding} L${coords[0][0]},${height - padding} Z`;

  return `
    <div class="history-card">
      <h3>Recent hourly funding</h3>
      <svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <path class="area" d="${area}"></path>
        <path class="line" d="${line}"></path>
      </svg>
      <div class="axis-copy">
        <span>${fmtDateTime(new Date(points[0].time).toISOString())}</span>
        <span>${fmtDateTime(new Date(points.at(-1).time).toISOString())}</span>
      </div>
    </div>
  `;
}

function discoveryLadder(market) {
  const referencePx = Number(market.oraclePx);
  const bound = Number(market.discoveryBoundPct) / 100;
  const resets = Number(market.discoveryResets);
  const triggerFactor = 0.9;

  const activeLower = referencePx * (1 - bound);
  const activeUpper = referencePx * (1 + bound);
  const upperTrigger = resets > 0 ? referencePx * (1 + bound * triggerFactor) : null;
  const lowerTrigger = resets > 0 ? referencePx * (1 - bound * triggerFactor) : null;
  const levels = [];

  for (let level = 0; level <= resets; level += 1) {
    const ref = referencePx * (1 + bound) ** level;
    levels.push({
      side: "Up",
      level,
      reference: ref,
      lower: ref * (1 - bound),
      upper: ref * (1 + bound),
      trigger: level < resets ? ref * (1 + bound * triggerFactor) : null,
    });
  }

  for (let level = 0; level <= resets; level += 1) {
    const ref = referencePx * (1 - bound) ** level;
    levels.push({
      side: "Down",
      level,
      reference: ref,
      lower: ref * (1 - bound),
      upper: ref * (1 + bound),
      trigger: level < resets ? ref * (1 - bound * triggerFactor) : null,
    });
  }

  return {
    referencePx,
    activeLower,
    activeUpper,
    upperTrigger,
    lowerTrigger,
    levels,
  };
}

function buildDiscoveryExplainer(market) {
  const ladder = discoveryLadder(market);
  const levelRows = ladder.levels
    .map(
      (row) => `
        <tr>
          <td>${row.side} L${row.level}</td>
          <td>${fmtPrice(row.reference)}</td>
          <td>${fmtPrice(row.lower)}</td>
          <td>${fmtPrice(row.upper)}</td>
          <td>${row.trigger === null ? "Hard cap" : fmtPrice(row.trigger)}</td>
        </tr>
      `,
    )
    .join("");

  return `
    <div class="explain-card">
      <h3>Discovery bounds, explained for ${market.symbol}</h3>
      <p>
        trade[XYZ] defines discovery bounds off the <strong>external reference price</strong>. Hyperliquid's public
        feed exposes live mark and oracle, but not the trade[XYZ] external reference price or the current ratchet level.
        So the price ladder below uses the <strong>current oracle price as a live proxy reference</strong>.
      </p>
      <div class="explain-grid">
        <article class="detail-card">
          <h3>Proxy reference</h3>
          <div class="detail-kpi">${fmtPrice(ladder.referencePx)}</div>
          <div class="detail-note">
            Current oracle. If the market is externally open, this should be close to the true external reference.
          </div>
        </article>
        <article class="detail-card">
          <h3>Active window</h3>
          <div class="detail-kpi">${fmtPrice(ladder.activeLower)} to ${fmtPrice(ladder.activeUpper)}</div>
          <div class="detail-note">
            A ${fmtPct(market.discoveryBoundPct, 1)} band around the proxy reference. This is the instantaneous window size.
          </div>
        </article>
        <article class="detail-card">
          <h3>Reset triggers</h3>
          <div class="detail-kpi">${ladder.upperTrigger === null ? "No resets" : `${fmtPrice(ladder.lowerTrigger)} / ${fmtPrice(ladder.upperTrigger)}`}</div>
          <div class="detail-note">
            trade[XYZ] v2 re-anchors when the oracle reaches 90% of the distance to the current bound.
          </div>
        </article>
        <article class="detail-card">
          <h3>Configured max path</h3>
          <div class="detail-kpi">+${fmtNumber(market.maxDiscoverableUpPct, 2)}% / -${fmtNumber(market.maxDiscoverableDownPct, 2)}%</div>
          <div class="detail-note">
            That is the total path budget from the original session reference after ${market.discoveryResets} reset(s).
          </div>
        </article>
      </div>
      <table class="explain-table">
        <thead>
          <tr>
            <th>Path</th>
            <th>Reference</th>
            <th>Lower bound</th>
            <th>Upper bound</th>
            <th>Next trigger</th>
          </tr>
        </thead>
        <tbody>
          ${levelRows}
        </tbody>
      </table>
      <p class="explain-meta">
        Interpretation: the window width stays fixed at ${fmtPct(market.discoveryBoundPct, 1)}, but the whole band can re-anchor
        up to ${market.discoveryResets} time(s) in each direction. If you want exact bound prices from the true origin rather than
        this oracle proxy, the public Hyperliquid feed would need to expose trade[XYZ]'s external reference price and current bound level.
      </p>
    </div>
  `;
}

function renderSelectedDetail() {
  if (!state.selectedCoin) {
    return;
  }

  const market = state.derivedMarketsByCoin.get(state.selectedCoin) || getDerivedMarkets().find((candidate) => candidate.coin === state.selectedCoin);
  if (!market) {
    return;
  }

  const history = state.fundingHistoryByCoin.get(state.selectedCoin) || { points: [] };

  elements.detailTitle.textContent = `${market.symbol} detail`;
  elements.detailSubtitle.textContent = `${market.sessionLabel} • ${market.maxLeverage}x max leverage • ${market.marginMode}`;
  elements.detailBody.innerHTML = `
    <div class="pill">${market.isExternalOpen ? "External session open now" : `Next external open in ${fmtNumber(market.hoursToNextExternalOpen, 2)}h`}</div>
    <div class="detail-grid">
      <article class="detail-card">
        <h3>Implied open</h3>
        <div class="detail-kpi">${fmtPrice(market.impliedOpenPx)}</div>
        <div class="detail-note">
          ${fmtPct(market.impliedGapPct, 3)} versus the current mark from
          ${fmtPct(market.fundingCarryPct, 3)} funding carry and ${fmtPct(market.discountCarryPct, 3)} manual discount carry.
        </div>
      </article>
      <article class="detail-card">
        <h3>Funding snapshot</h3>
        <div class="detail-kpi ${metricClass(market.fundingRateHourlyPct)}">${fmtPct(market.fundingRateHourlyPct, 4)}</div>
        <div class="detail-note">
          ${fmtPct(market.fundingAprPct, 1)} annualized if this hourly rate persisted. Roughly ${fmtCompactUsd(
            market.fundingPer1mPerHourUsd,
          )} per $1m notional each hour.
        </div>
      </article>
      <article class="detail-card">
        <h3>Mark vs oracle</h3>
        <div class="detail-kpi ${metricClass(market.basisToOraclePct)}">${fmtPct(market.basisToOraclePct, 3)}</div>
        <div class="detail-note">
          Mark ${fmtPrice(market.markPx)} versus oracle ${fmtPrice(market.oraclePx)}. Premium index snapshot:
          ${fmtPct(market.premiumPct, 3)}.
        </div>
      </article>
      <article class="detail-card is-clickable" data-discovery-card="true">
        <h3>Discovery bounds</h3>
        <div class="detail-kpi">${fmtPct(market.discoveryBoundPct, 1)}</div>
        <div class="detail-note">
          ${market.discoveryResets} reset(s). The configured maximum path from the origin is
          +${fmtNumber(market.maxDiscoverableUpPct, 2)}% / -${fmtNumber(market.maxDiscoverableDownPct, 2)}%. Click for price ladder.
        </div>
      </article>
      <article class="detail-card">
        <h3>Open interest</h3>
        <div class="detail-kpi">${fmtCompactUsd(market.openInterestUsd)}</div>
        <div class="detail-note">
          ${market.oiUtilizationPct === null ? "No OI cap returned." : `${fmtPct(market.oiUtilizationPct, 1)} of the current OI cap (${fmtCompactUsd(market.oiCapUsd)}).`}
        </div>
      </article>
      <article class="detail-card">
        <h3>Next external open</h3>
        <div class="detail-kpi">${market.isExternalOpen ? "Open" : `${fmtNumber(market.hoursToNextExternalOpen, 2)}h`}</div>
        <div class="detail-note">${fmtDateTime(market.nextExternalOpenAt)}</div>
      </article>
    </div>
    ${state.showDiscoveryExplainer ? buildDiscoveryExplainer(market) : ""}
    ${buildSparkline(history.points)}
  `;

  const discoveryCard = elements.detailBody.querySelector("[data-discovery-card='true']");
  if (discoveryCard) {
    discoveryCard.addEventListener("click", () => {
      state.showDiscoveryExplainer = !state.showDiscoveryExplainer;
      renderSelectedDetail();
    });
  }
}

async function fetchFundingHistory(coin) {
  try {
    const response = await fetch(`/api/funding-history?coin=${encodeURIComponent(coin)}&hours=72`);
    const history = await response.json();
    state.fundingHistoryByCoin.set(coin, history);
    if (coin === state.selectedCoin) {
      renderSelectedDetail();
    }
  } catch (error) {
    if (coin === state.selectedCoin) {
      elements.detailBody.innerHTML = `<div class="empty-state">Failed to load funding history: ${error.message}</div>`;
    }
  }
}

function selectMarket(coin) {
  state.selectedCoin = coin;
  state.showDiscoveryExplainer = false;
  renderAssetSelect();
  filterAndSortMarkets();
  if (!state.fundingHistoryByCoin.has(coin)) {
    elements.detailBody.innerHTML = `<div class="empty-state">Loading funding history…</div>`;
  }
  fetchFundingHistory(coin);
}

function updateSnapshotStamp() {
  const sourceStamp = state.stream.lastMessageAt ? `Last stream update ${fmtDateTime(state.stream.lastMessageAt)}` : "Awaiting stream data";
  elements.snapshotStamp.textContent = `${sourceStamp} • Boot snapshot ${fmtDateTime(state.dashboard.asOf)}`;
}

function applyMidUpdate(mids) {
  for (const [coin, midString] of Object.entries(mids)) {
    const market = state.marketsByCoin.get(coin);
    if (!market) {
      continue;
    }
    const midPx = Number(midString);
    market.midPx = round(midPx, 6);
    if (!market.markPx) {
      market.markPx = round(midPx, 6);
    }
  }
}

function applyCtxUpdate(coin, ctx) {
  const market = state.marketsByCoin.get(coin);
  if (!market) {
    return;
  }

  market.fundingRateHourly = round(Number(ctx.funding || 0), 10);
  market.premium = round(Number(ctx.premium || 0), 8);
  market.openInterest = round(Number(ctx.openInterest || 0), 8);
  market.markPx = round(Number(ctx.markPx || market.markPx), 6);
  market.midPx = round(Number(ctx.midPx || market.midPx || market.markPx), 6);
  market.oraclePx = round(Number(ctx.oraclePx || market.oraclePx), 6);
  market.dayVolumeUsd = round(Number(ctx.dayNtlVlm || market.dayVolumeUsd || 0), 2);
}

function invalidateDerivedMarkets() {
  state.derivedCacheKey = null;
}

function scheduleRender(delayMs = 120) {
  if (state.renderTimer) {
    return;
  }

  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    updateSnapshotStamp();
    filterAndSortMarkets();
  }, delayMs);
}

function handleStreamMessage(payload) {
  if (!state.dashboard) {
    return;
  }

  state.stream.lastMessageAt = new Date().toISOString();

  if (payload.channel === "allMids") {
    applyMidUpdate(payload.data.mids || {});
  } else if (payload.channel === "activeAssetCtx") {
    applyCtxUpdate(payload.data.coin, payload.data.ctx || {});
  }

  invalidateDerivedMarkets();
  scheduleRender();
}

function clearStreamTimers() {
  if (state.stream.reconnectTimer) {
    clearTimeout(state.stream.reconnectTimer);
    state.stream.reconnectTimer = null;
  }
  if (state.stream.pingTimer) {
    clearInterval(state.stream.pingTimer);
    state.stream.pingTimer = null;
  }
}

function scheduleReconnect() {
  clearStreamTimers();
  state.stream.retryCount += 1;
  const backoffMs = Math.min(1000 * 2 ** Math.min(state.stream.retryCount, 5), 15000);
  setStreamStatus("connecting", `Reconnecting in ${Math.round(backoffMs / 1000)}s…`);
  state.stream.reconnectTimer = setTimeout(connectStream, backoffMs);
}

function connectStream() {
  if (!state.dashboard) {
    return;
  }

  clearStreamTimers();

  if (state.stream.socket) {
    try {
      state.stream.socket.close();
    } catch {
      // no-op
    }
  }

  setStreamStatus("connecting", "Connecting to Hyperliquid…");
  const socket = new WebSocket(state.dashboard.wsUrl);
  state.stream.socket = socket;

  socket.addEventListener("open", () => {
    state.stream.retryCount = 0;
    setStreamStatus("live", "Hyperliquid stream live");

    socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids", dex: state.dashboard.dex } }));

    for (const market of state.dashboard.markets) {
      socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: market.coin } }));
    }

    state.stream.pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ method: "ping" }));
      }
    }, state.dashboard.heartbeatMs);
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.channel === "subscriptionResponse" || payload.channel === "pong") {
        return;
      }
      handleStreamMessage(payload);
    } catch {
      // ignore malformed payloads
    }
  });

  socket.addEventListener("close", () => {
    setStreamStatus("connecting", "Stream disconnected");
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    setStreamStatus("connecting", "Stream error");
    try {
      socket.close();
    } catch {
      // no-op
    }
  });
}

async function loadDashboard() {
  elements.snapshotStamp.textContent = "Loading Hyperliquid snapshot…";
  const response = await fetch("/api/dashboard");
  const dashboard = await response.json();
  state.dashboard = dashboard;
  state.marketsByCoin = new Map(dashboard.markets.map((market) => [market.coin, market]));
  state.discountRatePct = dashboard.defaultDiscountRatePct;
  elements.discountRateInput.value = String(dashboard.defaultDiscountRatePct);
  state.selectedCoin = null;

  renderResearch();
  renderAssetSelect();
  updateSnapshotStamp();
  filterAndSortMarkets();
  connectStream();
}

elements.reconnectButton.addEventListener("click", connectStream);
elements.searchInput.addEventListener("input", () => filterAndSortMarkets());
elements.assetSelect.addEventListener("change", () => {
  selectMarket(elements.assetSelect.value);
});
elements.marketTableBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-coin]");
  if (row) {
    selectMarket(row.dataset.coin);
  }
});
elements.sessionFilter.addEventListener("change", () => filterAndSortMarkets());
elements.sortSelect.addEventListener("change", () => filterAndSortMarkets());
elements.discountRateInput.addEventListener("input", () => {
  state.discountRatePct = Number(elements.discountRateInput.value || 0);
  invalidateDerivedMarkets();
  filterAndSortMarkets();
});

setInterval(() => {
  if (state.dashboard) {
    invalidateDerivedMarkets();
    filterAndSortMarkets();
  }
}, 60 * 1000);

setInterval(() => {
  if (state.selectedCoin) {
    fetchFundingHistory(state.selectedCoin);
  }
}, 5 * 60 * 1000);

loadDashboard().catch((error) => {
  elements.snapshotStamp.textContent = `Failed to load snapshot: ${error.message}`;
  setStreamStatus("connecting", "Failed to boot");
});
