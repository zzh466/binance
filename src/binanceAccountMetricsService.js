const fs = require("node:fs");
const path = require("node:path");
const {
  addDecimal,
  compareDecimal,
  divideDecimal,
  isPositiveDecimal,
  multiplyDecimal,
  subtractDecimal,
} = require("./binance/decimalMath");

const STORE_VERSION = 2;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROCESSED_TRADE_RETENTION_MS = 48 * 60 * 60 * 1000;
const COMMON_QUOTE_ASSETS = ["USDT", "USDC", "FDUSD", "BTC", "ETH", "BNB"];

function firstPresent(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ""
  );
}

function safeDecimal(value, fallback = "0") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  try {
    addDecimal("0", text);
    return text;
  } catch {
    return fallback;
  }
}

function sumDecimals(values) {
  return values.reduce(
    (total, value) => addDecimal(total, safeDecimal(value)),
    "0"
  );
}

function negateDecimal(value) {
  return subtractDecimal("0", safeDecimal(value));
}

function buildTickerPriceMap(tickers = []) {
  const prices = new Map();
  for (const ticker of Array.isArray(tickers) ? tickers : []) {
    const symbol = String(ticker?.symbol || "").toUpperCase();
    const price = safeDecimal(ticker?.price, "");
    if (symbol && price && isPositiveDecimal(price)) prices.set(symbol, price);
  }
  return prices;
}

function convertAssetToUsdt(asset, amount, prices) {
  const normalizedAsset = String(asset || "").toUpperCase();
  const normalizedAmount = safeDecimal(amount, "");
  if (!normalizedAsset || !normalizedAmount) return null;
  if (normalizedAsset === "USDT") return normalizedAmount;

  const directPrice = prices.get(`${normalizedAsset}USDT`);
  if (directPrice) return multiplyDecimal(normalizedAmount, directPrice);

  const reversePrice = prices.get(`USDT${normalizedAsset}`);
  if (reversePrice) return divideDecimal(normalizedAmount, reversePrice);

  const assetBtcPrice = prices.get(`${normalizedAsset}BTC`);
  const btcUsdtPrice = prices.get("BTCUSDT");
  if (assetBtcPrice && btcUsdtPrice) {
    return multiplyDecimal(
      multiplyDecimal(normalizedAmount, assetBtcPrice),
      btcUsdtPrice
    );
  }
  return null;
}

function inferSymbolAssets(symbol) {
  const normalizedSymbol = String(symbol || "").toUpperCase();
  const quoteAsset = COMMON_QUOTE_ASSETS.find(
    (candidate) => normalizedSymbol.endsWith(candidate) &&
      normalizedSymbol.length > candidate.length
  );
  if (!quoteAsset) return null;
  return {
    baseAsset: normalizedSymbol.slice(0, -quoteAsset.length),
    quoteAsset,
  };
}

function normalizeSpotFill(trade = {}, symbolInfo = {}) {
  const symbol = String(firstPresent(trade.symbol, trade.s, "")).toUpperCase();
  const inferred = inferSymbolAssets(symbol) || {};
  const baseAsset = String(
    firstPresent(symbolInfo.baseAsset, inferred.baseAsset, "")
  ).toUpperCase();
  const quoteAsset = String(
    firstPresent(symbolInfo.quoteAsset, inferred.quoteAsset, "")
  ).toUpperCase();
  const quantity = safeDecimal(firstPresent(trade.qty, trade.l), "");
  const price = safeDecimal(firstPresent(trade.price, trade.L), "");
  const quoteQuantity = safeDecimal(
    firstPresent(
      trade.quoteQty,
      trade.Y,
      quantity && price ? multiplyDecimal(quantity, price) : ""
    ),
    ""
  );
  const side = trade.isBuyer === true
    ? "BUY"
    : trade.isBuyer === false
      ? "SELL"
      : String(firstPresent(trade.side, trade.S, "")).toUpperCase();
  const tradeId = firstPresent(trade.id, trade.tradeId, trade.t);
  const time = Number(firstPresent(trade.time, trade.T, trade.E, Date.now()));
  if (
    !symbol || !baseAsset || !quoteAsset ||
    !["BUY", "SELL"].includes(side) ||
    !isPositiveDecimal(quantity) || !isPositiveDecimal(quoteQuantity) ||
    tradeId === undefined || !Number.isFinite(time)
  ) {
    return null;
  }
  return {
    key: `${symbol}:${tradeId}`,
    symbol,
    tradeId: String(tradeId),
    baseAsset,
    quoteAsset,
    side,
    quantity,
    quoteQuantity,
    price: price || divideDecimal(quoteQuantity, quantity),
    commission: safeDecimal(firstPresent(trade.commission, trade.n)),
    commissionAsset: String(
      firstPresent(trade.commissionAsset, trade.N, "")
    ).toUpperCase(),
    time,
  };
}

