const { EventEmitter } = require("node:events");
const {
  BinanceSpotClient,
  BinanceApiError,
} = require("./binanceSpotClient");
const { BinanceUsdMClient } = require("./binanceUsdMClient");
const {
  addDecimal,
  compareDecimal,
  subtractDecimal,
} = require("./decimalMath");

const MARKET_SPOT = "spot";
const MARKET_FUTURES = "futures";
const MARKET_RESOLUTION_CACHE_TTL_MS = 300_000;
const MARKET_RESOLUTION_REFRESH_RETRY_MS = 30_000;
const RECENT_ORDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ACCOUNT_ORDER_QUERY_LIMIT = 1_000;
const GLOBAL_ALGO_DISCOVERY_TTL_MS = 300_000;
const CLOSE_ALL_DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const CLOSE_ALL_DEFAULT_CONCURRENCY = 4;
const CLOSE_ALL_RATE_LIMIT_BUFFER_MS = 100;
const RATE_LIMIT_INTERVAL_MS = {
  SECOND: 1_000,
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
};
const ROUTED_EVENTS = [
  "depth-update",
  "trade-update",
  "market-status",
  "market-error",
  "latency-update",
  "rate-limit-update",
  "order-state-update",
  "user-data-event",
  "user-data-status",
  "user-data-error",
];

