const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const WebSocket = require("ws");
const { LocalOrderBook } = require("./localOrderBook");
const REST_BASE = {
  testnet: "https://testnet.binance.vision/api",
  production: "https://api.binance.com/api",
};

const WS_BASE = {
  testnet: "wss://stream.testnet.binance.vision/ws",
  production: "wss://stream.binance.com:9443/ws",
};

const WS_API_BASE = {
  testnet: "wss://ws-api.testnet.binance.vision/ws-api/v3",
  production: "wss://ws-api.binance.com:443/ws-api/v3",
};

const DEPTH_SPEEDS = new Set(["100ms", "1000ms"]);
const DEPTH_SNAPSHOT_LIMITS = new Set([100, 500, 1000, 5000]);

function requestHttps(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeout || 10_000;
    let request;
    const timeoutId = setTimeout(() => {
      request?.destroy(new Error("请求 Binance 超时"));
    }, timeoutMs);

    request = https.request(url, options, (response) => {
      const chunks = [];

      response.setEncoding("utf8");
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        clearTimeout(timeoutId);
        resolve({
          statusCode: response.statusCode || 0,
          rawText: chunks.join(""),
        });
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("请求 Binance 超时"));
    });
    request.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
    request.end();
  });
}

class BinanceApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BinanceApiError";
    this.status = details.status;
    this.code = details.code;
    this.data = details.data;
  }
}

class BinanceSpotClient extends EventEmitter {
  constructor({
    apiKey = "",
    apiSecret = "",
    testnet = true,
    depthSpeed = "100ms",
    depthSnapshotLimit = 1000,
    depthDisplayLevels = 10,
  } = {}) {
    super();

    this.apiKey = apiKey.trim();
    this.apiSecret = apiSecret.trim();
    this.testnet = Boolean(testnet);

    this.restBase = this.testnet ? REST_BASE.testnet : REST_BASE.production;
    this.tradingRestBase = this.restBase;
    this.wsBase = this.testnet ? WS_BASE.testnet : WS_BASE.production;
    this.wsApiBase = this.testnet
      ? WS_API_BASE.testnet
      : WS_API_BASE.production;
    this.tradingWsApiBase = this.wsApiBase;

    this.depthSpeed = DEPTH_SPEEDS.has(depthSpeed) ? depthSpeed : "100ms";

    const normalizedSnapshotLimit = Number(depthSnapshotLimit);
    this.depthSnapshotLimit = DEPTH_SNAPSHOT_LIMITS.has(
      normalizedSnapshotLimit
    )
      ? normalizedSnapshotLimit
      : 1000;

    this.depthDisplayLevels = Math.min(
      100,
      Math.max(1, Math.floor(Number(depthDisplayLevels) || 10))
    );

    this.serverTimeOffsetMs = 0;
    this.tradingServerTimeOffsetMs = 0;

    this.marketSocket = null;
    this.marketSymbol = null;
    this.marketManualClose = false;
    this.marketReconnectTimer = null;
    this.marketReconnectDelayMs = 1_000;
    this.tradeSocket = null;
    this.tradeReconnectTimer = null;
    this.tradeReconnectDelayMs = 1_000;

    this.orderBook = new LocalOrderBook();
    this.depthEventBuffer = [];
    this.depthReady = false;
    this.depthSyncVersion = 0;

    this.exchangeInfoCache = new Map();
    this.userDataSocket = null;
    this.userDataManualClose = false;
    this.userDataReconnectTimer = null;
    this.userDataReconnectDelayMs = 1_000;
    this.userDataSubscriptionId = null;
  }

  async initialize() {
    await this.syncServerTime();
  }

  async syncServerTime() {
    return this.syncServerTimeForBase(this.restBase);
  }

  async syncTradingServerTime() {
    return this.syncServerTimeForBase(this.tradingRestBase);
  }

  async syncServerTimeForBase(baseUrl) {
    const before = Date.now();
    const result = await this.request("GET", "/v3/time", {}, false, baseUrl);
    const after = Date.now();

    const localMidpoint = Math.floor((before + after) / 2);
    const offsetMs = Number(result.serverTime) - localMidpoint;

    if (baseUrl === this.tradingRestBase) {
      this.tradingServerTimeOffsetMs = offsetMs;
    }
    if (baseUrl === this.restBase) {
      this.serverTimeOffsetMs = offsetMs;
    }

    return {
      serverTime: Number(result.serverTime),
      localMidpoint,
      offsetMs,
      baseUrl,
    };
  }

  getTimestamp() {
    return Date.now() + this.tradingServerTimeOffsetMs;
  }

  assertTradingCredentials() {
    if (!this.apiKey || !this.apiSecret) {
      throw new BinanceApiError(
        "缺少 BINANCE_API_KEY 或 BINANCE_API_SECRET；行情可连接，但不能下单或撤单。"
      );
    }
  }

  normalizeParams(params = {}) {
    const normalized = {};

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      normalized[key] = String(value);
    }

