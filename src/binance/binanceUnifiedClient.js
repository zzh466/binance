const { EventEmitter } = require("node:events");
const { BinanceApiError } = require("./binanceClientBase");
const { BinanceUsdMClient } = require("./binanceUsdMClient");
const { compareDecimal, subtractDecimal } = require("./decimalMath");

const MARKET_FUTURES = "futures";
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
  return timeout
    ? new Promise((resolve) => setTimeout(resolve, timeout))
    : Promise.resolve();
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

class BinanceUnifiedClient extends EventEmitter {
  constructor({
    testnet = true,
    futuresCredentials = {},
    depthSpeed,
    depthLevels,
    preflightBalanceCheck,
    publicMarketFetch,
    futuresBrokerLinkId,
    expectedFuturesTradeGroupId,
    rateLimitCoordinator,
  } = {}) {
    super();
    this.testnet = Boolean(testnet);
    this.futures = new BinanceUsdMClient({
      testnet: this.testnet,
      apiKey: futuresCredentials.apiKey || "",
      apiSecret: futuresCredentials.apiSecret || "",
      brokerLinkId: futuresBrokerLinkId,
      depthSpeed,
      depthLevels,
      preflightBalanceCheck,
      publicMarketFetch,
      rateLimitCoordinator,
    });
    this.futures.credentialsSource = futuresCredentials.source || "";
    this.credentialsSource = this.futures.credentialsSource;
    this.expectedFuturesTradeGroupId = String(
      expectedFuturesTradeGroupId ?? ""
    ).trim();
    this.activeMarketType = MARKET_FUTURES;
    this.activeSymbol = null;
    this.closeAllPositionsPromise = null;
    this.closeAllFuturesPositionsPromise = null;
    this.closed = false;
    this.lastGlobalAlgoDiscoveryAt = 0;
    this.bindFuturesEvents();
  }

  bindFuturesEvents() {
    for (const eventName of ROUTED_EVENTS) {
      this.futures.on(eventName, (payload = {}) => {
        this.emit(eventName, { ...payload, marketType: MARKET_FUTURES });
      });
    }
  }

  get restBase() { return this.futures.restBase; }
  get tradingRestBase() { return this.futures.tradingRestBase; }
  get wsBase() { return this.futures.wsBase; }
  get wsApiBase() { return this.futures.wsApiBase; }
  get tradingWsApiBase() { return this.futures.tradingWsApiBase; }
  get apiKey() { return this.futures.apiKey; }
  get apiSecret() { return this.futures.apiSecret; }
  get serverTimeOffsetMs() { return this.futures.serverTimeOffsetMs; }
  get tradingServerTimeOffsetMs() {
    return this.futures.tradingServerTimeOffsetMs;
  }
  get preflightBalanceCheck() { return this.futures.preflightBalanceCheck; }
  get depthSpeed() { return this.futures.depthSpeed; }
  get depthDisplayLevels() { return this.futures.depthDisplayLevels; }
  get depthStreamLevels() { return this.futures.depthStreamLevels; }
  get depthMode() { return this.futures.depthMode; }

  getActiveClient() {
    return this.futures;
  }

  getClient(marketType = MARKET_FUTURES) {
    if (marketType && marketType !== MARKET_FUTURES) {
      throw new BinanceApiError("当前客户端仅支持 U 本位永续合约。");
    }
    return this.futures;
  }

  validateSymbol(symbol) {
    return this.futures.validateSymbol(symbol);
  }

  isMissingSymbolError(error) {
    return Number(error?.code) === -1102 && /symbol/i.test(
      `${error?.message || ""} ${error?.data?.msg || ""}`
    );
  }

  hasTradingCredentials() {
    return Boolean(this.futures.apiKey && this.futures.apiSecret);
  }

