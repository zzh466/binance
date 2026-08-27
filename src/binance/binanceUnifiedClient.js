const { EventEmitter } = require("node:events");
const {
  BinanceSpotClient,
  BinanceApiError,
} = require("./binanceSpotClient");
const { BinanceUsdMClient } = require("./binanceUsdMClient");

const MARKET_SPOT = "spot";
const MARKET_FUTURES = "futures";
const ROUTED_EVENTS = [
  "depth-update",
  "trade-update",
  "market-status",
  "market-error",
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
    depthSnapshotLimit,
    depthDisplayLevels,
    preflightBalanceCheck,
    publicMarketFetch,
    spotBrokerLinkId,
    futuresBrokerLinkId,
  } = {}) {
    super();
    this.testnet = Boolean(testnet);
    const common = {
      testnet: this.testnet,
      depthSpeed,
      depthSnapshotLimit,
      depthDisplayLevels,
      preflightBalanceCheck,
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
    this.activeMarketType = MARKET_SPOT;
    this.activeSymbol = null;
    this.marketResolutionCache = new Map();
    this.futuresInitializationPromise = null;
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

  get depthSnapshotLimit() {
    return this.spot.depthSnapshotLimit;
  }

  get depthDisplayLevels() {
    return this.spot.depthDisplayLevels;
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
    if (!forceRefresh && cached && Date.now() - cached.resolvedAt < 300_000) {
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
    return this.spot.connectUserData();
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