function createScopeState(now) {
  return {
    initializedAt: now,
    lastSyncedAt: now,
    positions: {},
    realizedEvents: [],
    commissionEvents: [],
    processedTrades: {},
    incompleteSellCount: 0,
  };
}

class SpotPnlStore {
  constructor(filePath, { now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.scopes = {};
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.scopes = payload?.scopes && typeof payload.scopes === "object"
        ? payload.scopes
        : {};
      this.prune();
    } catch {
      this.scopes = {};
    }
  }

  getScope(scopeKey, { create = true } = {}) {
    if (!this.scopes[scopeKey] && create) {
      this.scopes[scopeKey] = createScopeState(this.now());
    }
    return this.scopes[scopeKey] || null;
  }

  hasScope(scopeKey) {
    return Boolean(this.scopes[scopeKey]);
  }

  initializeBalances(scopeKey, balances, prices) {
    const state = this.getScope(scopeKey);
    for (const balance of Array.isArray(balances) ? balances : []) {
      const asset = String(balance?.asset || "").toUpperCase();
      if (!asset || asset === "USDT") continue;
      const quantity = addDecimal(
        safeDecimal(balance.free),
        safeDecimal(balance.locked)
      );
      if (!isPositiveDecimal(quantity)) continue;
      const costUsdt = convertAssetToUsdt(asset, quantity, prices);
      if (!costUsdt) continue;
      state.positions[asset] = { quantity, costUsdt };
    }
    state.initializedAt = this.now();
    state.lastSyncedAt = this.now();
    this.scheduleSave();
    return state;
  }