  addMarketType(data) {
    if (Array.isArray(data)) {
      return data.map((item) =>
        item && typeof item === "object"
          ? { ...item, marketType: MARKET_FUTURES }
          : item
      );
    }
    if (data && typeof data === "object") {
      return { ...data, marketType: MARKET_FUTURES };
    }
    return data;
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

  collectKnownSymbols(suppliedSymbols = []) {
    const symbols = new Set();
    const addSymbol = (symbol) => {
      if (!symbol) return;
      try {
        symbols.add(this.validateSymbol(symbol));
      } catch {
        // 本地旧记录中的无效合约不应阻塞全账户同步。
      }
    };
    for (const symbol of suppliedSymbols) addSymbol(symbol);
    addSymbol(this.activeSymbol);
    return symbols;
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
    return this.futures.initialize();
  }

  async resolveMarket(symbol, { forceRefresh = false, marketType } = {}) {
    if (marketType && marketType !== MARKET_FUTURES) {
      throw new BinanceApiError("当前客户端仅支持 U 本位永续合约。");
    }
    const normalizedSymbol = this.validateSymbol(symbol);
    const exchangeInfo = await this.futures.exchangeInfo(normalizedSymbol, {
      forceRefresh,
    });
    return {
      symbol: normalizedSymbol,
      marketType: MARKET_FUTURES,
      client: this.futures,
      exchangeInfo,
      resolvedAt: Date.now(),
    };
  }

  async syncServerTime() {
    return this.addMarketType(await this.futures.syncServerTime());
  }

  async ping() {
    return this.addMarketType(await this.futures.ping());
  }

  async exchangeInfo(symbol, { forceRefresh = false } = {}) {
    const resolution = await this.resolveMarket(symbol, { forceRefresh });
    return this.addMarketType(resolution.exchangeInfo);
  }

  async marketOverview(symbol, options = {}) {
    this.getClient(options.marketType);
    return this.addMarketType(
      await this.futures.marketOverview(symbol, options)
    );
  }

  async connectDepth(symbol, options = {}) {
    const resolution = await this.resolveMarket(symbol);
    this.futures.disconnectMarket();
    this.activeSymbol = resolution.symbol;
    const result = await this.futures.connectDepth(
      resolution.symbol,
      options
    );
    if (this.hasTradingCredentials()) {
      this.futures.connectUserData().catch((error) => {
        this.emit("user-data-error", {
          marketType: MARKET_FUTURES,
          message: error.message,
          time: Date.now(),
        });
      });
    }
    return this.addMarketType(result);
  }

  async setDepthLevels(levels) {
    const normalizedLevels = this.futures.setDepthLevels(levels);
    if (!this.activeSymbol) {
      return this.addMarketType({
        depthMode: this.depthMode,
        streamLevels: normalizedLevels,
        displayLevels: normalizedLevels,
        reconnected: false,
      });
    }

    const result = await this.futures.connectDepth(this.activeSymbol);
    return this.addMarketType({
      ...result,
      reconnected: true,
    });
  }

  disconnectMarket() {
    this.futures.disconnectMarket();
    this.activeSymbol = null;
  }

  async placeOrder(order, options) {
    this.getClient(order?.marketType);
    return this.addMarketType(
      await this.futures.placeOrder(order, options)
    );
  }

  async cancelOrder(order) {
    this.getClient(order?.marketType);
    return this.addMarketType(await this.futures.cancelOrder(order));
  }

  async queryOrder(options) {
    this.getClient(options?.marketType);
    return this.addMarketType(await this.futures.queryOrder(options));
  }

  async openOrders(options = {}) {
    this.getClient(options.marketType);
    return this.addMarketType(await this.futures.openOrders(options));
  }

  async cancelAllOpenOrders(options) {
    this.getClient(options?.marketType);
    return this.addMarketType(
      await this.futures.cancelAllOpenOrders(options)
    );
  }

  async amendOrder(options) {
    this.getClient(options?.marketType);
    return this.addMarketType(await this.futures.amendOrder(options));
  }

  async cancelReplace(options) {
    this.getClient(options?.marketType);
    return this.addMarketType(await this.futures.cancelReplace(options));
  }

  async allOrders(options = {}) {
    this.getClient(options.marketType);
    return this.addMarketType(await this.futures.allOrders(options));
  }

  async myTrades(options) {
    this.getClient(options?.marketType);
    return this.addMarketType(await this.futures.myTrades(options));
  }

  async accountStatus(options = {}) {
    this.getClient(options.marketType);
    return this.addMarketType(await this.futures.accountStatus(options));
  }

  async accountRateLimits() {
    return this.addMarketType(await this.futures.accountRateLimits());
  }

  async accountCommission(options) {
    this.getClient(options?.marketType);
    return this.addMarketType(await this.futures.accountCommission(options));
  }

  async signTradFiPerpsAgreement() {
    return this.addMarketType(await this.futures.signTradFiPerpsAgreement());
  }

  async setFuturesCountdownCancelAll(options) {
    this.getClient(options?.marketType);
    return this.addMarketType(
      await this.futures.setCountdownCancelAll(options)
    );
  }

  async tradingSafetyStatus() {
    this.futures.assertTradingCredentials();
    const result = { mode: "EXPIRE_MAKER", markets: {}, warnings: [] };
    try {
      const account = await this.futures.accountStatus({
        omitZeroBalances: false,
      });
      const tradeGroupId = String(account.tradeGroupId ?? "-1");
      const crossAccountProtected = tradeGroupId !== "-1";
      const matchesExpected = this.expectedFuturesTradeGroupId
        ? tradeGroupId === this.expectedFuturesTradeGroupId
        : null;
      result.markets.futures = {
        configured: true,
        verified: true,
        tradeGroupId,
        crossAccountProtected,
        expectedTradeGroupId: this.expectedFuturesTradeGroupId || null,
        matchesExpected,
      };
      if (!crossAccountProtected) {
        result.warnings.push(
          "U 本位 tradeGroupId=-1，EXPIRE_MAKER 只能保证当前账号内部，不能覆盖不同子账号。"
        );
      } else if (matchesExpected === false) {
        result.warnings.push(
          `U 本位 tradeGroupId=${tradeGroupId}，` +
          `与配置期望值 ${this.expectedFuturesTradeGroupId} 不一致。`
        );
      }
      result.crossAccountReady = crossAccountProtected &&
        matchesExpected !== false;
    } catch (error) {
      result.markets.futures = {
        configured: true,
        verified: false,
        error: this.serializeAccountSyncError(error),
      };
      result.warnings.push("U 本位 STP 账户范围校验失败。");
      result.crossAccountReady = false;
    }
    return result;
  }

  async recentAccountOrders({
    startTime,
    endTime = Date.now(),
    limit = MAX_ACCOUNT_ORDER_QUERY_LIMIT,
    knownFuturesSymbols = [],
  } = {}) {
    this.futures.assertTradingCredentials();
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
      throw new BinanceApiError(
        "全账户订单同步的时间范围必须是不超过 24 小时的有效区间。"
      );
    }

    const orders = [];
    const warnings = [];
    const symbols = this.collectKnownSymbols(knownFuturesSymbols);
    let queryMode = "all-symbols";
    try {
      const rows = await this.queryCompleteOrderWindow({
        fetchPage: (range) => this.futures.allOrders(range),
        startTime: normalizedStartTime,
        endTime: normalizedEndTime,
        limit: normalizedLimit,
        warningContext: {
          marketType: MARKET_FUTURES,
          operation: "allOrders",
        },
        warnings,
      });
      const typedRows = this.addMarketType(rows);
      orders.push(...typedRows);
      for (const order of typedRows) {
        if (order.symbol) symbols.add(order.symbol);
      }
    } catch (error) {
      if (!this.isMissingSymbolError(error)) throw error;
      queryMode = "per-symbol-fallback";
      try {
        const openOrders = this.addMarketType(await this.futures.openOrders({}));
        orders.push(...openOrders);
        for (const order of openOrders) {
          if (order.symbol) symbols.add(order.symbol);
        }
      } catch (openOrdersError) {
        warnings.push(this.serializeAccountSyncError(openOrdersError, {
          marketType: MARKET_FUTURES,
          operation: "openOrders",
        }));
      }
      const knownSymbols = [...symbols].sort();
      const results = await this.mapSettledWithConcurrency(
        knownSymbols,
        (symbol) => this.queryCompleteOrderWindow({
          fetchPage: (range) => this.futures.allOrders({ symbol, ...range }),
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
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          orders.push(...this.addMarketType(result.value));
        } else {
          warnings.push(this.serializeAccountSyncError(result.reason, {
            marketType: MARKET_FUTURES,
            operation: "allOrders",
            symbol: knownSymbols[index],
          }));
        }
      });
    }

    if (Date.now() - this.lastGlobalAlgoDiscoveryAt >= GLOBAL_ALGO_DISCOVERY_TTL_MS) {
      try {
        const openAlgoOrders = this.addMarketType(
          await this.futures.openAlgoOrders({})
        );
        this.lastGlobalAlgoDiscoveryAt = Date.now();
        orders.push(...openAlgoOrders);
        for (const order of openAlgoOrders) {
          if (order.symbol) symbols.add(order.symbol);
        }
      } catch (error) {
        warnings.push(this.serializeAccountSyncError(error, {
          marketType: MARKET_FUTURES,
          operation: "openAlgoOrders",
        }));
      }
    }

    const algoSymbols = [...symbols].sort();
    const algoResults = await this.mapSettledWithConcurrency(
      algoSymbols,
      (symbol) => this.queryCompleteOrderWindow({
        fetchPage: (range) => this.futures.allAlgoOrders({ symbol, ...range }),
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
    algoResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        orders.push(...this.addMarketType(result.value));
      } else {
        warnings.push(this.serializeAccountSyncError(result.reason, {
          marketType: MARKET_FUTURES,
          operation: "allAlgoOrders",
          symbol: algoSymbols[index],
        }));
      }
    });

    const uniqueOrders = new Map();
    for (const order of orders) {
      const identity = order.orderId !== undefined && order.orderId !== null
        ? `${order.algoOrder ? "algo" : "order"}:${order.orderId}`
        : `client:${order.clientOrderId || order.c || "unknown"}`;
      uniqueOrders.set(`${order.symbol || order.s}:${identity}`, order);
    }
    return {
      startTime: normalizedStartTime,
      endTime: normalizedEndTime,
      orders: [...uniqueOrders.values()],
      markets: {
        futures: {
          configured: true,
          queryMode,
          symbols: [...symbols].sort(),
          orderCount: uniqueOrders.size,
        },
      },
      warnings,
    };
  }