function delay(milliseconds) {
  const timeout = Math.max(0, Number(milliseconds) || 0);
  if (!timeout) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

function normalizeOpenFuturesPosition(position) {
  const positionAmt = String(position?.positionAmt ?? "0").trim();
  let comparison;
  try {
    comparison = compareDecimal(positionAmt, "0");
  } catch {
    return null;
  }
  if (comparison === 0) return null;
  return {
    symbol: String(position?.symbol || "").toUpperCase(),
    positionAmt,
    quantity: comparison < 0
      ? subtractDecimal("0", positionAmt)
      : positionAmt.replace(/^\+/, ""),
    closeSide: comparison < 0 ? "BUY" : "SELL",
    entryPrice: String(position?.entryPrice ?? "0"),
    unrealizedProfit: String(position?.unrealizedProfit ?? "0"),
    positionSide: String(position?.positionSide || "BOTH").toUpperCase(),
  };
}

function listOpenFuturesPositions(account) {
  return (Array.isArray(account?.positions) ? account.positions : [])
    .map(normalizeOpenFuturesPosition)
    .filter((position) => position?.symbol);
}

function listNonUsdtSpotBalances(account) {
  return (Array.isArray(account?.balances) ? account.balances : []).flatMap(
    (balance) => {
      const asset = String(balance?.asset || "").toUpperCase();
      if (!asset || asset === "USDT") return [];
      const free = String(balance?.free ?? "0");
      const locked = String(balance?.locked ?? "0");
      let total;
      try {
        total = addDecimal(free, locked);
        if (compareDecimal(total, "0") <= 0) return [];
      } catch {
        return [];
      }
      return [{
        asset,
        symbol: `${asset}USDT`,
        free,
        locked,
        total,
      }];
    }
  );
}

class BinanceUnifiedClient extends EventEmitter {
  constructor({
    testnet = true,
    spotCredentials = {},
    futuresCredentials = {},
    depthSpeed,
    preflightBalanceCheck,
    publicMarketFetch,
    spotBrokerLinkId,
    futuresBrokerLinkId,
    expectedSpotTradeGroupId,
    expectedFuturesTradeGroupId,
    rateLimitCoordinator,
  } = {}) {
    super();
    this.testnet = Boolean(testnet);
    const common = {
      testnet: this.testnet,
      depthSpeed,
      preflightBalanceCheck,
      rateLimitCoordinator,
    };
    this.spot = new BinanceSpotClient({
      ...common,
      apiKey: spotCredentials.apiKey || "",
      apiSecret: spotCredentials.apiSecret || "",
      brokerLinkId: spotBrokerLinkId,
    });
    this.futures = new BinanceUsdMClient({
      ...common,
      apiKey: futuresCredentials.apiKey || "",
      apiSecret: futuresCredentials.apiSecret || "",
      brokerLinkId: futuresBrokerLinkId,
      publicMarketFetch,
    });
    this.spot.credentialsSource = spotCredentials.source || "";
    this.futures.credentialsSource = futuresCredentials.source || "";
    this.credentialsSource = this.spot.credentialsSource;
    this.expectedTradeGroupIds = {
      [MARKET_SPOT]: String(expectedSpotTradeGroupId ?? "").trim(),
      [MARKET_FUTURES]: String(expectedFuturesTradeGroupId ?? "").trim(),
    };
    this.activeMarketType = MARKET_SPOT;
    this.activeSymbol = null;
    this.marketResolutionCache = new Map();
    this.marketResolutionRefreshPromises = new Map();
    this.marketResolutionRefreshAttemptAt = new Map();
    this.futuresInitializationPromise = null;
    this.closeAllPositionsPromise = null;
    this.closeAllSpotPositionsPromise = null;
    this.closeAllFuturesPositionsPromise = null;
    this.closed = false;
    this.lastGlobalAlgoDiscoveryAt = 0;
    this.bindChildEvents(this.spot, MARKET_SPOT);
    this.bindChildEvents(this.futures, MARKET_FUTURES);
  }

  bindChildEvents(child, marketType) {
    for (const eventName of ROUTED_EVENTS) {
      child.on(eventName, (payload = {}) => {
        this.emit(eventName, { marketType, ...payload });
      });
    }
  }

  get restBase() {
    return this.spot.restBase;
  }

  get tradingRestBase() {
    return this.spot.tradingRestBase;
  }

  get wsBase() {
    return this.spot.wsBase;
  }

  get wsApiBase() {
    return this.spot.wsApiBase;
  }

  get tradingWsApiBase() {
    return this.spot.tradingWsApiBase;
  }

  get apiKey() {
    return this.spot.apiKey;
  }

  get apiSecret() {
    return this.spot.apiSecret;
  }

  get serverTimeOffsetMs() {
    return this.getActiveClient().serverTimeOffsetMs;
  }

  get tradingServerTimeOffsetMs() {
    return this.getActiveClient().tradingServerTimeOffsetMs;
  }

  get preflightBalanceCheck() {
    return this.spot.preflightBalanceCheck;
  }

  get depthSpeed() {
    return this.spot.depthSpeed;
  }

  get depthDisplayLevels() {
    return this.spot.depthDisplayLevels;
  }

  get depthStreamLevels() {
    return this.spot.depthStreamLevels;
  }

  get depthMode() {
    return this.spot.depthMode;
  }

  getActiveClient() {
    return this.activeMarketType === MARKET_FUTURES
      ? this.futures
      : this.spot;
  }

  getClient(marketType) {
    return marketType === MARKET_FUTURES ? this.futures : this.spot;
  }

  validateSymbol(symbol) {
    return this.spot.validateSymbol(symbol);
  }

  isInvalidSymbolError(error) {
    return Number(error?.code) === -1121 || /invalid symbol/i.test(error?.message || "");
  }

  isMissingSymbolError(error) {
    return Number(error?.code) === -1102 && /symbol/i.test(
      `${error?.message || ""} ${error?.data?.msg || ""}`
    );
  }

  hasTradingCredentials(marketClient) {
    return Boolean(marketClient.apiKey && marketClient.apiSecret);
  }

  collectKnownSymbols(marketType, suppliedSymbols = []) {
    const symbols = new Set();
    const addSymbol = (symbol) => {
      if (!symbol) return;
      try {
        symbols.add(this.validateSymbol(symbol));
      } catch {
        // 忽略已失效的本地合约记录，避免一次坏数据阻塞整个账户同步。
      }
    };

    for (const symbol of suppliedSymbols) addSymbol(symbol);
    if (this.activeMarketType === marketType) addSymbol(this.activeSymbol);
    for (const resolution of this.marketResolutionCache.values()) {
      if (resolution?.marketType === marketType) addSymbol(resolution.symbol);
    }
    return symbols;
  }

  serializeAccountSyncError(error, details = {}) {
    return {
      ...details,
      name: error?.name || "Error",
      message: error?.message || "未知错误",
      status: error?.status,
      code: error?.code,
    };
  }

  async queryCompleteOrderWindow({
    fetchPage,
    startTime,
    endTime,
    limit,
    warningContext,
    warnings,
    depth = 0,
  }) {
    const page = await fetchPage({ startTime, endTime, limit });
    if (page.length < limit) return page;

    // Binance 的 allOrders 只返回至多 1000 条。按时间区间二分，而不是
    // 假定跨 symbol 的 orderId 全局连续；这样同样适用于全合约查询。
    if (depth >= 20 || endTime - startTime <= 1) {
      warnings.push({
        ...warningContext,
        name: "ResultLimitWarning",
        message:
          `${warningContext.symbol ? `${warningContext.symbol} ` : ""}` +
          `在 ${startTime}-${endTime} 仍达到 ${limit} 条上限，极短区间可能被截断。`,
      });
      return page;
    }

    const middle = Math.floor((startTime + endTime) / 2);
    const left = await this.queryCompleteOrderWindow({
      fetchPage,
      startTime,
      endTime: middle,
      limit,
      warningContext,
      warnings,
      depth: depth + 1,
    });
    const right = await this.queryCompleteOrderWindow({
      fetchPage,
      startTime: middle + 1,
      endTime,
      limit,
      warningContext,
      warnings,
      depth: depth + 1,
    });
    return [...left, ...right];
  }

  async mapSettledWithConcurrency(items, mapper, concurrency = 4) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          try {
            results[index] = {
              status: "fulfilled",
              value: await mapper(items[index], index),
            };
          } catch (reason) {
            results[index] = { status: "rejected", reason };
          }
        }
      }
    );
    await Promise.all(workers);
    return results;
  }

  async initialize() {
    const result = await this.spot.initialize();
    if (this.futures.apiKey && this.futures.apiSecret) {
      this.initializeFuturesInBackground();
    }
    return result;
  }

  initializeFuturesInBackground() {
    if (this.futuresInitializationPromise) return this.futuresInitializationPromise;
    this.futuresInitializationPromise = this.futures.initialize().catch((error) => {
      this.emit("market-error", {
        marketType: MARKET_FUTURES,
        message: `永续服务器时间同步失败：${error.message}`,
        time: Date.now(),
      });
      this.futuresInitializationPromise = null;
      return null;
    });
    return this.futuresInitializationPromise;
  }

  async resolveMarket(symbol, { forceRefresh = false, marketType } = {}) {
    const normalizedSymbol = this.validateSymbol(symbol);
    if (marketType && ![MARKET_SPOT, MARKET_FUTURES].includes(marketType)) {
      throw new BinanceApiError(`未知的 Binance 市场类型：${marketType}`);
    }
    const cacheKey = `${marketType || "auto"}:${normalizedSymbol}`;
    const cached = this.marketResolutionCache.get(cacheKey);
    if (!forceRefresh && cached) {
      if (
        Date.now() - cached.resolvedAt >= MARKET_RESOLUTION_CACHE_TTL_MS
      ) {
        this.refreshMarketResolutionInBackground(
          normalizedSymbol,
          marketType,
          cacheKey
        );
      }
      return cached;
    }

    if (marketType) {
      const client = this.getClient(marketType);
      const exchangeInfo = await client.exchangeInfo(normalizedSymbol, {
        forceRefresh,
      });
      const resolution = {
        symbol: normalizedSymbol,
        marketType,
        client,
        exchangeInfo,
        resolvedAt: Date.now(),
      };
      this.marketResolutionCache.set(cacheKey, resolution);
      return resolution;
    }

    let spotError;
    try {
      const exchangeInfo = await this.spot.exchangeInfo(normalizedSymbol, {
        forceRefresh,
      });
      const resolution = {
        symbol: normalizedSymbol,
        marketType: MARKET_SPOT,
        client: this.spot,
        exchangeInfo,
        resolvedAt: Date.now(),
      };
      this.marketResolutionCache.set(cacheKey, resolution);
      this.marketResolutionCache.set(`${MARKET_SPOT}:${normalizedSymbol}`, resolution);
      return resolution;
    } catch (error) {
      spotError = error;
      if (!this.isInvalidSymbolError(error)) throw error;
    }

    try {
      const exchangeInfo = await this.futures.exchangeInfo(normalizedSymbol, {
        forceRefresh,
      });
      const resolution = {
        symbol: normalizedSymbol,
        marketType: MARKET_FUTURES,
        client: this.futures,
        exchangeInfo,
        resolvedAt: Date.now(),
      };
      this.marketResolutionCache.set(cacheKey, resolution);
      this.marketResolutionCache.set(`${MARKET_FUTURES}:${normalizedSymbol}`, resolution);
      return resolution;
    } catch (futuresError) {
      if (!this.isInvalidSymbolError(futuresError)) throw futuresError;
      throw new BinanceApiError(
        `${normalizedSymbol} 在当前环境的现货和 U 本位永续市场中都不存在。`,
        {
          status: 400,
          code: -1121,
          data: {
            code: -1121,
            msg: "Invalid symbol.",
            spot: spotError?.data || spotError?.message,
            futures: futuresError?.data || futuresError?.message,
          },
        }
      );
    }
  }

  refreshMarketResolutionInBackground(symbol, marketType, cacheKey) {
    const pending = this.marketResolutionRefreshPromises.get(cacheKey);
    if (pending) return pending;
    const lastAttemptAt = this.marketResolutionRefreshAttemptAt.get(cacheKey) || 0;
    if (Date.now() - lastAttemptAt < MARKET_RESOLUTION_REFRESH_RETRY_MS) {
      return null;
    }

    this.marketResolutionRefreshAttemptAt.set(cacheKey, Date.now());
    const promise = this.resolveMarket(symbol, {
      forceRefresh: true,
      marketType,
    });
    this.marketResolutionRefreshPromises.set(cacheKey, promise);
    promise.catch((error) => {
      this.emit("market-error", {
        marketType,
        symbol,
        message: `市场类型后台刷新失败：${error.message}`,
        time: Date.now(),
      });
    }).finally(() => {
      if (this.marketResolutionRefreshPromises.get(cacheKey) === promise) {
        this.marketResolutionRefreshPromises.delete(cacheKey);
      }
    });
    return promise;
  }

  addMarketType(data, marketType) {
    if (Array.isArray(data)) {
      return data.map((item) =>
        item && typeof item === "object" ? { marketType, ...item } : item
      );
    }
    if (data && typeof data === "object") {
      return { marketType, ...data };
    }
    return data;
  }

  async route(symbol, action, options = {}) {
    const resolution = await this.resolveMarket(symbol, options);
    const data = await action(resolution.client, resolution);
    return this.addMarketType(data, resolution.marketType);
  }

  async syncServerTime(symbol = this.activeSymbol) {
    if (!symbol) return this.getActiveClient().syncServerTime();
    return this.route(symbol, (client) => client.syncServerTime());
  }

  async ping(symbol = this.activeSymbol) {
    if (!symbol) return this.getActiveClient().ping();
    return this.route(symbol, (client) => client.ping());
  }

  async exchangeInfo(symbol, { forceRefresh = false } = {}) {
    const resolution = await this.resolveMarket(symbol, { forceRefresh });
    return this.addMarketType(resolution.exchangeInfo, resolution.marketType);
  }

  async marketOverview(symbol, options = {}) {
    return this.route(
      symbol,
      (client) => client.marketOverview(symbol, options),
      options
    );
  }

  async connectDepth(symbol) {
    const resolution = await this.resolveMarket(symbol);
    this.spot.disconnectMarket();
    this.futures.disconnectMarket();
    this.activeMarketType = resolution.marketType;
    this.activeSymbol = resolution.symbol;
    if (resolution.marketType === MARKET_FUTURES) {
      this.initializeFuturesInBackground();
    }
    const result = await resolution.client.connectDepth(resolution.symbol);

    if (
      resolution.marketType === MARKET_FUTURES &&
      resolution.client.apiKey &&
      resolution.client.apiSecret
    ) {
      resolution.client.connectUserData().catch((error) => {
        this.emit("user-data-error", {
          marketType: resolution.marketType,
          message: error.message,
          time: Date.now(),
        });
      });
    }
    return this.addMarketType(result, resolution.marketType);
  }

  disconnectMarket() {
    this.spot.disconnectMarket();
    this.futures.disconnectMarket();
    this.activeSymbol = null;
  }

  async placeOrder(order, options) {
    return this.route(
      order.symbol,
      (client) => client.placeOrder(order, options),
      order
    );
  }

  async cancelOrder(order) {
    return this.route(order.symbol, (client) => client.cancelOrder(order), order);
  }

  async queryOrder(options) {
    return this.route(
      options.symbol,
      (client) => client.queryOrder(options),
      options
    );
  }

  async openOrders(options = {}) {
    if (options.symbol) {
      return this.route(
        options.symbol,
        (client) => client.openOrders(options),
        options
      );
    }

    const candidates = [this.spot, this.futures].filter(
      (client) => client.apiKey && client.apiSecret
    );
    if (!candidates.length) this.spot.assertTradingCredentials();
    const results = await Promise.allSettled(
      candidates.map((client) => client.openOrders({}))
    );
    const orders = [];
    let firstError = null;
    for (const [index, result] of results.entries()) {
      const client = candidates[index];
      if (result.status === "fulfilled") {
        orders.push(...this.addMarketType(result.value, client.marketType));
      } else {
        firstError ||= result.reason;
      }
    }
    if (!orders.length && firstError && results.every((result) => result.status === "rejected")) {
      throw firstError;
    }
    return orders;
  }

  async cancelAllOpenOrders(options) {
    return this.route(
      options.symbol,
      (client) => client.cancelAllOpenOrders(options),
      options
    );
  }

  createCloseAllContext({
    marketType,
    maxDurationMs = CLOSE_ALL_DEFAULT_TIMEOUT_MS,
    concurrency = CLOSE_ALL_DEFAULT_CONCURRENCY,
    waitFn = delay,
  } = {}) {
    const startedAt = Date.now();
    return {
      marketType,
      startedAt,
      deadlineAt: startedAt + Math.max(1_000, Number(maxDurationMs) || 0),
      concurrency: Math.max(1, Math.min(8, Math.floor(Number(concurrency) || 1))),
      waitFn: typeof waitFn === "function" ? waitFn : delay,
      waitedMs: 0,
      rateLimitWaitCount: 0,
    };
  }

  emitCloseAllProgress(context, details = {}) {
    this.emit("close-all-progress", {
      marketType: context.marketType,
      waitedMs: context.waitedMs,
      rateLimitWaitCount: context.rateLimitWaitCount,
      startedAt: context.startedAt,
      time: Date.now(),
      ...details,
    });
  }

  assertCloseAllCanContinue(context) {
    if (this.closed) {
      const error = new BinanceApiError(
        "客户端已关闭或环境已切换，一键平仓任务已停止。"
      );
      error.name = "CloseAllPositionsStoppedError";
      throw error;
    }
    if (Date.now() >= context.deadlineAt) {
      const error = new BinanceApiError(
        "一键平仓等待 Binance 限流恢复的时间过长，任务已安全停止；请重新确认持仓后再次执行。",
        {
          data: {
            marketType: context.marketType,
            startedAt: context.startedAt,
            deadlineAt: context.deadlineAt,
            waitedMs: context.waitedMs,
          },
        }
      );
      error.name = "CloseAllPositionsTimeoutError";
      throw error;
    }
  }

  getCloseAllRateLimitWaitMs(context, {
    errors = [],
    proactive = false,
    upcomingCount = 1,
  } = {}) {
    const now = Date.now();
    const coordinator = this.spot.rateLimitCoordinator;
    const snapshot = coordinator?.snapshot?.() || {};
    const candidates = [];
    const marketBanUntil = Number(
      snapshot.marketBans?.[context.marketType]
    );
    if (Number.isFinite(marketBanUntil) && marketBanUntil > now) {
      candidates.push(marketBanUntil);
    }
    const globalBanUntil = Number(snapshot.globalBanUntil);
    if (Number.isFinite(globalBanUntil) && globalBanUntil > now) {
      candidates.push(globalBanUntil);
    }

    for (const error of errors) {
      const banUntil = Number(error?.data?.banUntil);
      if (Number.isFinite(banUntil) && banUntil > now) {
        candidates.push(banUntil);
      }
    }

    if (proactive) {
      for (const limit of snapshot.limits || []) {
        if (
          limit.marketType &&
          String(limit.marketType).toLowerCase() !== context.marketType
        ) {
          continue;
        }
        if (!limit.active || !Number(limit.limit)) continue;
        const type = String(limit.rateLimitType || "").toUpperCase();
        const countAfterBatch = Number(limit.count || 0) + upcomingCount;
        const shouldPause = type === "ORDERS"
          ? countAfterBatch / Number(limit.limit) >= 0.9
          : type === "REQUEST_WEIGHT"
            ? countAfterBatch / Number(limit.limit) >= 0.97
            : false;
        if (!shouldPause) continue;
        const intervalMs =
          (RATE_LIMIT_INTERVAL_MS[String(limit.interval).toUpperCase()] || 0) *
          (Number(limit.intervalNum) || 1);
        if (intervalMs > 0) {
          candidates.push(Number(limit.observedAt) + intervalMs);
        }
      }
    }

    const waitUntil = Math.max(now, ...candidates.filter(Number.isFinite));
    return waitUntil > now
      ? waitUntil - now + CLOSE_ALL_RATE_LIMIT_BUFFER_MS
      : 0;
  }

  isRetryableCloseAllRateLimit(error) {
    if (error?.data?.executionStatus === "UNKNOWN") return false;
    if (error?.data?.orderAttempt?.status === "UNKNOWN") return false;
    return Number(error?.status) === 429 ||
      (Number(error?.code) === -1003 && error?.data?.localRateLimitGuard === true);
  }

  async waitForCloseAllRateLimit(context, waitMs, details = {}) {
    if (!(waitMs > 0)) return;
    this.assertCloseAllCanContinue(context);
    const remainingMs = context.deadlineAt - Date.now();
    if (waitMs >= remainingMs) {
      this.assertCloseAllCanContinue({ ...context, deadlineAt: Date.now() });
    }
    context.waitedMs += waitMs;
    context.rateLimitWaitCount += 1;
    this.emitCloseAllProgress(context, {
      stage: "rate-limit-wait",
      message: `Binance ${context.marketType === MARKET_SPOT ? "现货" : "U 本位"}接口接近或触发限流，` +
        `将在 ${(waitMs / 1_000).toFixed(1)} 秒后自动继续。`,
      retryAt: Date.now() + waitMs,
      ...details,
    });
    await context.waitFn(waitMs);
    this.assertCloseAllCanContinue(context);
  }

  async runCloseAllOperation(context, action, { stage } = {}) {
    for (;;) {
      this.assertCloseAllCanContinue(context);
      const activeBanWaitMs = this.getCloseAllRateLimitWaitMs(context);
      if (activeBanWaitMs > 0) {
        await this.waitForCloseAllRateLimit(context, activeBanWaitMs, { stage });
      }
      try {
        return await action();
      } catch (error) {
        if (!this.isRetryableCloseAllRateLimit(error)) throw error;
        const waitMs = Math.max(
          1_000,
          this.getCloseAllRateLimitWaitMs(context, { errors: [error] })
        );
        await this.waitForCloseAllRateLimit(context, waitMs, {
          stage,
          lastError: this.serializeAccountSyncError(error),
        });
      }
    }
  }

  async runCloseAllQueue(context, items, worker, { stage } = {}) {
    const pending = items.map((item, index) => ({ item, index }));
    const results = Array(items.length);
    let completed = 0;
    while (pending.length) {
      this.assertCloseAllCanContinue(context);
      const batchSize = Math.min(context.concurrency, pending.length);
      const proactiveWaitMs = this.getCloseAllRateLimitWaitMs(context, {
        proactive: true,
        upcomingCount: batchSize,
      });
      if (proactiveWaitMs > 0) {
        await this.waitForCloseAllRateLimit(context, proactiveWaitMs, {
          stage,
          completed,
          pending: pending.length,
          total: items.length,
        });
      }

      const batch = pending.splice(0, batchSize);
      const settlements = await Promise.allSettled(
        batch.map(({ item }) => worker(item))
      );
      const retryItems = [];
      const rateLimitErrors = [];
      settlements.forEach((settlement, batchIndex) => {
        const entry = batch[batchIndex];
        if (settlement.status === "rejected" &&
            this.isRetryableCloseAllRateLimit(settlement.reason)) {
          retryItems.push(entry);
          rateLimitErrors.push(settlement.reason);
          return;
        }
        results[entry.index] = settlement;
        completed += 1;
      });
      pending.unshift(...retryItems);
      this.emitCloseAllProgress(context, {
        stage,
        completed,
        pending: pending.length,
        total: items.length,
        message: `${stage || "清仓"}：已完成 ${completed}/${items.length}，剩余 ${pending.length}。`,
      });
      if (retryItems.length) {
        const waitMs = Math.max(
          1_000,
          this.getCloseAllRateLimitWaitMs(context, {
            errors: rateLimitErrors,
            proactive: true,
            upcomingCount: Math.min(context.concurrency, pending.length),
          })
        );
        await this.waitForCloseAllRateLimit(context, waitMs, {
          stage,
          completed,
          pending: pending.length,
          total: items.length,
          lastError: this.serializeAccountSyncError(rateLimitErrors[0]),
        });
      }
    }
    return results;
  }

  classifySpotAssetsForLiquidation(assets, symbolCatalog) {
    const symbols = new Map(
      (Array.isArray(symbolCatalog) ? symbolCatalog : []).map((symbol) => [
        String(symbol?.symbol || "").toUpperCase(),
        symbol,
      ])
    );
    const sellableAssets = [];
    const nonTradableAssets = [];
    const lockedAssets = [];
    for (const asset of assets) {
      if (compareDecimal(asset.locked, "0") > 0) lockedAssets.push(asset);
      if (compareDecimal(asset.free, "0") <= 0) continue;
      const symbolInfo = symbols.get(asset.symbol);
      if (
        !symbolInfo ||
        String(symbolInfo.status || "").toUpperCase() !== "TRADING" ||
        String(symbolInfo.baseAsset || "").toUpperCase() !== asset.asset ||
        String(symbolInfo.quoteAsset || "").toUpperCase() !== "USDT"
      ) {
        nonTradableAssets.push({
          ...asset,
          reason: symbolInfo
            ? `${asset.symbol} 当前不可交易`
            : `不存在可直接卖出的 ${asset.symbol} 交易对`,
        });
        continue;
      }
      sellableAssets.push(asset);
    }
    return { sellableAssets, nonTradableAssets, lockedAssets };
  }

  isSpotDustFailure(error) {
    const message = String(error?.message || "");
    return Number(error?.code) === -1013 &&
      /NOTIONAL|LOT_SIZE|quantity|最小值|订单金额/i.test(message);
  }

  async closeAllPositions() {
    if (this.closeAllPositionsPromise) return this.closeAllPositionsPromise;

    const operation = this.performCloseAllPositions().finally(() => {
      if (this.closeAllPositionsPromise === operation) {
        this.closeAllPositionsPromise = null;
      }
    });
    this.closeAllPositionsPromise = operation;
    return operation;
  }

  async performCloseAllPositions() {
    const [spotSettlement, futuresSettlement] = await Promise.allSettled([
      this.closeAllSpotPositions(),
      this.closeAllFuturesPositions(),
    ]);
    const toMarketResult = (settlement, marketType) => {
      if (settlement.status === "fulfilled") return settlement.value;
      return {
        marketType,
        verifiedFlat: false,
        error: this.serializeAccountSyncError(settlement.reason),
        orders: [],
      };
    };
    const spot = toMarketResult(spotSettlement, MARKET_SPOT);
    const futures = toMarketResult(futuresSettlement, MARKET_FUTURES);
    const remainingSpotAssets = spot.remainingAssets || [];
    const remainingFuturesPositions = futures.remainingPositions || [];
    const remainingOpenOrders = [
      ...(spot.remainingOpenOrders || []).map((order) => ({
        ...order,
        marketType: MARKET_SPOT,
      })),
      ...(futures.remainingOpenOrders || []).map((order) => ({
        ...order,
        marketType: MARKET_FUTURES,
      })),
    ];

    return {
      verifiedFlat: spot.verifiedFlat === true && futures.verifiedFlat === true,
      markets: { spot, futures },
      remainingSpotAssets,
      remainingFuturesPositions,
      remainingPositions: remainingFuturesPositions,
      remainingOpenOrders,
      orders: [...(spot.orders || []), ...(futures.orders || [])],
      completedAt: Date.now(),
    };
  }

  async closeAllSpotPositions({
    verificationDelays = [0, 150, 400, 1_000, 2_000],
    maxDurationMs = CLOSE_ALL_DEFAULT_TIMEOUT_MS,
    concurrency = CLOSE_ALL_DEFAULT_CONCURRENCY,
    waitFn = delay,
  } = {}) {
    if (this.closeAllSpotPositionsPromise) {
      return this.closeAllSpotPositionsPromise;
    }
    const context = this.createCloseAllContext({
      marketType: MARKET_SPOT,
      maxDurationMs,
      concurrency,
      waitFn,
    });
    const operation = this.performCloseAllSpotPositions({
      verificationDelays,
      context,
    }).finally(() => {
      if (this.closeAllSpotPositionsPromise === operation) {
        this.closeAllSpotPositionsPromise = null;
      }
    });
    this.closeAllSpotPositionsPromise = operation;
    return operation;
  }

  async performCloseAllSpotPositions({ verificationDelays, context }) {
    this.spot.assertTradingCredentials();
    this.emitCloseAllProgress(context, {
      stage: "spot-preflight",
      message: "正在读取现货账户、挂单和可交易的 USDT 交易对。",
    });
    const [initialAccount, initialOpenOrders, symbolCatalog] = await Promise.all([
      this.runCloseAllOperation(
        context,
        () => this.spot.accountStatus({
          omitZeroBalances: false,
          critical: true,
        }),
        { stage: "spot-account" }
      ),
      this.runCloseAllOperation(
        context,
        () => this.spot.openOrders({ critical: true }),
        { stage: "spot-open-orders" }
      ),
      this.runCloseAllOperation(
        context,
        () => this.spot.exchangeInfoCatalog({ critical: true }),
        { stage: "spot-exchange-info" }
      ),
    ]);
    const initialAssets = listNonUsdtSpotBalances(initialAccount);
    const openOrderSymbols = [...new Set(initialOpenOrders
      .map((order) => String(order?.symbol || "").toUpperCase())
      .filter(Boolean))].sort();
    const cancelSettlements = await this.runCloseAllQueue(
      context,
      openOrderSymbols,
      (symbol) => this.spot.cancelAllOpenOrders({ symbol }),
      { stage: "spot-cancel-orders" }
    );
    const cancellations = cancelSettlements.map((settlement, index) => {
      const symbol = openOrderSymbols[index];
      if (settlement.status === "fulfilled") {
        const canceledOrders = this.addMarketType(
          Array.isArray(settlement.value) ? settlement.value : [],
          MARKET_SPOT
        );
        return {
          symbol,
          ok: true,
          canceledOrders,
          canceledOrderCount: canceledOrders.length,
        };
      }
      return {
        symbol,
        ok: false,
        error: this.serializeAccountSyncError(settlement.reason),
      };
    });

    let preSellAccount = initialAccount;
    let preSellRefreshError = null;
    try {
      preSellAccount = await this.runCloseAllOperation(
        context,
        () => this.spot.accountStatus({
          omitZeroBalances: false,
          critical: true,
        }),
        { stage: "spot-refresh-balance" }
      );
    } catch (error) {
      preSellRefreshError = this.serializeAccountSyncError(error);
    }
    const assetsToSell = listNonUsdtSpotBalances(preSellAccount);
    const {
      sellableAssets,
      nonTradableAssets,
      lockedAssets,
    } = this.classifySpotAssetsForLiquidation(assetsToSell, symbolCatalog);
    this.emitCloseAllProgress(context, {
      stage: "spot-sell-assets",
      total: sellableAssets.length,
      pending: sellableAssets.length,
      nonTradableCount: nonTradableAssets.length,
      lockedCount: lockedAssets.length,
      message: `准备卖出 ${sellableAssets.length} 项现货资产；` +
        `${nonTradableAssets.length} 项没有可直接卖出的 USDT 交易对，` +
        `${lockedAssets.length} 项包含锁定余额。`,
    });
    const sellSettlements = await this.runCloseAllQueue(
      context,
      sellableAssets,
      async (asset) => this.addMarketType(await this.spot.placeOrder({
        symbol: asset.symbol,
        side: "SELL",
        type: "MARKET",
        quantity: asset.free,
        newOrderRespType: "ACK",
      }), MARKET_SPOT),
      { stage: "spot-sell-assets" }
    );
    const sellAttempts = sellSettlements.map((settlement, index) => {
      const asset = sellableAssets[index];
      if (settlement.status === "fulfilled") {
        return { ...asset, ok: true, order: settlement.value };
      }
      return {
        ...asset,
        ok: false,
        error: this.serializeAccountSyncError(settlement.reason),
      };
    });
    const dustAssets = sellAttempts.filter(
      (attempt) => !attempt.ok && this.isSpotDustFailure(attempt.error)
    );

    const normalizedVerificationDelays = (
      Array.isArray(verificationDelays) && verificationDelays.length
        ? verificationDelays
        : [0]
    ).map((value) => Math.max(0, Number(value) || 0));
    let assetsVerified = false;
    let assetFlatConfirmations = 0;
    let remainingAssets = assetsToSell;
    const verificationErrors = [];
    for (const waitMs of normalizedVerificationDelays) {
      await context.waitFn(waitMs);
      try {
        const account = await this.runCloseAllOperation(
          context,
          () => this.spot.accountStatus({
            omitZeroBalances: false,
            critical: true,
          }),
          { stage: "spot-verify-balance" }
        );
        assetsVerified = true;
        remainingAssets = listNonUsdtSpotBalances(account);
        if (remainingAssets.length) {
          assetFlatConfirmations = 0;
        } else {
          assetFlatConfirmations += 1;
          if (assetFlatConfirmations >= 2) break;
        }
      } catch (error) {
        verificationErrors.push(this.serializeAccountSyncError(error));
      }
    }

    let openOrdersVerified = false;
    let remainingOpenOrders = initialOpenOrders;
    let openOrdersVerificationError = null;
    try {
      remainingOpenOrders = await this.runCloseAllOperation(
        context,
        () => this.spot.openOrders({ critical: true }),
        { stage: "spot-verify-open-orders" }
      );
      openOrdersVerified = true;
    } catch (error) {
      openOrdersVerificationError = this.serializeAccountSyncError(error);
    }
    const canceledOrders = cancellations.flatMap((item) =>
      item.ok ? item.canceledOrders : []
    );
    const sellOrders = sellAttempts.flatMap((item) =>
      item.ok && item.order ? [item.order] : []
    );
    const verifiedFlat = assetsVerified && assetFlatConfirmations >= 2 &&
      openOrdersVerified && remainingAssets.length === 0 &&
      remainingOpenOrders.length === 0;

    return {
      marketType: MARKET_SPOT,
      verifiedFlat,
      assetsVerified,
      assetFlatConfirmations,
      openOrdersVerified,
      initialAssets,
      assetsToSell,
      initialOpenOrderCount: initialOpenOrders.length,
      cancellations,
      sellAttempts,
      nonTradableAssets,
      lockedAssets,
      dustAssets,
      remainingAssets,
      remainingOpenOrders,
      preSellRefreshError,
      verificationErrors,
      openOrdersVerificationError,
      orders: [...canceledOrders, ...sellOrders],
      waitedMs: context.waitedMs,
      rateLimitWaitCount: context.rateLimitWaitCount,
      completedAt: Date.now(),
    };
  }

  async closeAllFuturesPositions({
    verificationDelays = [0, 150, 400, 1_000, 2_000],
    maxDurationMs = CLOSE_ALL_DEFAULT_TIMEOUT_MS,
    concurrency = CLOSE_ALL_DEFAULT_CONCURRENCY,
    waitFn = delay,
  } = {}) {
    if (this.closeAllFuturesPositionsPromise) {
      return this.closeAllFuturesPositionsPromise;
    }

    const context = this.createCloseAllContext({
      marketType: MARKET_FUTURES,
      maxDurationMs,
      concurrency,
      waitFn,
    });
    const operation = this.performCloseAllFuturesPositions({
      verificationDelays,
      context,
    }).finally(() => {
      if (this.closeAllFuturesPositionsPromise === operation) {
        this.closeAllFuturesPositionsPromise = null;
      }
    });
    this.closeAllFuturesPositionsPromise = operation;
    return operation;
  }

  async performCloseAllFuturesPositions({ verificationDelays, context }) {
    this.futures.assertTradingCredentials();
    this.emitCloseAllProgress(context, {
      stage: "futures-preflight",
      message: "正在读取并复核 U 本位持仓、普通挂单和条件单。",
    });

    // 必须先完整读到持仓和挂单。无法确认挂单时贸然平仓，残留订单稍后成交
    // 可能再次建立持仓，因此这里选择明确失败而不是给出虚假的“已平仓”。
    const [initialAccount, initialOpenOrders] = await Promise.all([
      this.runCloseAllOperation(
        context,
        () => this.futures.accountStatus({
          omitZeroBalances: false,
          critical: true,
        }),
        { stage: "futures-account" }
      ),
      this.runCloseAllOperation(
        context,
        () => this.futures.openOrders({ critical: true }),
        { stage: "futures-open-orders" }
      ),
    ]);
    const initialPositions = listOpenFuturesPositions(initialAccount);
    const symbols = [...new Set([
      ...initialPositions.map(({ symbol }) => symbol),
      ...initialOpenOrders.map((order) => String(order?.symbol || "").toUpperCase()),
    ].filter(Boolean))].sort();

    const cancelSettlements = await this.runCloseAllQueue(
      context,
      symbols,
      (symbol) => this.futures.cancelAllOpenOrders({ symbol }),
      { stage: "futures-cancel-orders" }
    );
    const cancellations = cancelSettlements.map((settlement, index) => {
      const symbol = symbols[index];
      if (settlement.status === "fulfilled") {
        return {
          symbol,
          ok: true,
          canceledOrders: settlement.value,
          canceledOrderCount: Array.isArray(settlement.value)
            ? settlement.value.length
            : 0,
        };
      }
      return {
        symbol,
        ok: false,
        error: this.serializeAccountSyncError(settlement.reason),
      };
    });

    let preCloseAccount = initialAccount;
    let preCloseRefreshError = null;
    try {
      preCloseAccount = await this.runCloseAllOperation(
        context,
        () => this.futures.accountStatus({
          omitZeroBalances: false,
          critical: true,
        }),
        { stage: "futures-refresh-position" }
      );
    } catch (error) {
      // 仍使用操作开始时刚从 Binance 取得的持仓快照执行 reduceOnly 平仓；
      // 最终复核无法通过时整体结果会明确标记为失败。
      preCloseRefreshError = this.serializeAccountSyncError(error);
    }
    const positionsToClose = listOpenFuturesPositions(preCloseAccount);
    const closeSettlements = await this.runCloseAllQueue(
      context,
      positionsToClose,
      (position) => this.futures.placeOrder({
        symbol: position.symbol,
        side: position.closeSide,
        positionSide: "BOTH",
        positionEffect: "CLOSE",
        reduceOnly: true,
        type: "MARKET",
        quantity: position.quantity,
        newOrderRespType: "ACK",
      }),
      { stage: "futures-close-positions" }
    );
    const closeAttempts = closeSettlements.map((settlement, index) => {
      const position = positionsToClose[index];
      if (settlement.status === "fulfilled") {
        return { ...position, ok: true, order: settlement.value };
      }
      return {
        ...position,
        ok: false,
        error: this.serializeAccountSyncError(settlement.reason),
      };
    });

    const normalizedVerificationDelays = (
      Array.isArray(verificationDelays) && verificationDelays.length
        ? verificationDelays
        : [0]
    ).map((value) => Math.max(0, Number(value) || 0));
    let positionsVerified = false;
    let remainingPositions = positionsToClose;
    let positionFlatConfirmations = 0;
    const verificationErrors = [];
    for (const waitMs of normalizedVerificationDelays) {
      await context.waitFn(waitMs);
      try {
        const account = await this.runCloseAllOperation(
          context,
          () => this.futures.accountStatus({
            omitZeroBalances: false,
            critical: true,
          }),
          { stage: "futures-verify-position" }
        );
        positionsVerified = true;
        remainingPositions = listOpenFuturesPositions(account);
        if (remainingPositions.length) {
          positionFlatConfirmations = 0;
        } else {
          positionFlatConfirmations += 1;
          if (positionFlatConfirmations >= 2) break;
        }
      } catch (error) {
        verificationErrors.push(this.serializeAccountSyncError(error));
      }
    }

    let openOrdersVerified = false;
    let remainingOpenOrders = initialOpenOrders;
    let openOrdersVerificationError = null;
    try {
      remainingOpenOrders = await this.runCloseAllOperation(
        context,
        () => this.futures.openOrders({ critical: true }),
        { stage: "futures-verify-open-orders" }
      );
      openOrdersVerified = true;
    } catch (error) {
      openOrdersVerificationError = this.serializeAccountSyncError(error);
    }

    const canceledOrders = cancellations.flatMap((item) =>
      item.ok && Array.isArray(item.canceledOrders) ? item.canceledOrders : []
    );
    const closeOrders = closeAttempts.flatMap((item) =>
      item.ok && item.order ? [item.order] : []
    );
    const verifiedFlat = positionsVerified && positionFlatConfirmations >= 2 &&
      openOrdersVerified &&
      remainingPositions.length === 0 && remainingOpenOrders.length === 0;

    return {
      marketType: MARKET_FUTURES,
      verifiedFlat,
      positionsVerified,
      positionFlatConfirmations,
      openOrdersVerified,
      initialPositions,
      positionsToClose,
      initialOpenOrderCount: initialOpenOrders.length,
      cancellations,
      closeAttempts,
      remainingPositions,
      remainingOpenOrders,
      preCloseRefreshError,
      verificationErrors,
      openOrdersVerificationError,
      // 供主进程统一订单状态仓库消费，撤单和 ACK 平仓单都会被记录。
      orders: [...canceledOrders, ...closeOrders],
      waitedMs: context.waitedMs,
      rateLimitWaitCount: context.rateLimitWaitCount,
      completedAt: Date.now(),
    };
  }

  async amendOrder(options) {
    return this.route(
      options.symbol,
      (client) => client.amendOrder(options),
      options
    );
  }

  async cancelReplace(options) {
    return this.route(
      options.symbol,
      (client) => client.cancelReplace(options),
      options
    );
  }

  async allOrders(options) {
    return this.route(
      options.symbol,
      (client) => client.allOrders(options),
      options
    );
  }

  async recentAccountOrders({
    startTime,
    endTime = Date.now(),
    limit = MAX_ACCOUNT_ORDER_QUERY_LIMIT,
    knownSpotSymbols = [],
    knownFuturesSymbols = [],
  } = {}) {
    const normalizedEndTime = Number(endTime);
    const normalizedStartTime = Number(
      startTime ?? normalizedEndTime - RECENT_ORDER_WINDOW_MS
    );
    const normalizedLimit = Math.floor(Math.min(
      MAX_ACCOUNT_ORDER_QUERY_LIMIT,
      Math.max(1, Number(limit) || MAX_ACCOUNT_ORDER_QUERY_LIMIT)
    ));
    if (
      !Number.isFinite(normalizedStartTime) ||
      !Number.isFinite(normalizedEndTime) ||
      normalizedStartTime >= normalizedEndTime ||
      normalizedEndTime - normalizedStartTime > RECENT_ORDER_WINDOW_MS
    ) {
      throw new BinanceApiError("全账户订单同步的时间范围必须是不超过 24 小时的有效区间。");
    }

    const orders = [];
    const warnings = [];
    const markets = {
      [MARKET_SPOT]: {
        configured: this.hasTradingCredentials(this.spot),
        queryMode: "per-symbol",
        symbols: [],
        orderCount: 0,
      },
      [MARKET_FUTURES]: {
        configured: this.hasTradingCredentials(this.futures),
        queryMode: "all-symbols",
        symbols: [],
        orderCount: 0,
      },
    };
    if (!markets.spot.configured && !markets.futures.configured) {
      throw new BinanceApiError(
        "当前环境没有可用于查询账户订单的现货或 U 本位 API Key/Secret。"
      );
    }

    if (markets.spot.configured) {
      const spotSymbols = this.collectKnownSymbols(
        MARKET_SPOT,
        knownSpotSymbols
      );
      try {
        const openOrders = await this.spot.openOrders({});
        const typedOpenOrders = this.addMarketType(openOrders, MARKET_SPOT);
        orders.push(...typedOpenOrders);
        for (const order of typedOpenOrders) {
          if (order.symbol) spotSymbols.add(order.symbol);
        }
      } catch (error) {
        warnings.push(this.serializeAccountSyncError(error, {
          marketType: MARKET_SPOT,
          operation: "openOrders",
        }));
      }

      const symbols = [...spotSymbols].sort();
      markets.spot.symbols = symbols;
      const results = await this.mapSettledWithConcurrency(
        symbols,
        (symbol) => this.queryCompleteOrderWindow({
          fetchPage: ({ startTime, endTime, limit }) =>
            this.spot.allOrders({ symbol, startTime, endTime, limit }),
          startTime: normalizedStartTime,
          endTime: normalizedEndTime,
          limit: normalizedLimit,
          warningContext: {
            marketType: MARKET_SPOT,
            operation: "allOrders",
            symbol,
          },
          warnings,
        }),
        4
      );
      for (const [index, result] of results.entries()) {
        const symbol = symbols[index];
        if (result.status === "fulfilled") {
          orders.push(...this.addMarketType(result.value, MARKET_SPOT));
        } else {
          warnings.push(this.serializeAccountSyncError(result.reason, {
            marketType: MARKET_SPOT,
            operation: "allOrders",
            symbol,
          }));
        }
      }
      markets.spot.orderCount = orders.filter(
        (order) => order.marketType === MARKET_SPOT
      ).length;
    }

    if (markets.futures.configured) {
      const futuresSymbols = this.collectKnownSymbols(
        MARKET_FUTURES,
        knownFuturesSymbols
      );
      try {
        const futuresOrders = await this.queryCompleteOrderWindow({
          fetchPage: ({ startTime, endTime, limit }) =>
            this.futures.allOrders({ startTime, endTime, limit }),
          startTime: normalizedStartTime,
          endTime: normalizedEndTime,
          limit: normalizedLimit,
          warningContext: {
            marketType: MARKET_FUTURES,
            operation: "allOrders",
          },
          warnings,
        });
        const typedFuturesOrders = this.addMarketType(
          futuresOrders,
          MARKET_FUTURES
        );
        orders.push(...typedFuturesOrders);
        for (const order of typedFuturesOrders) {
          if (order.symbol) futuresSymbols.add(order.symbol);
        }
      } catch (error) {
        if (!this.isMissingSymbolError(error)) {
          warnings.push(this.serializeAccountSyncError(error, {
            marketType: MARKET_FUTURES,
            operation: "allOrders",
          }));
        } else {
          markets.futures.queryMode = "per-symbol-fallback";
          markets.futures.fallbackReason = error.message;
          try {
            const openOrders = await this.futures.openOrders({});
            const typedOpenOrders = this.addMarketType(
              openOrders,
              MARKET_FUTURES
            );
            orders.push(...typedOpenOrders);
            for (const order of typedOpenOrders) {
              if (order.symbol) futuresSymbols.add(order.symbol);
            }
          } catch (openOrdersError) {
            warnings.push(this.serializeAccountSyncError(openOrdersError, {
              marketType: MARKET_FUTURES,
              operation: "openOrders",
            }));
          }

          const symbols = [...futuresSymbols].sort();
          const results = await this.mapSettledWithConcurrency(
            symbols,
            (symbol) => this.queryCompleteOrderWindow({
              fetchPage: ({ startTime, endTime, limit }) =>
                this.futures.allOrders({ symbol, startTime, endTime, limit }),
              startTime: normalizedStartTime,
              endTime: normalizedEndTime,
              limit: normalizedLimit,
              warningContext: {
                marketType: MARKET_FUTURES,
                operation: "allOrders",
                symbol,
              },
              warnings,
            }),
            4
          );
          for (const [index, result] of results.entries()) {
            const symbol = symbols[index];
            if (result.status === "fulfilled") {
              orders.push(...this.addMarketType(result.value, MARKET_FUTURES));
            } else {
              warnings.push(this.serializeAccountSyncError(result.reason, {
                marketType: MARKET_FUTURES,
                operation: "allOrders",
                symbol,
              }));
            }
          }
          if (!symbols.length) {
            warnings.push({
              marketType: MARKET_FUTURES,
              operation: "allOrders",
              name: "BinanceApiError",
              message: "当前 U 本位服务要求传入 symbol，且本地没有可用于补查的已知合约。",
              code: -1102,
            });
          }
        }
      }

      // Algo Order 历史接口要求 symbol。先用全账户当前 Algo 挂单发现活跃
      // 合约，再结合普通订单和本地已知合约逐一补齐最近 24 小时条件单。
      if (Date.now() - this.lastGlobalAlgoDiscoveryAt >= GLOBAL_ALGO_DISCOVERY_TTL_MS) {
        try {
          const openAlgoOrders = await this.futures.openAlgoOrders({});
          this.lastGlobalAlgoDiscoveryAt = Date.now();
          const typedOpenAlgoOrders = this.addMarketType(
            openAlgoOrders,
            MARKET_FUTURES
          );
          orders.push(...typedOpenAlgoOrders);
          for (const order of typedOpenAlgoOrders) {
            if (order.symbol) futuresSymbols.add(order.symbol);
          }
        } catch (error) {
          warnings.push(this.serializeAccountSyncError(error, {
            marketType: MARKET_FUTURES,
            operation: "openAlgoOrders",
          }));
        }
      }
      const algoSymbols = [...futuresSymbols].sort();
      const algoResults = await this.mapSettledWithConcurrency(
        algoSymbols,
        (symbol) => this.queryCompleteOrderWindow({
          fetchPage: ({ startTime, endTime, limit }) =>
            this.futures.allAlgoOrders({
              symbol,
              startTime,
              endTime,
              limit,
            }),
          startTime: normalizedStartTime,
          endTime: normalizedEndTime,
          limit: normalizedLimit,
          warningContext: {
            marketType: MARKET_FUTURES,
            operation: "allAlgoOrders",
            symbol,
          },
          warnings,
        }),
        4
      );
      for (const [index, result] of algoResults.entries()) {
        const symbol = algoSymbols[index];
        if (result.status === "fulfilled") {
          orders.push(...this.addMarketType(result.value, MARKET_FUTURES));
        } else {
          warnings.push(this.serializeAccountSyncError(result.reason, {
            marketType: MARKET_FUTURES,
            operation: "allAlgoOrders",
            symbol,
          }));
        }
      }
      markets.futures.symbols = [...futuresSymbols].sort();
      markets.futures.orderCount = orders.filter(
        (order) => order.marketType === MARKET_FUTURES
      ).length;
    }

    const uniqueOrders = new Map();
    for (const order of orders) {
      const identity = order.orderId !== undefined && order.orderId !== null
        ? `${order.algoOrder ? "algo" : "order"}:${order.orderId}`
        : `client:${order.clientOrderId || order.c || "unknown"}`;
      uniqueOrders.set(
        `${order.marketType}:${order.symbol || order.s}:${identity}`,
        order
      );
    }
    for (const marketType of [MARKET_SPOT, MARKET_FUTURES]) {
      markets[marketType].orderCount = [...uniqueOrders.values()].filter(
        (order) => order.marketType === marketType
      ).length;
    }
    return {
      startTime: normalizedStartTime,
      endTime: normalizedEndTime,
      orders: [...uniqueOrders.values()],
      markets,
      warnings,
    };
  }

  async myTrades(options) {
    return this.route(
      options.symbol,
      (client) => client.myTrades(options),
      options
    );
  }

  async accountStatus(options = {}) {
    const symbol = options.symbol || this.activeSymbol;
    if (!symbol) return this.spot.accountStatus(options);
    return this.route(
      symbol,
      (client) => client.accountStatus(options),
      options
    );
  }

  async tradingSafetyStatus() {
    const result = {
      mode: "EXPIRE_MAKER",
      markets: {},
      warnings: [],
    };
    const candidates = [
      [MARKET_SPOT, this.spot],
      [MARKET_FUTURES, this.futures],
    ];
    const settled = await Promise.allSettled(candidates.map(([, marketClient]) =>
      this.hasTradingCredentials(marketClient)
        ? marketClient.accountStatus({ omitZeroBalances: false })
        : Promise.resolve(null)
    ));

    for (const [index, settlement] of settled.entries()) {
      const [marketType, marketClient] = candidates[index];
      const expected = this.expectedTradeGroupIds[marketType];
      if (!this.hasTradingCredentials(marketClient)) {
        result.markets[marketType] = { configured: false };
        continue;
      }
      if (settlement.status === "rejected") {
        result.markets[marketType] = {
          configured: true,
          verified: false,
          error: this.serializeAccountSyncError(settlement.reason),
        };
        result.warnings.push(
          `${marketType === MARKET_SPOT ? "现货" : "U 本位"} STP 账户范围校验失败。`
        );
        continue;
      }

      const account = settlement.value || {};
      const tradeGroupId = String(account.tradeGroupId ?? "-1");
      const crossAccountProtected = tradeGroupId !== "-1";
      const matchesExpected = expected ? tradeGroupId === expected : null;
      result.markets[marketType] = {
        configured: true,
        verified: true,
        tradeGroupId,
        crossAccountProtected,
        expectedTradeGroupId: expected || null,
        matchesExpected,
      };
      if (!crossAccountProtected) {
        result.warnings.push(
          `${marketType === MARKET_SPOT ? "现货" : "U 本位"} tradeGroupId=-1，` +
          "EXPIRE_MAKER 只能保证当前账号内部，不能覆盖不同子账号。"
        );
      } else if (matchesExpected === false) {
        result.warnings.push(
          `${marketType === MARKET_SPOT ? "现货" : "U 本位"} tradeGroupId=${tradeGroupId}，` +
          `与配置期望值 ${expected} 不一致。`
        );
      }
    }
    result.crossAccountReady = Object.values(result.markets)
      .filter((market) => market.configured)
      .every((market) => market.verified && market.crossAccountProtected &&
        market.matchesExpected !== false);
    return result;
  }

  async accountRateLimits(options = {}) {
    const symbol = options.symbol || this.activeSymbol;
    if (!symbol) return this.spot.accountRateLimits();
    return this.route(symbol, (client) => client.accountRateLimits(), options);
  }

  async accountCommission(options) {
    return this.route(
      options.symbol,
      (client) => client.accountCommission(options),
      options
    );
  }

  async signTradFiPerpsAgreement() {
    const result = await this.futures.signTradFiPerpsAgreement();
    return this.addMarketType(result, MARKET_FUTURES);
  }

  async setFuturesCountdownCancelAll(options) {
    const resolution = await this.resolveMarket(options.symbol, options);
    if (resolution.marketType !== MARKET_FUTURES) {
      throw new BinanceApiError("自动撤单保护只适用于 U 本位永续合约。");
    }
    const result = await this.futures.setCountdownCancelAll(options);
    return this.addMarketType(result, MARKET_FUTURES);
  }

  async requireSpot(symbol, feature) {
    const resolution = await this.resolveMarket(symbol || this.activeSymbol);
    if (resolution.marketType !== MARKET_SPOT) {
      throw new BinanceApiError(`${feature} 仅适用于现货；普通下单、撤单和查询已自动适配当前永续合约。`);
    }
    return resolution.client;
  }

  async allOrderLists(options = {}) {
    const client = await this.requireSpot(options.symbol, "组合订单历史");
    return client.allOrderLists(options);
  }

  async queryOrderList(options = {}) {
    const client = await this.requireSpot(options.symbol, "组合订单查询");
    return client.queryOrderList(options);
  }

  async openOrderLists(options = {}) {
    const client = await this.requireSpot(options.symbol, "当前组合挂单");
    return client.openOrderLists();
  }

  async placeOco(options) {
    const client = await this.requireSpot(options.symbol, "OCO");
    return client.placeOco(options);
  }

  async placeOto(options) {
    const client = await this.requireSpot(options.symbol, "OTO");
    return client.placeOto(options);
  }

  async placeOtoco(options) {
    const client = await this.requireSpot(options.symbol, "OTOCO");
    return client.placeOtoco(options);
  }

  async cancelOrderList(options) {
    const client = await this.requireSpot(options.symbol, "组合订单撤销");
    return client.cancelOrderList(options);
  }

  async connectUserData(options = {}) {
    const symbol = options.symbol || this.activeSymbol;
    if (symbol) {
      const resolution = await this.resolveMarket(symbol);
      const result = await resolution.client.connectUserData();
      return this.addMarketType(result, resolution.marketType);
    }

    const candidates = [this.spot, this.futures].filter(
      (client) => client.apiKey && client.apiSecret
    );
    if (!candidates.length) this.spot.assertTradingCredentials();
    const results = await Promise.allSettled(
      candidates.map((client) => client.connectUserData())
    );
    const connected = {};
    const failures = [];
    for (const [index, result] of results.entries()) {
      const marketClient = candidates[index];
      if (result.status === "fulfilled") {
        connected[marketClient.marketType] = this.addMarketType(
          result.value,
          marketClient.marketType
        );
      } else {
        failures.push({
          marketType: marketClient.marketType,
          error: result.reason,
        });
        this.emit("user-data-error", {
          marketType: marketClient.marketType,
          message: result.reason?.message || "账户事件连接失败",
          time: Date.now(),
        });
      }
    }
    if (!Object.keys(connected).length && failures.length) {
      throw failures[0].error;
    }
    return { connected, failedMarketTypes: failures.map(({ marketType }) => marketType) };
  }

  disconnectUserData() {
    return {
      spot: this.spot.disconnectUserData(),
      futures: this.futures.disconnectUserData(),
    };
  }

  close() {
    this.closed = true;
    this.spot.close();
    this.futures.close();
    this.marketResolutionCache.clear();
    this.removeAllListeners();
  }
}

module.exports = {
  BinanceUnifiedClient,
  MARKET_SPOT,
  MARKET_FUTURES,
};
