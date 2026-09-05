const { EventEmitter } = require("node:events");
const {
  BinanceSpotClient,
  BinanceApiError,
} = require("./binanceSpotClient");
const { BinanceUsdMClient } = require("./binanceUsdMClient");

const MARKET_SPOT = "spot";
const MARKET_FUTURES = "futures";
const MARKET_RESOLUTION_CACHE_TTL_MS = 300_000;
const MARKET_RESOLUTION_REFRESH_RETRY_MS = 30_000;
const RECENT_ORDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ACCOUNT_ORDER_QUERY_LIMIT = 1_000;
const GLOBAL_ALGO_DISCOVERY_TTL_MS = 300_000;
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