  recordFill(scopeKey, fill, prices) {
    const state = this.getScope(scopeKey);
    if (!fill) return null;
    state.commissionEvents = Array.isArray(state.commissionEvents)
      ? state.commissionEvents
      : [];
    const commissionAlreadyRecorded = state.commissionEvents.some(
      (event) => event.key === fill.key
    );
    const commissionUsdt = fill.commissionAsset
      ? convertAssetToUsdt(fill.commissionAsset, fill.commission, prices)
      : "0";
    let commissionAdded = false;
    if (
      !commissionAlreadyRecorded &&
      commissionUsdt !== null &&
      isPositiveDecimal(commissionUsdt)
    ) {
      state.commissionEvents.push({
        key: fill.key,
        symbol: fill.symbol,
        tradeId: fill.tradeId,
        commissionUsdt,
        time: fill.time,
      });
      commissionAdded = true;
    }
    if (state.processedTrades[fill.key]) {
      if (commissionAdded) {
        this.prune();
        this.scheduleSave();
      }
      return null;
    }
    const quoteUsdt = convertAssetToUsdt(
      fill.quoteAsset,
      fill.quoteQuantity,
      prices
    );
    if (quoteUsdt === null) {
      if (commissionAdded) {
        this.prune();
        this.scheduleSave();
      }
      return null;
    }
    const position = state.positions[fill.baseAsset] || {
      quantity: "0",
      costUsdt: "0",
    };

    let realizedEvent = null;
    if (fill.side === "BUY") {
      const receivedQuantity = fill.commissionAsset === fill.baseAsset
        ? subtractDecimal(fill.quantity, fill.commission)
        : fill.quantity;
      const feeToAdd = fill.commissionAsset === fill.baseAsset
        ? "0"
        : commissionUsdt || "0";
      position.quantity = addDecimal(position.quantity, receivedQuantity);
      position.costUsdt = addDecimal(
        position.costUsdt,
        addDecimal(quoteUsdt, feeToAdd)
      );
    } else if (isPositiveDecimal(position.quantity)) {
      const matchedQuantity = compareDecimal(fill.quantity, position.quantity) <= 0
        ? fill.quantity
        : position.quantity;
      const ratio = divideDecimal(matchedQuantity, fill.quantity);
      const matchedProceeds = multiplyDecimal(quoteUsdt, ratio);
      const matchedCommission = commissionUsdt === null
        ? "0"
        : multiplyDecimal(commissionUsdt, ratio);
      const costRatio = divideDecimal(matchedQuantity, position.quantity);
      const matchedCost = compareDecimal(matchedQuantity, position.quantity) === 0
        ? position.costUsdt
        : multiplyDecimal(position.costUsdt, costRatio);
      const pnlUsdt = subtractDecimal(
        subtractDecimal(matchedProceeds, matchedCost),
        matchedCommission
      );
      realizedEvent = {
        key: fill.key,
        symbol: fill.symbol,
        tradeId: fill.tradeId,
        asset: fill.baseAsset,
        pnlUsdt,
        time: fill.time,
      };
      state.realizedEvents.push(realizedEvent);

      let removedQuantity = matchedQuantity;
      if (
        fill.commissionAsset === fill.baseAsset &&
        isPositiveDecimal(fill.commission)
      ) {
        removedQuantity = addDecimal(removedQuantity, fill.commission);
        if (compareDecimal(removedQuantity, position.quantity) > 0) {
          removedQuantity = position.quantity;
        }
      }
      const removalRatio = divideDecimal(removedQuantity, position.quantity);
      const removedCost = compareDecimal(removedQuantity, position.quantity) === 0
        ? position.costUsdt
        : multiplyDecimal(position.costUsdt, removalRatio);
      position.quantity = subtractDecimal(position.quantity, removedQuantity);
      position.costUsdt = subtractDecimal(position.costUsdt, removedCost);
      if (compareDecimal(fill.quantity, matchedQuantity) > 0) {
        state.incompleteSellCount += 1;
      }
    } else {
      state.incompleteSellCount += 1;
    }

    state.positions[fill.baseAsset] = position;
    state.processedTrades[fill.key] = fill.time;
    state.lastSyncedAt = Math.max(Number(state.lastSyncedAt || 0), fill.time);
    this.prune();
    this.scheduleSave();
    return realizedEvent;
  }

  reconcileBalances(scopeKey, balances, prices) {
    const state = this.getScope(scopeKey);
    const actualByAsset = new Map();
    for (const balance of Array.isArray(balances) ? balances : []) {
      const asset = String(balance?.asset || "").toUpperCase();
      if (!asset || asset === "USDT") continue;
      actualByAsset.set(
        asset,
        addDecimal(safeDecimal(balance.free), safeDecimal(balance.locked))
      );
    }

    const assets = new Set([
      ...Object.keys(state.positions),
      ...actualByAsset.keys(),
    ]);
    for (const asset of assets) {
      const actualQuantity = actualByAsset.get(asset) || "0";
      const position = state.positions[asset] || {
        quantity: "0",
        costUsdt: "0",
      };
      const comparison = compareDecimal(actualQuantity, position.quantity);
      if (comparison > 0) {
        const addition = subtractDecimal(actualQuantity, position.quantity);
        const additionCost = convertAssetToUsdt(asset, addition, prices);
        position.quantity = actualQuantity;
        if (additionCost !== null) {
          position.costUsdt = addDecimal(position.costUsdt, additionCost);
        }
      } else if (comparison < 0) {
        if (!isPositiveDecimal(actualQuantity) || !isPositiveDecimal(position.quantity)) {
          position.quantity = "0";
          position.costUsdt = "0";
        } else {
          const retainedRatio = divideDecimal(actualQuantity, position.quantity);
          position.quantity = actualQuantity;
          position.costUsdt = multiplyDecimal(position.costUsdt, retainedRatio);
        }
      }
      state.positions[asset] = position;
    }
    state.lastSyncedAt = this.now();
    this.scheduleSave();
  }