    return normalized;
  }

  async request(
    method,
    path,
    params = {},
    signed = false,
    baseUrl = this.restBase
  ) {
    const normalized = this.normalizeParams(params);

    if (signed) {
      this.assertTradingCredentials();

      normalized.recvWindow ??= "5000";
      normalized.timestamp = String(this.getTimestamp());

      const unsignedQuery = new URLSearchParams(normalized).toString();
      normalized.signature = crypto
        .createHmac("sha256", this.apiSecret)
        .update(unsignedQuery)
        .digest("hex");
    }

    const query = new URLSearchParams(normalized).toString();
    const url = `${baseUrl}${path}${query ? `?${query}` : ""}`;

    const headers = {
      Accept: "application/json",
    };

    if (this.apiKey) {
      headers["X-MBX-APIKEY"] = this.apiKey;
    }

    let response;
    try {
      response = await requestHttps(url, {
        method,
        headers,
        timeout: 10_000,
      });
    } catch (error) {
      throw new BinanceApiError(`请求 Binance 失败：${error.message}`, {
        data: { cause: error.name },
      });
    }

    const rawText = response.rawText;
    let data;

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { rawText };
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new BinanceApiError(
        data.msg || `Binance HTTP ${response.statusCode}`,
        {
          status: response.statusCode,
          code: data.code,
          data,
        }
      );
    }

    return data;
  }

  validateSymbol(symbol) {
    const normalized = String(symbol || "").trim().toUpperCase();

    if (!/^[A-Z0-9]{5,20}$/.test(normalized)) {
      throw new BinanceApiError(`交易对格式非法：${symbol}`);
    }

    return normalized;
  }

  async ping() {
    await this.request("GET", "/v3/ping");
    return { connected: true, environment: this.testnet ? "testnet" : "production" };
  }

  async exchangeInfo(symbol, { forceRefresh = false } = {}) {
    const normalizedSymbol = this.validateSymbol(symbol);
    const cached = this.exchangeInfoCache.get(normalizedSymbol);

    if (!forceRefresh && cached && Date.now() - cached.loadedAt < 300_000) {
      return cached.data;
    }

    const result = await this.request("GET", "/v3/exchangeInfo", {
      symbol: normalizedSymbol,
    });
    const data = {
      ...result,
      symbol: result.symbols?.[0] || null,
    };
    this.exchangeInfoCache.set(normalizedSymbol, { loadedAt: Date.now(), data });
    return data;
  }

  async marketOverview(symbol, { interval = "1m", limit = 50 } = {}) {
    const normalizedSymbol = this.validateSymbol(symbol);
    const normalizedLimit = Math.min(1000, Math.max(1, Number(limit) || 50));
    const [price, bookTicker, averagePrice, ticker24hr, recentTrades, aggregateTrades, klines] =
      await Promise.all([
        this.request("GET", "/v3/ticker/price", { symbol: normalizedSymbol }),
        this.request("GET", "/v3/ticker/bookTicker", { symbol: normalizedSymbol }),
        this.request("GET", "/v3/avgPrice", { symbol: normalizedSymbol }),
        this.request("GET", "/v3/ticker/24hr", { symbol: normalizedSymbol }),
        this.request("GET", "/v3/trades", { symbol: normalizedSymbol, limit: normalizedLimit }),
        this.request("GET", "/v3/aggTrades", { symbol: normalizedSymbol, limit: normalizedLimit }),
        this.request("GET", "/v3/klines", {
          symbol: normalizedSymbol,
          interval,
          limit: normalizedLimit,
        }),
      ]);

    let historicalTrades = [];
    let historicalTradesError = null;
    try {
      historicalTrades = await this.request("GET", "/v3/historicalTrades", {
        symbol: normalizedSymbol,
        limit: normalizedLimit,
      });
    } catch (error) {
      historicalTradesError = {
        name: error.name,
        message: error.message,
        status: error.status,
        code: error.code,
      };
    }

    return {
      symbol: normalizedSymbol,
      price,
      bookTicker,
      averagePrice,
      ticker24hr,
      recentTrades,
      historicalTrades,
      historicalTradesError,
      aggregateTrades,
      klines: klines.map((kline) => ({
        openTime: kline[0],
        open: kline[1],
        high: kline[2],
        low: kline[3],
        close: kline[4],
        volume: kline[5],
        closeTime: kline[6],
        quoteVolume: kline[7],
        tradeCount: kline[8],
      })),
    };
  }

  decimalPlaces(value) {
    const text = String(value ?? "").toLowerCase();
    if (text.includes("e-")) {
      return Number(text.split("e-")[1]) || 0;
    }
    return (text.split(".")[1] || "").length;
  }

  alignToStep(value, step, mode = "floor") {
    const numericValue = Number(value);
    const numericStep = Number(step);
    if (!Number.isFinite(numericValue) || numericValue <= 0 || !numericStep) {
      return String(value);
    }

    const precision = this.decimalPlaces(step);
    const scaled = numericValue / numericStep;
    const aligned = (mode === "ceil" ? Math.ceil(scaled - 1e-12) : Math.floor(scaled + 1e-12)) * numericStep;
    return aligned.toFixed(precision);
  }

  assertFilterRange(name, value, min, max) {
    const numeric = Number(value);
    if (Number(min) > 0 && numeric < Number(min)) {
      throw new BinanceApiError(`${name} ${value} 小于当前环境允许的最小值 ${min}。`);
    }
    if (Number(max) > 0 && numeric > Number(max)) {
      throw new BinanceApiError(`${name} ${value} 大于当前环境允许的最大值 ${max}。`);
    }
  }

  async prepareOrder(order) {
    const symbol = this.validateSymbol(order.symbol);
    const side = String(order.side || "").toUpperCase();
    const type = String(order.type || "").toUpperCase();
    const supportedTypes = new Set([
      "LIMIT",
      "MARKET",
      "LIMIT_MAKER",
      "STOP_LOSS",
      "STOP_LOSS_LIMIT",
      "TAKE_PROFIT",
      "TAKE_PROFIT_LIMIT",
    ]);

    if (!["BUY", "SELL"].includes(side)) {
      throw new BinanceApiError(`side 只支持 BUY 或 SELL，当前值：${side}`);
    }
    if (!supportedTypes.has(type)) {
      throw new BinanceApiError(`当前页面不支持委托类型：${type}`);
    }

    const info = await this.exchangeInfo(symbol);
    const symbolInfo = info.symbol;
    if (!symbolInfo || symbolInfo.status !== "TRADING") {
      throw new BinanceApiError(`${symbol} 在当前环境不可交易。`);
    }

    const filters = Object.fromEntries(
      (symbolInfo.filters || []).map((filter) => [filter.filterType, filter])
    );
    const quantityFilter = type === "MARKET"
      ? filters.MARKET_LOT_SIZE || filters.LOT_SIZE
      : filters.LOT_SIZE;

    const params = this.normalizeParams({
      symbol,
      side,
      type,
      timeInForce: order.timeInForce,
      quantity: order.quantity,
      quoteOrderQty: order.quoteOrderQty,
      price: order.price,
      stopPrice: order.stopPrice,
      trailingDelta: order.trailingDelta,
      icebergQty: order.icebergQty,
      newClientOrderId: order.newClientOrderId,
      newOrderRespType: order.newOrderRespType || "RESULT",
    });

    const limitLike = new Set(["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"]);
    if (limitLike.has(type)) {
      params.timeInForce ||= "GTC";
    }
    if (type !== "MARKET" && type !== "STOP_LOSS" && type !== "TAKE_PROFIT" && !params.price) {
      throw new BinanceApiError(`${type} 委托必须提供 price。`);
    }
    if (!params.quantity && !params.quoteOrderQty) {
      throw new BinanceApiError("委托必须提供 quantity 或 quoteOrderQty。");
    }
    if ((type.includes("STOP") || type.includes("TAKE_PROFIT")) && !params.stopPrice && !params.trailingDelta) {
      throw new BinanceApiError(`${type} 委托必须提供 stopPrice 或 trailingDelta。`);
    }

    if (!new Set(["LIMIT", "LIMIT_MAKER", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"]).has(type)) {
      delete params.price;
    }
    if (!type.includes("STOP") && !type.includes("TAKE_PROFIT")) {
      delete params.stopPrice;
      delete params.trailingDelta;
    }

    const adjustments = [];
    if (params.price && filters.PRICE_FILTER) {
      const original = params.price;
      params.price = this.alignToStep(params.price, filters.PRICE_FILTER.tickSize);
      this.assertFilterRange("price", params.price, filters.PRICE_FILTER.minPrice, filters.PRICE_FILTER.maxPrice);
      if (original !== params.price) adjustments.push(`price: ${original} -> ${params.price}`);
    }
    if (params.stopPrice && filters.PRICE_FILTER) {
      const original = params.stopPrice;
      params.stopPrice = this.alignToStep(params.stopPrice, filters.PRICE_FILTER.tickSize);
      this.assertFilterRange("stopPrice", params.stopPrice, filters.PRICE_FILTER.minPrice, filters.PRICE_FILTER.maxPrice);
      if (original !== params.stopPrice) adjustments.push(`stopPrice: ${original} -> ${params.stopPrice}`);
    }
    if (params.quantity && quantityFilter) {
      const original = params.quantity;
      params.quantity = this.alignToStep(params.quantity, quantityFilter.stepSize);
      this.assertFilterRange("quantity", params.quantity, quantityFilter.minQty, quantityFilter.maxQty);
      if (original !== params.quantity) adjustments.push(`quantity: ${original} -> ${params.quantity}`);
    }
    if (params.icebergQty && filters.LOT_SIZE) {
      const original = params.icebergQty;
      params.icebergQty = this.alignToStep(params.icebergQty, filters.LOT_SIZE.stepSize);
      this.assertFilterRange("icebergQty", params.icebergQty, filters.LOT_SIZE.minQty, filters.LOT_SIZE.maxQty);
      if (Number(params.icebergQty) > Number(params.quantity || 0)) {
        throw new BinanceApiError("icebergQty 不能大于订单 quantity。");
      }
      if (original !== params.icebergQty) adjustments.push(`icebergQty: ${original} -> ${params.icebergQty}`);
    }

    if (params.price) {
      const average = await this.request("GET", "/v3/avgPrice", { symbol });
      const referencePrice = Number(average.price);
      const percentBySide = filters.PERCENT_PRICE_BY_SIDE;
      const percentPrice = filters.PERCENT_PRICE;
      if (percentBySide && referencePrice > 0) {
        const upper = referencePrice * Number(side === "BUY" ? percentBySide.bidMultiplierUp : percentBySide.askMultiplierUp);
        const lower = referencePrice * Number(side === "BUY" ? percentBySide.bidMultiplierDown : percentBySide.askMultiplierDown);
        this.assertFilterRange("price", params.price, lower, upper);
      } else if (percentPrice && referencePrice > 0) {
        this.assertFilterRange("price", params.price, referencePrice * Number(percentPrice.multiplierDown), referencePrice * Number(percentPrice.multiplierUp));
      }
    }

    const notional = params.price && params.quantity
      ? Number(params.price) * Number(params.quantity)
      : Number(params.quoteOrderQty || 0);
    const notionalFilter = filters.NOTIONAL || filters.MIN_NOTIONAL;
    if (notional > 0 && notionalFilter) {
      this.assertFilterRange(
        "订单金额",
        notional,
        notionalFilter.minNotional,
        notionalFilter.maxNotional
      );
    }

    return { params, adjustments, symbolInfo };
  }

  async placeOrder(order, { testOnly = false } = {}) {
    const { params, adjustments, symbolInfo } = await this.prepareOrder(order);
    this.assertTradingCredentials();
    await this.syncTradingServerTime();
    await this.validateAvailableBalance(params, symbolInfo);
    const result = await this.request(
      "POST",
      testOnly ? "/v3/order/test" : "/v3/order",
      params,
      true,
      this.tradingRestBase
    );
    return { ...result, testOnly, adjustments };
  }

  async validateAvailableBalance(params, symbolInfo) {
    const account = await this.accountStatus({ omitZeroBalances: false });
    const balances = Object.fromEntries(
      (account.balances || []).map((balance) => [balance.asset, Number(balance.free)])
    );
    const baseAsset = symbolInfo.baseAsset;
    const quoteAsset = symbolInfo.quoteAsset;

    if (params.side === "SELL") {
      const required = Number(params.quantity || 0);
      const available = balances[baseAsset] || 0;
      if (required > available) {
        throw new BinanceApiError(
          `${baseAsset} 可用余额不足：需要 ${required}，当前可用 ${available}。`
        );
      }
      return { asset: baseAsset, required, available };
    }

    let required = Number(params.quoteOrderQty || 0);
    if (!required) {
      let referencePrice = Number(params.price || params.stopPrice || 0);
      if (!referencePrice) {
        const ticker = await this.request("GET", "/v3/ticker/price", {
          symbol: params.symbol,
        });
        referencePrice = Number(ticker.price);
      }
      required = referencePrice * Number(params.quantity || 0);
    }
    const available = balances[quoteAsset] || 0;
    if (required > available) {
      throw new BinanceApiError(
        `${quoteAsset} 可用余额不足：预计需要 ${required}，当前可用 ${available}。`
      );
    }
    return { asset: quoteAsset, required, available };
  }

  async cancelOrder({ symbol, orderId, origClientOrderId }) {
    const params = {
      symbol: this.validateSymbol(symbol),
      orderId,
      origClientOrderId,
    };

    if (!orderId && !origClientOrderId) {
      throw new BinanceApiError(
        "撤单必须提供 orderId 或 origClientOrderId。"
      );
    }

    this.assertTradingCredentials();
    await this.syncTradingServerTime();

    return this.request(
      "DELETE",
      "/v3/order",
      params,
      true,
      this.tradingRestBase
    );
  }

  async signedRest(method, path, params = {}) {
    this.assertTradingCredentials();
    await this.syncTradingServerTime();
    return this.request(
      method,
      path,
      params,
      true,
      this.tradingRestBase
    );
  }

  async queryOrder({ symbol, orderId, origClientOrderId }) {
    if (!orderId && !origClientOrderId) {
      throw new BinanceApiError("查询单笔订单必须提供 orderId 或 origClientOrderId。");
    }
    return this.signedRest("GET", "/v3/order", {
      symbol: this.validateSymbol(symbol),
      orderId,
      origClientOrderId,
    });
  }

  async openOrders({ symbol } = {}) {
    return this.signedRest("GET", "/v3/openOrders", {
      symbol: symbol ? this.validateSymbol(symbol) : undefined,
    });
  }

  async cancelAllOpenOrders({ symbol }) {
    return this.signedRest("DELETE", "/v3/openOrders", {
      symbol: this.validateSymbol(symbol),
    });
  }

  async amendOrder({ symbol, orderId, origClientOrderId, newQty, newClientOrderId }) {
    if (!orderId && !origClientOrderId) {
      throw new BinanceApiError("修改订单必须提供 orderId 或 origClientOrderId。");
    }
    if (!newQty || Number(newQty) <= 0) {
      throw new BinanceApiError("修改订单必须提供大于 0 的 newQty。");
    }

    const info = await this.exchangeInfo(symbol);
    const lotSize = info.symbol?.filters?.find((filter) => filter.filterType === "LOT_SIZE");
    const alignedQty = lotSize
      ? this.alignToStep(newQty, lotSize.stepSize)
      : String(newQty);
    return this.signedRest("PUT", "/v3/order/amend/keepPriority", {
      symbol: this.validateSymbol(symbol),
      orderId,
      origClientOrderId,
      newQty: alignedQty,
      newClientOrderId,
    });
  }

  async cancelReplace({
    cancelOrderId,
    cancelOrigClientOrderId,
    cancelReplaceMode = "STOP_ON_FAILURE",
    ...order
  }) {
    if (!cancelOrderId && !cancelOrigClientOrderId) {
      throw new BinanceApiError("撤单重报必须提供原订单 ID。");
    }
    const { params, adjustments } = await this.prepareOrder(order);
    const result = await this.signedRest("POST", "/v3/order/cancelReplace", {
      ...params,
      cancelReplaceMode,
      cancelOrderId,
      cancelOrigClientOrderId,
    });
    return { ...result, adjustments };
  }

  async accountRateLimits() {
    return this.signedRest("GET", "/v3/rateLimit/order");
  }

  async accountCommission({ symbol }) {
    return this.signedRest("GET", "/v3/account/commission", {
      symbol: this.validateSymbol(symbol),
    });
  }

  async queryOrderList({ orderListId, origClientOrderId }) {
    if (!orderListId && !origClientOrderId) {
      throw new BinanceApiError("查询组合订单必须提供 orderListId 或 origClientOrderId。");
    }
    return this.signedRest("GET", "/v3/orderList", {
      orderListId,
      origClientOrderId,
    });
  }

  async openOrderLists() {
    return this.signedRest("GET", "/v3/openOrderList");
  }

  async cancelOrderList({ symbol, orderListId, listClientOrderId }) {
    if (!orderListId && !listClientOrderId) {
      throw new BinanceApiError("撤销组合订单必须提供 orderListId 或 listClientOrderId。");
    }
    return this.signedRest("DELETE", "/v3/orderList", {
      symbol: this.validateSymbol(symbol),
      orderListId,
      listClientOrderId,
    });
  }

  async placeOco({
    symbol,
    side,
    quantity,
    abovePrice,
    aboveStopPrice,
    belowPrice,
    belowStopPrice,
  }) {
    const normalizedSide = String(side || "").toUpperCase();
    if (!["BUY", "SELL"].includes(normalizedSide)) {
      throw new BinanceApiError("OCO 的 side 必须是 BUY 或 SELL。");
    }
    if (!quantity || !abovePrice || !belowPrice) {
      throw new BinanceApiError("OCO 必须提供数量、上方价格和下方价格。");
    }
    if (normalizedSide === "SELL" && !belowStopPrice) {
      throw new BinanceApiError("SELL OCO 必须提供下方触发价。");
    }
    if (normalizedSide === "BUY" && !aboveStopPrice) {
      throw new BinanceApiError("BUY OCO 必须提供上方触发价。");
    }

    const info = await this.exchangeInfo(symbol);
    const filters = Object.fromEntries(
      (info.symbol?.filters || []).map((filter) => [filter.filterType, filter])
    );
    const alignedQuantity = filters.LOT_SIZE
      ? this.alignToStep(quantity, filters.LOT_SIZE.stepSize)
      : String(quantity);
    const alignPrice = (value) => filters.PRICE_FILTER
      ? this.alignToStep(value, filters.PRICE_FILTER.tickSize)
      : String(value);

    const sideSpecificParams = normalizedSide === "SELL"
      ? {
          aboveType: "LIMIT_MAKER",
          abovePrice: alignPrice(abovePrice),
          belowType: "STOP_LOSS_LIMIT",
          belowPrice: alignPrice(belowPrice),
          belowStopPrice: alignPrice(belowStopPrice),
          belowTimeInForce: "GTC",
        }
      : {
          aboveType: "STOP_LOSS_LIMIT",
          abovePrice: alignPrice(abovePrice),
          aboveStopPrice: alignPrice(aboveStopPrice),
          aboveTimeInForce: "GTC",
          belowType: "LIMIT_MAKER",
          belowPrice: alignPrice(belowPrice),
        };

    return this.signedRest("POST", "/v3/orderList/oco", {
      symbol: this.validateSymbol(symbol),
      side: normalizedSide,
      quantity: alignedQuantity,
      ...sideSpecificParams,
      newOrderRespType: "RESULT",
    });
  }

  async placeOto({
    symbol,
    workingSide,
    workingPrice,
    workingQuantity,
    pendingSide,
    pendingPrice,
    pendingQuantity,
  }) {
    if (!workingPrice || !workingQuantity || !pendingPrice || !pendingQuantity) {
      throw new BinanceApiError("OTO 必须提供工作单和待触发单的价格与数量。");
    }
    const info = await this.exchangeInfo(symbol);
    const filters = Object.fromEntries((info.symbol?.filters || []).map((filter) => [filter.filterType, filter]));
    const alignPrice = (value) => filters.PRICE_FILTER ? this.alignToStep(value, filters.PRICE_FILTER.tickSize) : String(value);
    const alignQty = (value) => filters.LOT_SIZE ? this.alignToStep(value, filters.LOT_SIZE.stepSize) : String(value);
    return this.signedRest("POST", "/v3/orderList/oto", {
      symbol: this.validateSymbol(symbol),
      workingType: "LIMIT",
      workingSide: String(workingSide).toUpperCase(),
      workingPrice: alignPrice(workingPrice),
      workingQuantity: alignQty(workingQuantity),
      workingTimeInForce: "GTC",
      pendingType: "LIMIT",
      pendingSide: String(pendingSide).toUpperCase(),
      pendingPrice: alignPrice(pendingPrice),
      pendingQuantity: alignQty(pendingQuantity),
      pendingTimeInForce: "GTC",
      newOrderRespType: "RESULT",
    });
  }

  async placeOtoco({
    symbol,
    workingSide,
    workingPrice,
    workingQuantity,
    pendingSide,
    pendingQuantity,
    pendingAbovePrice,
    pendingBelowPrice,
    pendingBelowStopPrice,
  }) {
    const required = [workingPrice, workingQuantity, pendingQuantity, pendingAbovePrice, pendingBelowPrice, pendingBelowStopPrice];
    if (required.some((value) => !value)) {
      throw new BinanceApiError("OTOCO 的工作单及待触发 OCO 价格、数量必须填写完整。");
    }
    const info = await this.exchangeInfo(symbol);
    const filters = Object.fromEntries((info.symbol?.filters || []).map((filter) => [filter.filterType, filter]));
    const alignPrice = (value) => filters.PRICE_FILTER ? this.alignToStep(value, filters.PRICE_FILTER.tickSize) : String(value);
    const alignQty = (value) => filters.LOT_SIZE ? this.alignToStep(value, filters.LOT_SIZE.stepSize) : String(value);
    return this.signedRest("POST", "/v3/orderList/otoco", {
      symbol: this.validateSymbol(symbol),
      workingType: "LIMIT",
      workingSide: String(workingSide).toUpperCase(),
      workingPrice: alignPrice(workingPrice),
      workingQuantity: alignQty(workingQuantity),
      workingTimeInForce: "GTC",
      pendingSide: String(pendingSide).toUpperCase(),
      pendingQuantity: alignQty(pendingQuantity),
      pendingAboveType: "LIMIT_MAKER",
      pendingAbovePrice: alignPrice(pendingAbovePrice),
      pendingBelowType: "STOP_LOSS_LIMIT",
      pendingBelowPrice: alignPrice(pendingBelowPrice),
      pendingBelowStopPrice: alignPrice(pendingBelowStopPrice),
      pendingBelowTimeInForce: "GTC",
      newOrderRespType: "RESULT",
    });
  }

  createWsApiSignature(params) {
    const payload = Object.entries(params)
      .filter(([key]) => key !== "signature")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");

    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(payload)
      .digest("hex");
  }

  requestWsApi(
    method,
    params,
    {
      url = this.wsApiBase,
    } = {}
  ) {

    return new Promise((resolve, reject) => {
      let socket;
      let settled = false;
      let timeoutId;

      const finish = (callback, value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);

        if (socket) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1000, "request complete");
          } else if (socket.readyState === WebSocket.CONNECTING) {
            socket.terminate();
          }
        }

        callback(value);
      };

      try {
        socket = new WebSocket(url);
      } catch (error) {
        finish(
          reject,
          new BinanceApiError(`Binance WebSocket API 连接失败：${error.message}`, {
            data: { cause: error.name, url },
          })
        );
        return;
      }

      timeoutId = setTimeout(() => {
        finish(
          reject,
          new BinanceApiError("Binance WebSocket API 请求超时。", {
            data: { method, url },
          })
        );
      }, 15_000);

      socket.on("open", () => {
        try {
          socket.send(
            JSON.stringify({
              id: crypto.randomUUID(),
              method,
              params,
            })
          );
        } catch (error) {
          finish(
            reject,
            new BinanceApiError(
              `Binance WebSocket API 请求发送失败：${error.message}`,
              { data: { cause: error.name, url } }
            )
          );
        }
      });

      socket.on("message", (buffer) => {
        let message;

        try {
          message = JSON.parse(buffer.toString());
        } catch (error) {
          finish(
            reject,
            new BinanceApiError(
              `Binance WebSocket API 响应解析失败：${error.message}`,
              { data: { cause: error.name, url } }
            )
          );
          return;
        }

        if (
          message.error ||
          (message.status !== undefined &&
            (message.status < 200 || message.status >= 300))
        ) {
          const apiError = message.error || {};
          finish(
            reject,
            new BinanceApiError(
              apiError.msg || `Binance WebSocket API HTTP ${message.status}`,
              {
                status: message.status,
                code: apiError.code,
                data: message,
              }
            )
          );
          return;
        }

        finish(resolve, message.result);
      });

      socket.on("error", (error) => {
        finish(
          reject,
          new BinanceApiError(`请求 Binance WebSocket API 失败：${error.message}`, {
            data: { cause: error.name, url },
          })
        );
      });

      socket.on("close", (code, reasonBuffer) => {
        if (settled) {
          return;
        }

        const reason = reasonBuffer?.toString() || "";
        finish(
          reject,
          new BinanceApiError("Binance WebSocket API 连接已关闭。", {
            data: { code, reason, url },
          })
        );
      });
    });
  }

  async allOrders({ symbol, orderId, startTime, endTime, limit = 100 } = {}) {
    const normalizedSymbol = this.validateSymbol(symbol);
    this.assertTradingCredentials();

    const { offsetMs } = await this.syncTradingServerTime();
    const params = this.normalizeParams({
      symbol: normalizedSymbol,
      orderId,
      startTime,
      endTime,
      limit,
      recvWindow: 5_000,
      apiKey: this.apiKey,
      timestamp: Date.now() + offsetMs,
    });

    params.signature = this.createWsApiSignature(params);
    return this.requestWsApi("allOrders", params, {
      url: this.tradingWsApiBase,
    });
  }

  async myTrades({
    symbol,
    orderId,
    startTime,
    endTime,
    fromId,
    limit = 100,
  } = {}) {
    const normalizedSymbol = this.validateSymbol(symbol);
    this.assertTradingCredentials();

    const timeBase = this.tradingRestBase;
    const { offsetMs } = await this.syncServerTimeForBase(timeBase);
    const params = this.normalizeParams({
      symbol: normalizedSymbol,
      orderId,
      startTime,
      endTime,
      fromId,
      limit,
      recvWindow: 5_000,
      apiKey: this.apiKey,
      timestamp: Date.now() + offsetMs,
    });

    params.signature = this.createWsApiSignature(params);
    return this.requestWsApi("myTrades", params);
  }

  async accountStatus({ omitZeroBalances } = {}) {
    this.assertTradingCredentials();

    const timeBase = this.tradingRestBase;
    const { offsetMs } = await this.syncServerTimeForBase(timeBase);
    const params = {
      ...(omitZeroBalances === undefined
        ? {}
        : { omitZeroBalances: Boolean(omitZeroBalances) }),
      recvWindow: "5000",
      apiKey: this.apiKey,
      timestamp: String(Date.now() + offsetMs),
    };

    params.signature = this.createWsApiSignature(params);
    return this.requestWsApi("account.status", params);
  }

  async allOrderLists({ fromId, startTime, endTime, limit = 100 } = {}) {
    this.assertTradingCredentials();

    const timeBase = this.tradingRestBase;
    const { offsetMs } = await this.syncServerTimeForBase(timeBase);
    const params = this.normalizeParams({
      fromId,
      startTime,
      endTime,
      limit,
      recvWindow: 5_000,
      apiKey: this.apiKey,
      timestamp: Date.now() + offsetMs,
    });

    params.signature = this.createWsApiSignature(params);
    return this.requestWsApi("allOrderLists", params);
  }

  async connectUserData() {
    this.assertTradingCredentials();
    if (this.userDataSocket?.readyState === WebSocket.OPEN && this.userDataSubscriptionId !== null) {
      const result = { subscriptionId: this.userDataSubscriptionId, reused: true };
      this.emit("user-data-status", {
        status: "connected",
        ...result,
        time: Date.now(),
      });
      return result;
    }

    this.disconnectUserData(true);
    this.userDataManualClose = false;
    this.userDataReconnectDelayMs = 1_000;
    return this.openUserDataSocket();
  }

  async openUserDataSocket() {
    const { offsetMs } = await this.syncTradingServerTime();
    const requestId = crypto.randomUUID();
    const params = this.normalizeParams({
      apiKey: this.apiKey,
      recvWindow: 5_000,
      timestamp: Date.now() + offsetMs,
    });
    params.signature = this.createWsApiSignature(params);

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsApiBase);
      let subscribed = false;
      let timeoutId = setTimeout(() => {
        if (!subscribed) {
          reject(new BinanceApiError("账户事件订阅超时。"));
          socket.terminate();
        }
      }, 15_000);

      this.userDataSocket = socket;
      this.emit("user-data-status", {
        status: "connecting",
        url: this.wsApiBase,
        time: Date.now(),
      });

      socket.on("open", () => {
        socket.send(JSON.stringify({
          id: requestId,
          method: "userDataStream.subscribe.signature",
          params,
        }));
      });

      socket.on("message", (buffer) => {
        let message;
        try {
          message = JSON.parse(buffer.toString());
        } catch (error) {
          this.emit("user-data-error", {
            message: `账户事件解析失败：${error.message}`,
            time: Date.now(),
          });
          return;
        }

        if (message.id === requestId) {
          if (message.error || (message.status && message.status >= 400)) {
            const apiError = message.error || {};
            clearTimeout(timeoutId);
            reject(new BinanceApiError(apiError.msg || "账户事件订阅失败。", {
              status: message.status,
              code: apiError.code,
              data: message,
            }));
            this.userDataManualClose = true;
            socket.close(1000, "subscription rejected");
            return;
          }

          subscribed = true;
          clearTimeout(timeoutId);
          this.userDataSubscriptionId = message.result?.subscriptionId ?? null;
          this.userDataReconnectDelayMs = 1_000;
          const result = { subscriptionId: this.userDataSubscriptionId };
          this.emit("user-data-status", {
            status: "connected",
            ...result,
            time: Date.now(),
          });
          resolve(result);
          return;
        }

        if (message.event) {
          this.emit("user-data-event", {
            subscriptionId: message.subscriptionId,
            event: message.event,
            receivedAt: Date.now(),
          });
        }
      });

      socket.on("error", (error) => {
        this.emit("user-data-error", {
          message: error.message,
          time: Date.now(),
        });
        if (!subscribed) {
          clearTimeout(timeoutId);
          reject(new BinanceApiError(`账户事件连接失败：${error.message}`));
        }
      });

      socket.on("close", (code, reasonBuffer) => {
        clearTimeout(timeoutId);
        if (this.userDataSocket !== socket) return;
        this.userDataSocket = null;
        this.userDataSubscriptionId = null;
        const reason = reasonBuffer?.toString() || "";
        this.emit("user-data-status", {
          status: this.userDataManualClose ? "disconnected" : "reconnecting",
          code,
          reason,
          time: Date.now(),
        });
        if (!this.userDataManualClose) {
          this.scheduleUserDataReconnect();
        }
      });
    });
  }

  scheduleUserDataReconnect() {
    clearTimeout(this.userDataReconnectTimer);
    const delay = this.userDataReconnectDelayMs;
    this.userDataReconnectDelayMs = Math.min(delay * 2, 30_000);
    this.userDataReconnectTimer = setTimeout(() => {
      this.openUserDataSocket().catch((error) => {
        this.emit("user-data-error", { message: error.message, time: Date.now() });
      });
    }, delay);
  }

  disconnectUserData(manual = true) {
    this.userDataManualClose = manual;
    clearTimeout(this.userDataReconnectTimer);
    this.userDataReconnectTimer = null;
    this.userDataSubscriptionId = null;

    if (this.userDataSocket) {
      const socket = this.userDataSocket;
      this.userDataSocket = null;
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "client disconnect");
      } else {
        socket.terminate();
      }
    }

    return { disconnected: true };
  }

  connectDepth(symbol) {
    const normalizedSymbol = this.validateSymbol(symbol);
    this.disconnectMarket();

    this.marketSymbol = normalizedSymbol;
    this.marketManualClose = false;
    this.marketReconnectDelayMs = 1_000;
    this.tradeReconnectDelayMs = 1_000;

    this.openDepthSocket();
    this.openTradeSocket();

    return {
      symbol: normalizedSymbol,
      stream: `${normalizedSymbol.toLowerCase()}@depth@${this.depthSpeed}`,
      snapshotLimit: this.depthSnapshotLimit,
      displayLevels: this.depthDisplayLevels,
    };
  }

  resetDepthState() {
    this.depthReady = false;
    this.depthEventBuffer = [];
    this.orderBook.clear();
    this.depthSyncVersion += 1;
  }

  openTradeSocket() {
    if (!this.marketSymbol || this.marketManualClose) {
      return;
    }

    const symbol = this.marketSymbol;
    const url = `${this.wsBase}/${symbol.toLowerCase()}@trade`;
    const socket = new WebSocket(url);
    this.tradeSocket = socket;

    socket.on("open", () => {
      if (this.tradeSocket === socket) {
        this.tradeReconnectDelayMs = 1_000;
      }
    });

    socket.on("message", (buffer) => {
      if (this.tradeSocket !== socket) {
        return;
      }

      try {
        const message = JSON.parse(buffer.toString());

        if (message.e !== "trade") {
          return;
        }

        this.emit("trade-update", {
          symbol: message.s || symbol,
          price: String(message.p),
          quantity: String(message.q),
          tradeId: Number(message.t),
          eventTime: Number(message.E),
          tradeTime: Number(message.T),
          receivedAt: Date.now(),
        });
      } catch (error) {
        this.emit("market-error", {
          message: `成交行情 JSON 解析失败：${error.message}`,
          symbol,
          time: Date.now(),
        });
      }
    });

    socket.on("error", (error) => {
      this.emit("market-error", {
        message: `成交行情连接失败：${error.message}`,
        symbol,
        time: Date.now(),
      });
    });

    socket.on("close", () => {
      if (this.tradeSocket === socket) {
        this.tradeSocket = null;
      }

      if (!this.marketManualClose && this.marketSymbol === symbol) {
        this.scheduleTradeReconnect();
      }
    });
  }

  openDepthSocket() {
    if (!this.marketSymbol || this.marketManualClose) {
      return;
    }

    const symbol = this.marketSymbol;
    const streamName = `${symbol.toLowerCase()}@depth@${this.depthSpeed}`;
    const url = `${this.wsBase}/${streamName}`;
    const socket = new WebSocket(url);

    this.marketSocket = socket;
    this.resetDepthState();

    socket.on("open", () => {
      if (this.marketSocket !== socket) {
        return;
      }

      this.marketReconnectDelayMs = 1_000;
      this.emit("market-status", {
        status: "synchronizing",
        symbol,
        url,
        time: Date.now(),
      });

      this.synchronizeDepthSnapshot(socket, symbol).catch((error) => {
        this.handleDepthSynchronizationFailure(socket, error);
      });
    });

    socket.on("message", (buffer) => {
      if (this.marketSocket !== socket) {
        return;
      }

      let message;

      try {
        message = JSON.parse(buffer.toString());
      } catch (error) {
        this.emit("market-error", {
          message: `行情 JSON 解析失败：${error.message}`,
          time: Date.now(),
        });
        return;
      }

      if (message.e === "serverShutdown") {
        this.emit("market-status", {
          status: "server-shutdown",
          symbol,
          eventTime: message.E,
          time: Date.now(),
        });
        return;
      }

      if (message.e !== "depthUpdate") {
        return;
      }
      // console.log(message)
      this.handleDepthEvent(socket, message);
    });

    socket.on("error", (error) => {
      this.emit("market-error", {
        message: error.message,
        symbol,
        time: Date.now(),
      });
    });

    socket.on("close", (code, reasonBuffer) => {
      if (this.marketSocket === socket) {
        this.marketSocket = null;
      }

      this.depthReady = false;
      const reason = reasonBuffer?.toString() || "";

      this.emit("market-status", {
        status: this.marketManualClose ? "disconnected" : "reconnecting",
        symbol,
        code,
        reason,
        time: Date.now(),
      });

      if (!this.marketManualClose) {
        this.scheduleMarketReconnect();
      }
    });
  }

  handleDepthEvent(socket, event) {
    if (this.marketSocket !== socket) {
      return;
    }

    if (!this.depthReady) {
      this.depthEventBuffer.push(event);

      if (this.depthEventBuffer.length > 20_000) {
        this.handleDepthSynchronizationFailure(
          socket,
          new BinanceApiError("深度增量缓存超过 20000 条，主动重新连接。")
        );
      }
      return;
    }

    let result;
    try {
      result = this.orderBook.applyEvent(event);
    } catch (error) {
    
      this.handleDepthSynchronizationFailure(socket, error);
      return;
    }
    if (result.reason === "sequence-gap") {
      this.resynchronizeDepth(socket, event, result);
      return;
    }
    
    if (result.applied) {
      this.emitDepthUpdate(event);
    }
  }

  async synchronizeDepthSnapshot(socket, symbol) {
    const syncVersion = this.depthSyncVersion;

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const snapshot = await this.request("GET", "/v3/depth", {
        symbol,
        limit: this.depthSnapshotLimit,
      });

      if (!this.isActiveDepthSync(socket, symbol, syncVersion)) {
        return;
      }

      const snapshotUpdateId = Number(snapshot.lastUpdateId);
      const firstBufferedEvent = this.depthEventBuffer[0];

      // 按官方流程：快照 updateId 仍早于首条缓存事件 U 时重新取快照。
      if (
        firstBufferedEvent &&
        snapshotUpdateId < Number(firstBufferedEvent.U)
      ) {
        continue;
      }

      const applicableEvents = this.depthEventBuffer.filter(
        (event) => Number(event.u) > snapshotUpdateId
      );

      const firstApplicableEvent = applicableEvents[0];
      if (
        firstApplicableEvent &&
        !(
          Number(firstApplicableEvent.U) <= snapshotUpdateId &&
          snapshotUpdateId <= Number(firstApplicableEvent.u)
        )
      ) {
        continue;
      }

      this.orderBook.loadSnapshot({
        symbol,
        lastUpdateId: snapshotUpdateId,
        bids: snapshot.bids,
        asks: snapshot.asks,
      });

      for (const event of applicableEvents) {
        const result = this.orderBook.applyEvent(event);

        if (result.reason === "sequence-gap") {
          throw new BinanceApiError("深度快照与增量事件之间存在序号缺口。", {
            data: result,
          });
        }
      }

      this.depthEventBuffer = [];
      this.depthReady = true;

      this.emit("market-status", {
        status: "connected",
        symbol,
        lastUpdateId: this.orderBook.lastUpdateId,
        snapshotLimit: this.depthSnapshotLimit,
        bufferedEvents: applicableEvents.length,
        time: Date.now(),
      });

      this.emitDepthUpdate(
        applicableEvents[applicableEvents.length - 1] || null
      );
      return;
    }

    throw new BinanceApiError(
      "连续 8 次无法将 REST 深度快照与 WebSocket 增量序号衔接。"
    );
  }

  isActiveDepthSync(socket, symbol, syncVersion) {
    return (
      this.marketSocket === socket &&
      this.marketSymbol === symbol &&
      !this.marketManualClose &&
      this.depthSyncVersion === syncVersion
    );
  }

  resynchronizeDepth(socket, event, gapDetails) {
    if (this.marketSocket !== socket) {
      return;
    }

    this.depthReady = false;
    this.depthEventBuffer = [event];
    this.orderBook.clear();
    this.depthSyncVersion += 1;

    this.emit("market-status", {
      status: "resynchronizing",
      symbol: this.marketSymbol,
      reason: "sequence-gap",
      details: gapDetails,
      time: Date.now(),
    });

    this.synchronizeDepthSnapshot(socket, this.marketSymbol).catch((error) => {
      this.handleDepthSynchronizationFailure(socket, error);
    });
  }

  handleDepthSynchronizationFailure(socket, error) {
    if (this.marketSocket !== socket) {
      return;
    }

    this.emit("market-error", {
      message: `深度订单簿同步失败：${error.message}`,
      symbol: this.marketSymbol,
      data: error.data,
      time: Date.now(),
    });

    socket.close(1011, "depth synchronization failed");
  }

  emitDepthUpdate(sourceEvent) {
    const top = this.orderBook.getTopLevels(this.depthDisplayLevels);

    this.emit("depth-update", {
      symbol: this.marketSymbol,
      lastUpdateId: this.orderBook.lastUpdateId,
      firstUpdateId: sourceEvent ? Number(sourceEvent.U) : null,
      finalUpdateId: sourceEvent ? Number(sourceEvent.u) : null,
      eventTime: sourceEvent?.E ?? null,
      receivedAt: Date.now(),
      bids: top.bids,
      asks: top.asks,
    });
  }

  scheduleMarketReconnect() {
    clearTimeout(this.marketReconnectTimer);

    const delay = this.marketReconnectDelayMs;
    this.marketReconnectDelayMs = Math.min(
      this.marketReconnectDelayMs * 2,
      30_000
    );

    this.marketReconnectTimer = setTimeout(() => {
      this.openDepthSocket();
    }, delay);
  }

  scheduleTradeReconnect() {
    clearTimeout(this.tradeReconnectTimer);

    const delay = this.tradeReconnectDelayMs;
    this.tradeReconnectDelayMs = Math.min(
      this.tradeReconnectDelayMs * 2,
      30_000
    );

    this.tradeReconnectTimer = setTimeout(() => {
      this.openTradeSocket();
    }, delay);
  }

  disconnectMarket() {
    this.marketManualClose = true;
    clearTimeout(this.marketReconnectTimer);
    this.marketReconnectTimer = null;
    clearTimeout(this.tradeReconnectTimer);
    this.tradeReconnectTimer = null;
    this.depthSyncVersion += 1;
    this.depthReady = false;
    this.depthEventBuffer = [];
    this.orderBook.clear();

    if (this.marketSocket) {
      const socket = this.marketSocket;
      this.marketSocket = null;
      socket.removeAllListeners();
      socket.close(1000, "client disconnect");
    }

    if (this.tradeSocket) {
      const socket = this.tradeSocket;
      this.tradeSocket = null;
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "client disconnect");
      } else {
        socket.terminate();
      }
    }

    this.emit("market-status", {
      status: "disconnected",
      symbol: this.marketSymbol,
      time: Date.now(),
    });

    this.marketSymbol = null;
  }

  close() {
    this.disconnectMarket();
    this.disconnectUserData();
    this.removeAllListeners();
  }
}

module.exports = {
  BinanceSpotClient,
  BinanceApiError,
};
