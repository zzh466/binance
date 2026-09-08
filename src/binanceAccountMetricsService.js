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

const STORE_VERSION = 1;
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
    if (!fill || state.processedTrades[fill.key]) return null;
    const quoteUsdt = convertAssetToUsdt(
      fill.quoteAsset,
      fill.quoteQuantity,
      prices
    );
    if (quoteUsdt === null) return null;
    const commissionUsdt = fill.commissionAsset
      ? convertAssetToUsdt(fill.commissionAsset, fill.commission, prices)
      : "0";
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

  getStatus(scopeKey) {
    const state = this.getScope(scopeKey, { create: false });
    if (!state) return null;
    return {
      initializedAt: state.initializedAt,
      lastSyncedAt: state.lastSyncedAt,
      incompleteSellCount: state.incompleteSellCount,
      realizedTradeCount: state.realizedEvents.length,
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
  const unpricedAssets = [];
  for (const balance of Array.isArray(balances) ? balances : []) {
    const asset = String(balance?.asset || "").toUpperCase();
    const free = safeDecimal(balance?.free);
    const locked = safeDecimal(balance?.locked);
    const total = addDecimal(free, locked);
    if (!isPositiveDecimal(total)) continue;
    const totalValue = convertAssetToUsdt(asset, total, prices);
    const freeValue = convertAssetToUsdt(asset, free, prices);
    if (totalValue === null) {
      unpricedAssets.push(asset);
      continue;
    }
    totalBalanceUsdt = addDecimal(totalBalanceUsdt, totalValue);
    if (freeValue !== null) availableUsdt = addDecimal(availableUsdt, freeValue);
  }
  return { totalBalanceUsdt, availableUsdt, unpricedAssets };
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
    return {
      realizedPnl24h: this.spotPnlStore.getRollingRealizedPnl(scopeKey),
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
  }) {
    const now = this.now();
    const startTime = now - ROLLING_WINDOW_MS;
    const warnings = [];
    const hasSpot = Boolean(client?.spot?.apiKey && client?.spot?.apiSecret);
    const hasFutures = Boolean(client?.futures?.apiKey && client?.futures?.apiSecret);
    const spotAccountPromise = hasSpot
      ? client.spot.accountStatus({ omitZeroBalances: false })
      : Promise.reject(new Error("未配置现货凭证"));
    const tickerPromise = client?.spot?.tickerPrices
      ? client.spot.tickerPrices()
      : Promise.resolve([]);
    const futuresAccountPromise = hasFutures
      ? client.futures.accountStatus({ omitZeroBalances: false })
      : Promise.reject(new Error("未配置 U 本位凭证"));
    const futuresIncomePromise = hasFutures
      ? this.queryFuturesIncome(client, {
          incomeType: "REALIZED_PNL",
          startTime,
          endTime: now,
        })
      : Promise.reject(new Error("未配置 U 本位凭证"));
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
    if (incomeResult.status === "rejected") {
      warnings.push(serializeWarning("futures", "REALIZED_PNL", incomeResult.reason));
    }
    if (spotResult.status === "rejected" && futuresResult.status === "rejected") {
      throw spotResult.reason || futuresResult.reason;
    }

    const prices = buildTickerPriceMap(
      tickerResult.status === "fulfilled" ? tickerResult.value : []
    );
    const scopeKey = this.getScopeKey(environment, accountFingerprint);
    this.spotPriceMaps.set(scopeKey, prices);
    let spotMetrics = {
      totalBalanceUsdt: "0",
      availableUsdt: "0",
      realizedPnl24h: "0",
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
      } else if (symbols.length) {
        const ledgerStatus = this.spotPnlStore.getStatus(scopeKey);
        const syncStartTime = Math.max(
          startTime,
          Number(ledgerStatus?.lastSyncedAt || now) - 120_000
        );
        const symbolInfo = await this.loadSymbolInfo(client, symbols, warnings);
        const tradeResults = await Promise.allSettled(symbols.map((symbol) =>
          client.spot.myTrades({
            symbol,
            startTime: syncStartTime,
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
          this.spotPnlStore.recordFill(scopeKey, fill, prices);
        }
      }
      this.spotPnlStore.reconcileBalances(scopeKey, balances, prices);
      const valuation = valueSpotBalances(balances, prices);
      spotMetrics = {
        ...valuation,
        realizedPnl24h: this.spotPnlStore.getRollingRealizedPnl(scopeKey),
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
    let futuresRealizedPnl24h = "0";
    if (incomeResult.status === "fulfilled") {
      const unpricedIncomeAssets = new Set();
      for (const entry of incomeResult.value) {
        const asset = String(entry?.asset || "USDT").toUpperCase();
        const incomeUsdt = convertAssetToUsdt(asset, entry?.income, prices);
        if (incomeUsdt === null) {
          unpricedIncomeAssets.add(asset);
          continue;
        }
        futuresRealizedPnl24h = addDecimal(
          futuresRealizedPnl24h,
          incomeUsdt
        );
      }
      if (unpricedIncomeAssets.size) {
        warnings.push({
          marketType: "futures",
          operation: "REALIZED_PNL USDT valuation",
          name: "UnpricedIncomeWarning",
          message: `以下 U 本位收益资产缺少 USDT 折算路径：${[
            ...unpricedIncomeAssets,
          ].join(", ")}`,
        });
      }
    }
    const futuresMetrics = {
      walletBalance: safeDecimal(futuresAccount.totalWalletBalance),
      marginBalance: safeDecimal(futuresAccount.totalMarginBalance),
      availableBalance: safeDecimal(futuresAccount.availableBalance),
      unrealizedProfit: safeDecimal(futuresAccount.totalUnrealizedProfit),
      realizedPnl24h: futuresRealizedPnl24h,
      realizedIncomeCount:
        incomeResult.status === "fulfilled" ? incomeResult.value.length : 0,
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
      realProfit: addDecimal(
        spotMetrics.realizedPnl24h,
        futuresMetrics.realizedPnl24h
      ),
      positionProfit: futuresMetrics.unrealizedProfit,
      currency: "USDT",
      rollingWindowMs: ROLLING_WINDOW_MS,
      updatedAt: now,
      source: "binance",
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
  sumDecimals,
  valueSpotBalances,
};