  getRollingRealizedPnl(scopeKey) {
    const state = this.getScope(scopeKey, { create: false });
    if (!state) return "0";
    const cutoff = this.now() - ROLLING_WINDOW_MS;
    return sumDecimals(
      state.realizedEvents
        .filter((event) => Number(event.time) >= cutoff)
        .map((event) => event.pnlUsdt)
    );
  }

  getRollingCommission(scopeKey) {
    const state = this.getScope(scopeKey, { create: false });
    if (!state) return "0";
    const cutoff = this.now() - ROLLING_WINDOW_MS;
    return sumDecimals(
      (state.commissionEvents || [])
        .filter((event) => Number(event.time) >= cutoff)
        .map((event) => event.commissionUsdt)
    );
  }

  getUnrealizedPnl(scopeKey, prices) {
    const state = this.getScope(scopeKey, { create: false });
    if (!state) return "0";
    let unrealizedPnl = "0";
    for (const [asset, position] of Object.entries(state.positions || {})) {
      const quantity = safeDecimal(position?.quantity);
      if (!isPositiveDecimal(quantity)) continue;
      const marketValue = convertAssetToUsdt(asset, quantity, prices);
      if (marketValue === null) continue;
      unrealizedPnl = addDecimal(
        unrealizedPnl,
        subtractDecimal(marketValue, safeDecimal(position?.costUsdt))
      );
    }
    return unrealizedPnl;
  }

  getOpenPositionCount(scopeKey) {
    const state = this.getScope(scopeKey, { create: false });
    if (!state) return 0;
    return Object.values(state.positions || {}).filter((position) =>
      isPositiveDecimal(position?.quantity)
    ).length;
  }

  getStatus(scopeKey) {
    const state = this.getScope(scopeKey, { create: false });
    if (!state) return null;
    return {
      initializedAt: state.initializedAt,
      lastSyncedAt: state.lastSyncedAt,
      incompleteSellCount: state.incompleteSellCount,
      realizedTradeCount: state.realizedEvents.length,
      commissionTradeCount: (state.commissionEvents || []).length,
    };
  }

  prune() {
    const now = this.now();
    const realizedCutoff = now - ROLLING_WINDOW_MS;
    const processedCutoff = now - PROCESSED_TRADE_RETENTION_MS;
    for (const state of Object.values(this.scopes)) {
      state.realizedEvents = (state.realizedEvents || []).filter(
        (event) => Number(event.time) >= realizedCutoff
      );
      state.commissionEvents = (state.commissionEvents || []).filter(
        (event) => Number(event.time) >= realizedCutoff
      );
      for (const [key, time] of Object.entries(state.processedTrades || {})) {
        if (Number(time) < processedCutoff) delete state.processedTrades[key];
      }
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 50);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify({
      version: STORE_VERSION,
      updatedAt: this.now(),
      scopes: this.scopes,
    }, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, this.filePath);
  }

  close() {
    if (this.saveTimer) this.flush();
  }
}

function valueSpotBalances(balances, prices) {
  let totalBalanceUsdt = "0";
  let availableUsdt = "0";
  let lockedUsdt = "0";
  const unpricedAssets = [];
  for (const balance of Array.isArray(balances) ? balances : []) {
    const asset = String(balance?.asset || "").toUpperCase();
    const free = safeDecimal(balance?.free);
    const locked = safeDecimal(balance?.locked);
    const total = addDecimal(free, locked);
    if (!isPositiveDecimal(total)) continue;
    const totalValue = convertAssetToUsdt(asset, total, prices);
    const freeValue = convertAssetToUsdt(asset, free, prices);
    const lockedValue = convertAssetToUsdt(asset, locked, prices);
    if (totalValue === null) {
      unpricedAssets.push(asset);
      continue;
    }
    totalBalanceUsdt = addDecimal(totalBalanceUsdt, totalValue);
    if (freeValue !== null) availableUsdt = addDecimal(availableUsdt, freeValue);
    if (lockedValue !== null) lockedUsdt = addDecimal(lockedUsdt, lockedValue);
  }
  return { totalBalanceUsdt, availableUsdt, lockedUsdt, unpricedAssets };
}