  createCloseAllContext({
    maxDurationMs = CLOSE_ALL_DEFAULT_TIMEOUT_MS,
    concurrency = CLOSE_ALL_DEFAULT_CONCURRENCY,
    waitFn = delay,
  } = {}) {
    const startedAt = Date.now();
    return {
      marketType: MARKET_FUTURES,
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
      marketType: MARKET_FUTURES,
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
        { data: { waitedMs: context.waitedMs } }
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
    const snapshot = this.futures.rateLimitCoordinator?.snapshot?.() || {};
    const candidates = [];
    const marketBanUntil = Number(snapshot.marketBans?.futures);
    if (Number.isFinite(marketBanUntil) && marketBanUntil > now) {
      candidates.push(marketBanUntil);
    }
    const globalBanUntil = Number(snapshot.globalBanUntil);
    if (Number.isFinite(globalBanUntil) && globalBanUntil > now) {
      candidates.push(globalBanUntil);
    }
    for (const error of errors) {
      const banUntil = Number(error?.data?.banUntil);
      if (Number.isFinite(banUntil) && banUntil > now) candidates.push(banUntil);
    }
    if (proactive) {
      for (const limit of snapshot.limits || []) {
        if (limit.marketType && limit.marketType !== MARKET_FUTURES) continue;
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
      (Number(error?.code) === -1003 &&
        error?.data?.localRateLimitGuard === true);
  }

  async waitForCloseAllRateLimit(context, waitMs, details = {}) {
    if (!(waitMs > 0)) return;
    this.assertCloseAllCanContinue(context);
    if (waitMs >= context.deadlineAt - Date.now()) {
      this.assertCloseAllCanContinue({ ...context, deadlineAt: Date.now() });
    }
    context.waitedMs += waitMs;
    context.rateLimitWaitCount += 1;
    this.emitCloseAllProgress(context, {
      stage: "rate-limit-wait",
      message: `Binance U 本位接口接近或触发限流，将在 ` +
        `${(waitMs / 1_000).toFixed(1)} 秒后自动继续。`,
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
    while (pending.length) {
      this.assertCloseAllCanContinue(context);
      const batchSize = Math.min(context.concurrency, pending.length);
      const proactiveWaitMs = this.getCloseAllRateLimitWaitMs(context, {
        proactive: true,
        upcomingCount: batchSize,
      });
      if (proactiveWaitMs > 0) {
        await this.waitForCloseAllRateLimit(context, proactiveWaitMs, { stage });
      }
      const batch = pending.splice(0, batchSize);
      const settlements = await Promise.allSettled(
        batch.map(({ item }) => worker(item))
      );
      const retryItems = [];
      const errors = [];
      settlements.forEach((settlement, index) => {
        if (
          settlement.status === "rejected" &&
          this.isRetryableCloseAllRateLimit(settlement.reason)
        ) {
          retryItems.push(batch[index]);
          errors.push(settlement.reason);
        } else {
          results[batch[index].index] = settlement;
        }
      });
      pending.unshift(...retryItems);
      if (retryItems.length) {
        const waitMs = Math.max(
          1_000,
          this.getCloseAllRateLimitWaitMs(context, {
            errors,
            proactive: true,
            upcomingCount: Math.min(context.concurrency, pending.length),
          })
        );
        await this.waitForCloseAllRateLimit(context, waitMs, { stage });
      }
    }
    return results;
  }

  async closeAllPositions() {
    if (this.closeAllPositionsPromise) return this.closeAllPositionsPromise;
    const operation = this.closeAllFuturesPositions().then((futures) => ({
      verifiedFlat: futures.verifiedFlat === true,
      markets: { futures },
      remainingFuturesPositions: futures.remainingPositions || [],
      remainingPositions: futures.remainingPositions || [],
      remainingOpenOrders: (futures.remainingOpenOrders || []).map((order) => ({
        marketType: MARKET_FUTURES,
        ...order,
      })),
      orders: futures.orders || [],
      completedAt: Date.now(),
    })).finally(() => {
      if (this.closeAllPositionsPromise === operation) {
        this.closeAllPositionsPromise = null;
      }
    });
    this.closeAllPositionsPromise = operation;
    return operation;
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
      ...initialOpenOrders.map((order) =>
        String(order?.symbol || "").toUpperCase()
      ),
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

    const normalizedDelays = (
      Array.isArray(verificationDelays) && verificationDelays.length
        ? verificationDelays
        : [0]
    ).map((value) => Math.max(0, Number(value) || 0));
    let positionsVerified = false;
    let remainingPositions = positionsToClose;
    let positionFlatConfirmations = 0;
    const verificationErrors = [];
    for (const waitMs of normalizedDelays) {
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
      openOrdersVerified && remainingPositions.length === 0 &&
      remainingOpenOrders.length === 0;
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
      orders: [...canceledOrders, ...closeOrders],
      waitedMs: context.waitedMs,
      rateLimitWaitCount: context.rateLimitWaitCount,
      completedAt: Date.now(),
    };
  }

  async connectUserData() {
    return this.addMarketType(await this.futures.connectUserData());
  }

  disconnectUserData() {
    return { futures: this.futures.disconnectUserData() };
  }

  close() {
    this.closed = true;
    this.futures.close();
    this.removeAllListeners();
  }
}

module.exports = {
  BinanceUnifiedClient,
  MARKET_FUTURES,
  listOpenFuturesPositions,
  normalizeOpenFuturesPosition,
};