function summarizeFuturesIncome(entries, prices) {
  let realizedPnl24h = "0";
  let commissionIncome24h = "0";
  let fundingFee24h = "0";
  const unpricedIncomeAssets = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const asset = String(entry?.asset || "USDT").toUpperCase();
    const incomeUsdt = convertAssetToUsdt(asset, entry?.income, prices);
    if (incomeUsdt === null) {
      unpricedIncomeAssets.add(asset);
      continue;
    }
    const incomeType = String(entry?.incomeType || "REALIZED_PNL").toUpperCase();
    if (incomeType === "REALIZED_PNL") {
      realizedPnl24h = addDecimal(realizedPnl24h, incomeUsdt);
    } else if (incomeType === "COMMISSION") {
      commissionIncome24h = addDecimal(commissionIncome24h, incomeUsdt);
    } else if (incomeType === "FUNDING_FEE") {
      fundingFee24h = addDecimal(fundingFee24h, incomeUsdt);
    }
  }
  return {
    realizedPnl24h,
    commissionIncome24h,
    commission24h: negateDecimal(commissionIncome24h),
    fundingFee24h,
    actualPnl24h: sumDecimals([
      realizedPnl24h,
      commissionIncome24h,
      fundingFee24h,
    ]),
    unpricedIncomeAssets: [...unpricedIncomeAssets],
  };
}

function summarizeSpotTradeHistory(fills, prices, now = Date.now()) {
  const store = new SpotPnlStore(null, { now: () => now });
  const scopeKey = "rolling-history";
  const uniqueFills = new Map();
  for (const fill of Array.isArray(fills) ? fills : []) {
    if (fill?.key) uniqueFills.set(fill.key, fill);
  }
  const chronologicalFills = [...uniqueFills.values()]
    .filter((fill) => Number(fill.time) >= now - ROLLING_WINDOW_MS)
    .sort((left, right) => left.time - right.time);
  for (const fill of chronologicalFills) {
    store.recordFill(scopeKey, fill, prices);
  }
  const summary = {
    realizedPnl24h: store.getRollingRealizedPnl(scopeKey),
    commission24h: store.getRollingCommission(scopeKey),
    tradeCount: chronologicalFills.length,
    incompleteSellCount: store.getStatus(scopeKey)?.incompleteSellCount || 0,
    fills: chronologicalFills,
    updatedAt: now,
  };
  store.close();
  return summary;
}

function serializeWarning(marketType, operation, error) {
  return {
    marketType,
    operation,
    name: error?.name || "Error",
    message: error?.message || "未知错误",
    status: error?.status,
    code: error?.code,
  };
}

class BinanceAccountMetricsService {
  constructor({ storePath, now = () => Date.now() } = {}) {
    this.now = now;
    this.spotPnlStore = new SpotPnlStore(storePath, { now });
    this.spotPriceMaps = new Map();
    this.spotTradeHistoryCache = new Map();
    this.futuresIncomeCache = new Map();
  }

  getScopeKey(environment, accountFingerprint) {
    return `${environment}:${accountFingerprint}`;
  }

  ingestSpotExecution({ environment, accountFingerprint, event }) {
    if (event?.e !== "executionReport" || event?.x !== "TRADE") return null;
    const scopeKey = this.getScopeKey(environment, accountFingerprint);
    if (!this.spotPnlStore.hasScope(scopeKey)) return null;
    const prices = this.spotPriceMaps.get(scopeKey);
    if (!prices) return null;
    const fill = normalizeSpotFill(event);
    if (!fill) return null;
    this.spotPnlStore.recordFill(scopeKey, fill, prices);
    const cachedHistory = this.spotTradeHistoryCache.get(scopeKey);
    const history = summarizeSpotTradeHistory([
      ...(cachedHistory?.fills || []),
      fill,
    ], prices, this.now());
    this.spotTradeHistoryCache.set(scopeKey, history);
    return {
      realizedPnl24h: history.realizedPnl24h,
      commission24h: history.commission24h,
      unrealizedProfit: this.spotPnlStore.getUnrealizedPnl(scopeKey, prices),
      openPositionCount: this.spotPnlStore.getOpenPositionCount(scopeKey),
      ledger: this.spotPnlStore.getStatus(scopeKey),
    };
  }

  async queryFuturesIncome(client, options) {
    const rows = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await client.futures.incomeHistory({
        ...options,
        page,
        limit: 1000,
      });
      rows.push(...batch);
      if (batch.length < 1000) break;
    }
    return rows;
  }

  async loadSymbolInfo(client, symbols, warnings) {
    const entries = await Promise.allSettled(symbols.map(async (symbol) => {
      const info = await client.spot.exchangeInfo(symbol);
      return [symbol, info.symbol || inferSymbolAssets(symbol) || {}];
    }));
    const map = new Map();
    for (const [index, entry] of entries.entries()) {
      if (entry.status === "fulfilled") {
        map.set(...entry.value);
      } else {
        warnings.push(serializeWarning("spot", `exchangeInfo ${symbols[index]}`, entry.reason));
        map.set(symbols[index], inferSymbolAssets(symbols[index]) || {});
      }
    }
    return map;
  }

  async refresh({
    client,
    environment,
    accountFingerprint,
    knownSpotSymbols = [],
    reconcileHistory = true,
    openOrderCount = 0,
  }) {
    const now = this.now();
    const startTime = now - ROLLING_WINDOW_MS;
    const warnings = [];
    const hasSpot = Boolean(client?.spot?.apiKey && client?.spot?.apiSecret);
    const hasFutures = Boolean(client?.futures?.apiKey && client?.futures?.apiSecret);
    const scopeKey = this.getScopeKey(environment, accountFingerprint);
    const shouldReconcileHistory = Boolean(
      reconcileHistory ||
      (hasSpot && !this.spotPnlStore.hasScope(scopeKey)) ||
      (hasFutures && !this.futuresIncomeCache.has(scopeKey))
    );
    const hadCachedFuturesIncome = this.futuresIncomeCache.has(scopeKey);
    const spotAccountPromise = hasSpot
      ? client.spot.accountStatus({ omitZeroBalances: false })
      : Promise.reject(new Error("未配置现货凭证"));
    const tickerPromise = client?.spot?.tickerPrices
      ? client.spot.tickerPrices()
      : Promise.resolve([]);
    const futuresAccountPromise = hasFutures
      ? client.futures.accountStatus({ omitZeroBalances: false })
      : Promise.reject(new Error("未配置 U 本位凭证"));
    const futuresIncomePromise = hasFutures && shouldReconcileHistory
      ? this.queryFuturesIncome(client, {
          startTime,
          endTime: now,
        })
      : Promise.resolve(null);
    const [spotResult, tickerResult, futuresResult, incomeResult] =
      await Promise.allSettled([
        spotAccountPromise,
        tickerPromise,
        futuresAccountPromise,
        futuresIncomePromise,
      ]);

    if (spotResult.status === "rejected") {
      warnings.push(serializeWarning("spot", "account.status", spotResult.reason));
    }
    if (tickerResult.status === "rejected") {
      warnings.push(serializeWarning("spot", "ticker.price", tickerResult.reason));
    }
    if (futuresResult.status === "rejected") {
      warnings.push(serializeWarning("futures", "account.status", futuresResult.reason));
    }
    if (hasFutures && incomeResult.status === "rejected") {
      warnings.push(serializeWarning("futures", "income history", incomeResult.reason));
    }
    if (spotResult.status === "rejected" && futuresResult.status === "rejected") {
      throw spotResult.reason || futuresResult.reason;
    }

    const prices = buildTickerPriceMap(
      tickerResult.status === "fulfilled" ? tickerResult.value : []
    );
    this.spotPriceMaps.set(scopeKey, prices);
    let spotMetrics = {
      totalBalanceUsdt: "0",
      availableUsdt: "0",
      lockedUsdt: "0",
      realizedPnl24h: "0",
      commission24h: "0",
      unrealizedProfit: "0",
      openPositionCount: 0,
      unpricedAssets: [],
      ledger: null,
    };

    if (spotResult.status === "fulfilled") {
      const balances = spotResult.value?.balances || [];
      const symbols = [...new Set(knownSpotSymbols.map((symbol) =>
        String(symbol || "").toUpperCase()
      ).filter(Boolean))];
      if (!this.spotPnlStore.hasScope(scopeKey)) {
        this.spotPnlStore.initializeBalances(scopeKey, balances, prices);
      }
      if (shouldReconcileHistory && symbols.length) {
        const ledgerStatus = this.spotPnlStore.getStatus(scopeKey);
        const symbolInfo = await this.loadSymbolInfo(client, symbols, warnings);
        const tradeResults = await Promise.allSettled(symbols.map((symbol) =>
          client.spot.myTrades({
            symbol,
            startTime,
            endTime: now,
            limit: 1000,
          })
        ));
        const fills = [];
        for (const [index, result] of tradeResults.entries()) {
          if (result.status === "rejected") {
            warnings.push(serializeWarning(
              "spot",
              `myTrades ${symbols[index]}`,
              result.reason
            ));
            continue;
          }
          if (result.value.length >= 1000) {
            warnings.push({
              marketType: "spot",
              operation: `myTrades ${symbols[index]}`,
              name: "ResultLimitWarning",
              message: "成交达到 1000 条上限，极端高频区间可能需要继续补查。",
            });
          }
          for (const trade of result.value) {
            const fill = normalizeSpotFill(
              trade,
              symbolInfo.get(symbols[index])
            );
            if (fill) fills.push(fill);
          }
        }
        fills.sort((left, right) => left.time - right.time);
        for (const fill of fills) {
          if (fill.time >= Number(ledgerStatus?.initializedAt || now)) {
            this.spotPnlStore.recordFill(scopeKey, fill, prices);
          }
        }
        const history = summarizeSpotTradeHistory(fills, prices, now);
        this.spotTradeHistoryCache.set(scopeKey, history);
      }
      if (shouldReconcileHistory) {
        this.spotPnlStore.reconcileBalances(scopeKey, balances, prices);
      }
      const valuation = valueSpotBalances(balances, prices);
      const tradeHistory = this.spotTradeHistoryCache.get(scopeKey);
      spotMetrics = {
        ...valuation,
        realizedPnl24h: tradeHistory?.realizedPnl24h ??
          this.spotPnlStore.getRollingRealizedPnl(scopeKey),
        commission24h: tradeHistory?.commission24h ??
          this.spotPnlStore.getRollingCommission(scopeKey),
        unrealizedProfit: this.spotPnlStore.getUnrealizedPnl(scopeKey, prices),
        openPositionCount: this.spotPnlStore.getOpenPositionCount(scopeKey),
        tradeHistory: tradeHistory ? {
          tradeCount: tradeHistory.tradeCount,
          incompleteSellCount: tradeHistory.incompleteSellCount,
          updatedAt: tradeHistory.updatedAt,
        } : null,
        ledger: this.spotPnlStore.getStatus(scopeKey),
      };
      if (valuation.unpricedAssets.length) {
        warnings.push({
          marketType: "spot",
          operation: "USDT valuation",
          name: "UnpricedAssetWarning",
          message: `以下资产缺少 USDT 折算路径：${valuation.unpricedAssets.join(", ")}`,
        });
      }
    }

    const futuresAccount = futuresResult.status === "fulfilled"
      ? futuresResult.value
      : {};
    let futuresIncome = this.futuresIncomeCache.get(scopeKey) || {
      realizedPnl24h: "0",
      commissionIncome24h: "0",
      commission24h: "0",
      fundingFee24h: "0",
      actualPnl24h: "0",
      count: 0,
      updatedAt: null,
    };
    if (
      incomeResult.status === "fulfilled" &&
      Array.isArray(incomeResult.value)
    ) {
      const summary = summarizeFuturesIncome(incomeResult.value, prices);
      if (summary.unpricedIncomeAssets.length) {
        warnings.push({
          marketType: "futures",
          operation: "income history USDT valuation",
          name: "UnpricedIncomeWarning",
          message: `以下 U 本位收益资产缺少 USDT 折算路径：${[
            ...summary.unpricedIncomeAssets,
          ].join(", ")}`,
        });
      }
      futuresIncome = {
        ...summary,
        count: incomeResult.value.length,
        updatedAt: now,
      };
      this.futuresIncomeCache.set(scopeKey, futuresIncome);
    }
    const futuresMetrics = {
      walletBalance: safeDecimal(futuresAccount.totalWalletBalance),
      marginBalance: safeDecimal(futuresAccount.totalMarginBalance),
      availableBalance: safeDecimal(futuresAccount.availableBalance),
      initialMargin: safeDecimal(firstPresent(
        futuresAccount.totalInitialMargin,
        addDecimal(
          safeDecimal(futuresAccount.totalPositionInitialMargin),
          safeDecimal(futuresAccount.totalOpenOrderInitialMargin)
        )
      )),
      unrealizedProfit: safeDecimal(futuresAccount.totalUnrealizedProfit),
      realizedPnl24h: futuresIncome.realizedPnl24h,
      commission24h: futuresIncome.commission24h,
      fundingFee24h: futuresIncome.fundingFee24h,
      actualPnl24h: futuresIncome.actualPnl24h,
      openPositionCount: (Array.isArray(futuresAccount.positions)
        ? futuresAccount.positions
        : []).filter((position) =>
        compareDecimal(safeDecimal(position?.positionAmt), "0") !== 0
      ).length,
      realizedIncomeCount: futuresIncome.count,
      realizedIncomeUpdatedAt: futuresIncome.updatedAt,
    };

    return {
      environment,
      accountFingerprint,
      staticBalance: addDecimal(
        spotMetrics.totalBalanceUsdt,
        futuresMetrics.walletBalance
      ),
      balance: addDecimal(
        spotMetrics.totalBalanceUsdt,
        futuresMetrics.marginBalance
      ),
      available: addDecimal(
        spotMetrics.availableUsdt,
        futuresMetrics.availableBalance
      ),
      margin: addDecimal(
        spotMetrics.lockedUsdt,
        futuresMetrics.initialMargin
      ),
      positionProfit: addDecimal(
        spotMetrics.unrealizedProfit,
        futuresMetrics.unrealizedProfit
      ),
      closeProfit: addDecimal(
        spotMetrics.realizedPnl24h,
        futuresMetrics.realizedPnl24h
      ),
      commission: addDecimal(
        spotMetrics.commission24h,
        futuresMetrics.commission24h
      ),
      realProfit: addDecimal(
        spotMetrics.realizedPnl24h,
        futuresMetrics.actualPnl24h
      ),
      deviation: "0",
      openVolume:
        spotMetrics.openPositionCount + futuresMetrics.openPositionCount,
      orderVolume: Math.max(0, Math.floor(Number(openOrderCount) || 0)),
      currency: "USDT",
      rollingWindowMs: ROLLING_WINDOW_MS,
      updatedAt: now,
      source: "binance",
      complete: (
        (!hasSpot || spotResult.status === "fulfilled") &&
        (!hasSpot || tickerResult.status === "fulfilled") &&
        (!hasFutures || futuresResult.status === "fulfilled") &&
        (!hasFutures || incomeResult.status === "fulfilled" || hadCachedFuturesIncome)
      ),
      historyReconciled: shouldReconcileHistory,
      spot: spotMetrics,
      futures: futuresMetrics,
      warnings,
    };
  }

  close() {
    this.spotPnlStore.close();
  }
}

module.exports = {
  BinanceAccountMetricsService,
  ROLLING_WINDOW_MS,
  SpotPnlStore,
  buildTickerPriceMap,
  convertAssetToUsdt,
  inferSymbolAssets,
  normalizeSpotFill,
  summarizeSpotTradeHistory,
  summarizeFuturesIncome,
  sumDecimals,
  valueSpotBalances,
};
