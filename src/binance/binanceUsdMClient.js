const { execFile } = require("node:child_process");
const https = require("node:https");
const { performance } = require("node:perf_hooks");
const { promisify } = require("node:util");
const WebSocket = require("ws");
const { resolveCurlExecutable } = require("../platformSupport");
const {
  BinanceClientBase,
  BinanceApiError,
} = require("./binanceClientBase");
const {
  divideDecimalToStep,
  isPositiveDecimal,
  multiplyDecimal,
  parseDecimal,
} = require("./decimalMath");

const FUTURES_REST_BASE = {
  testnet: "https://testnet.binancefuture.com",
  production: "https://fapi.binance.com",
};

const FUTURES_WS_BASE = {
  testnet: "wss://stream.binancefuture.com/ws",
  production: "wss://fstream.binance.com/public/ws",
};

const FUTURES_USER_DATA_WS_BASE = {
  testnet: "wss://stream.binancefuture.com/ws",
  production: "wss://fstream.binance.com/private/ws",
};

const FUTURES_WS_API_BASE = {
  testnet: "wss://testnet.binancefuture.com/ws-fapi/v1",
  production: "wss://ws-fapi.binance.com/ws-fapi/v1",
};

const FUTURES_REST_HOST = "fapi.binance.com";
const FUTURES_PUBLIC_REST_BASE = "https://d2ukl3c6tymv7q.cloudfront.net";
const POSITION_MODE_ONE_WAY = "ONE_WAY";
const POSITION_MODE_HEDGE = "HEDGE";
const execFileAsync = promisify(execFile);

const FUTURES_ALGO_ORDER_TYPES = new Set([
  "STOP",
  "STOP_MARKET",
  "TAKE_PROFIT",
  "TAKE_PROFIT_MARKET",
  "TRAILING_STOP_MARKET",
]);
const FUTURES_PRICE_MATCH_MODES = new Set([
  "OPPONENT",
  "OPPONENT_5",
  "OPPONENT_10",
  "OPPONENT_20",
  "QUEUE",
  "QUEUE_5",
  "QUEUE_10",
  "QUEUE_20",
]);

class BinanceUsdMClient extends BinanceClientBase {
  constructor(options = {}) {
    super(options);

    this.marketType = "futures";
    this.restBase = this.testnet
      ? FUTURES_REST_BASE.testnet
      : FUTURES_REST_BASE.production;
    this.tradingRestBase = this.testnet
      ? FUTURES_REST_BASE.testnet
      : FUTURES_REST_BASE.production;
    this.wsBase = this.testnet
      ? FUTURES_WS_BASE.testnet
      : FUTURES_WS_BASE.production;
    this.userDataWsBase = this.testnet
      ? FUTURES_USER_DATA_WS_BASE.testnet
      : FUTURES_USER_DATA_WS_BASE.production;
    this.wsApiBase = this.testnet
      ? FUTURES_WS_API_BASE.testnet
      : FUTURES_WS_API_BASE.production;
    this.tradingWsApiBase = this.wsApiBase;
    this.timePath = "/fapi/v1/time";
    this.pingPath = "/fapi/v1/ping";
    this.tickerPricePath = "/fapi/v1/ticker/price";
    this.supportsAveragePriceStream = false;

    this.exchangeInfoSnapshot = null;
    this.exchangeInfoSnapshotRefreshPromise = null;
    this.exchangeInfoSnapshotRefreshAttemptAt = 0;
    this.futuresListenKey = null;
    this.futuresListenKeyKeepAliveTimer = null;
    this.platform = options.platform || process.platform;
    this.publicMarketFetch = options.publicMarketFetch || null;
    this.publicMarketTransport = null;
    this.publicMarketTimeoutMs = Math.max(
      1_000,
      Number(options.publicMarketTimeoutMs) || 6_000
    );
    this.curlExecutable = options.curlExecutable || resolveCurlExecutable();
    this.executeFile = options.executeFile || execFileAsync;
    this.positionModeCache = null;
    this.positionModePromise = null;
    this.positionModeEnforcementPromise = null;
    this.knownAlgoOrderIds = new Set();
    this.knownAlgoClientOrderIds = new Set();
  }

  async initialize() {
    await super.initialize();
    if (this.apiKey && this.apiSecret) {
      this.preloadOneWayPositionMode();
    }
  }

  preloadOneWayPositionMode() {
    const promise = this.ensureOneWayPositionMode();
    promise.catch((error) => {
      this.emit("user-data-error", {
        marketType: this.marketType,
        message: `后台设置永续单向持仓模式失败：${error.message}`,
        time: Date.now(),
      });
    });
    return promise;
  }

  async getPositionMode({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.positionModeCache) {
      return this.positionModeCache;
    }
    if (this.positionModePromise) {
      return this.positionModePromise;
    }

    this.positionModePromise = (async () => {
      const result = await this.signedRest(
        "GET",
        "/fapi/v1/positionSide/dual"
      );
      const dualSidePosition = result?.dualSidePosition === true ||
        result?.dualSidePosition === "true";
      const positionMode = dualSidePosition
        ? POSITION_MODE_HEDGE
        : POSITION_MODE_ONE_WAY;
      this.positionModeCache = {
        dualSidePosition,
        positionMode,
        loadedAt: Date.now(),
      };
      return this.positionModeCache;
    })().finally(() => {
      this.positionModePromise = null;
    });

    return this.positionModePromise;
  }

  createPositionModeSwitchError(error) {
    const messages = {
      [-4067]: "当前账号存在 U 本位挂单，Binance 不允许切换为单向持仓；请先撤销所有 U 本位挂单。",
      [-4068]: "当前账号存在 U 本位持仓，Binance 不允许切换为单向持仓；请先平掉所有 U 本位持仓。",
    };
    return new BinanceApiError(
      messages[Number(error?.code)] ||
        `无法把 U 本位账号切换为单向持仓：${error.message}`,
      {
        status: error?.status,
        code: error?.code,
        data: error?.data,
      }
    );
  }

  async ensureOneWayPositionMode({ forceRefresh = false } = {}) {
    if (this.positionModeEnforcementPromise) {
      return this.positionModeEnforcementPromise;
    }

    this.positionModeEnforcementPromise = (async () => {
      const current = await this.getPositionMode({ forceRefresh });
      if (!current.dualSidePosition) return current;

      try {
        await this.signedRest("POST", "/fapi/v1/positionSide/dual", {
          dualSidePosition: "false",
        });
      } catch (error) {
        throw this.createPositionModeSwitchError(error);
      }

      this.positionModeCache = {
        dualSidePosition: false,
        positionMode: POSITION_MODE_ONE_WAY,
        loadedAt: Date.now(),
      };
      return this.positionModeCache;
    })().finally(() => {
      this.positionModeEnforcementPromise = null;
    });

    return this.positionModeEnforcementPromise;
  }

  async resolveOrderPositionSide(
    order,
    side,
    { forceRefresh = false } = {}
  ) {
    const explicitPositionSide = String(order.positionSide || "")
      .trim()
      .toUpperCase();
    if (
      explicitPositionSide &&
      !["BOTH", "LONG", "SHORT"].includes(explicitPositionSide)
    ) {
      throw new BinanceApiError(
        `positionSide 只支持 BOTH、LONG 或 SHORT，当前值：${explicitPositionSide}`
      );
    }
    if (explicitPositionSide && explicitPositionSide !== "BOTH") {
      throw new BinanceApiError(
        `程序已固定使用单向持仓，positionSide 不能使用 ${explicitPositionSide}。`
      );
    }
    const mode = await this.ensureOneWayPositionMode({ forceRefresh });
    return { ...mode, positionSide: "BOTH" };
  }

  isPositionSideMismatchError(error) {
    return Number(error?.code) === -4061 ||
      /position side does not match/i.test(error?.message || "");
  }

  async request(
    method,
    path,
    params = {},
    signed = false,
    baseUrl = this.restBase,
    requestOptions = {}
  ) {
    if (
      !this.testnet &&
      !signed &&
      String(method).toUpperCase() === "GET" &&
      path.startsWith("/fapi/v1/") &&
      baseUrl === this.restBase
    ) {
      return this.requestPublicMarketData(method, path, params);
    }
    return super.request(
      method,
      path,
      params,
      signed,
      baseUrl,
      requestOptions
    );
  }

  createPublicMarketUrl(baseUrl, path, params = {}) {
    const query = new URLSearchParams(this.normalizeParams(params)).toString();
    return `${baseUrl}${path}${query ? `?${query}` : ""}`;
  }

  parsePublicMarketResponse(statusCode, rawText) {
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { rawText };
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new BinanceApiError(data.msg || `Binance HTTP ${statusCode}`, {
        status: statusCode,
        code: data.code,
        data,
      });
    }
    return data;
  }

  getPublicMarketTransportOrder() {
    const defaultOrder = this.platform === "darwin"
      ? ["electron", "curl", "node"]
      : ["electron", "node", "curl"];
    const available = defaultOrder.filter(
      (transport) => transport !== "electron" || this.publicMarketFetch
    );
    if (!this.publicMarketTransport) return available;
    return [
      this.publicMarketTransport,
      ...available.filter((transport) => transport !== this.publicMarketTransport),
    ];
  }

  async requestPublicMarketData(method, path, params = {}) {
    this.guardRateLimit({
      operation: `${String(method).toUpperCase()} ${path}`,
      critical: false,
    });
    const failures = [];
    const transports = {
      electron: () => this.requestPublicMarketDataWithElectron(
        method,
        path,
        params
      ),
      node: () => this.requestPublicMarketDataWithNode(method, path, params),
      curl: () => this.requestPublicMarketDataWithCurl(method, path, params),
    };

    for (const transport of this.getPublicMarketTransportOrder()) {
      try {
        const data = await transports[transport]();
        this.publicMarketTransport = transport;
        return data;
      } catch (error) {
        if (error?.status) throw error;
        failures.push({
          transport,
          name: error?.name || "Error",
          message: error?.message || "未知错误",
          code: error?.data?.code || error?.code,
        });
      }
    }

    throw new BinanceApiError(
      `请求 Binance Futures 行情失败：${failures
        .map(({ transport, message }) => `${transport}: ${message}`)
        .join("；")}`,
      { data: { transports: failures } }
    );
  }

  async requestPublicMarketDataWithElectron(method, path, params = {}) {
    if (!this.publicMarketFetch) {
      throw new Error("Electron 原生网络传输不可用。");
    }

    const url = this.createPublicMarketUrl(
      FUTURES_REST_BASE.production,
      path,
      params
    );
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.publicMarketTimeoutMs);
    const requestStartedAt = performance.now();
    let latencyReported = false;
    try {
      const response = await this.publicMarketFetch(url, {
        method,
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const rawText = await response.text();
      this.emitApiLatency({
        operation: `${String(method).toUpperCase()} ${path}`,
        transport: "electron-net",
        startedAt: requestStartedAt,
        success: response.status >= 200 && response.status < 300,
        status: response.status,
      });
      this.observeRateLimit({
        headers: response.headers?.entries
          ? Object.fromEntries(response.headers.entries())
          : {},
        status: response.status,
      });
      latencyReported = true;
      return this.parsePublicMarketResponse(Number(response.status), rawText);
    } catch (error) {
      if (!latencyReported) {
        this.emitApiLatency({
          operation: `${String(method).toUpperCase()} ${path}`,
          transport: "electron-net",
          startedAt: requestStartedAt,
          success: false,
        });
      }
      if (error instanceof BinanceApiError) throw error;
      const message = controller.signal.aborted
        ? `Electron 原生网络请求超时（${this.publicMarketTimeoutMs} ms）`
        : error.message;
      throw new BinanceApiError(message, {
        data: { cause: error.name },
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  requestPublicMarketDataWithNode(method, path, params = {}) {
    return super.request(
      method,
      path,
      params,
      false,
      FUTURES_REST_BASE.production
    );
  }

  async requestPublicMarketDataWithCurl(method, path, params = {}) {
    if (String(method).toUpperCase() !== "GET" || !path.startsWith("/fapi/v1/")) {
      throw new BinanceApiError("Futures 直连后备仅允许读取官方公共行情接口。");
    }

    const url = this.createPublicMarketUrl(
      FUTURES_PUBLIC_REST_BASE,
      path,
      params
    );
    const curlArguments = [
      "--silent",
      "--show-error",
      "--connect-timeout",
      "5",
      "--max-time",
      "15",
      "--header",
      `Host: ${FUTURES_REST_HOST}`,
      "--header",
      "Accept: application/json",
      "--write-out",
      "\n__BINANCE_HTTP_STATUS__:%{http_code}",
      url,
    ];
    let stdout;
    let requestError;
    let successfulRequestStartedAt = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const attemptStartedAt = performance.now();
      try {
        ({ stdout } = await this.executeFile(
          this.curlExecutable,
          curlArguments,
          {
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
            timeout: 20_000,
            windowsHide: true,
          }
        ));
        successfulRequestStartedAt = attemptStartedAt;
        requestError = null;
        break;
      } catch (error) {
        this.emitApiLatency({
          operation: `${String(method).toUpperCase()} ${path}`,
          transport: "curl",
          startedAt: attemptStartedAt,
          success: false,
        });
        requestError = error;
        if (error.code === "ENOENT") break;
      }
    }

    if (requestError) {
      const message = requestError.code === "ENOENT"
        ? `系统找不到 curl 可执行文件（${this.curlExecutable}）；可通过 BINANCE_CURL_PATH 指定路径。`
        : requestError.stderr?.trim() || requestError.message;
      throw new BinanceApiError(
        `请求 Binance Futures 行情失败：${message}`,
        { data: { cause: requestError.name, code: requestError.code } }
      );
    }

    const marker = "\n__BINANCE_HTTP_STATUS__:";
    const markerIndex = stdout.lastIndexOf(marker);
    if (markerIndex < 0) {
      this.emitApiLatency({
        operation: `${String(method).toUpperCase()} ${path}`,
        transport: "curl",
        startedAt: successfulRequestStartedAt,
        success: false,
      });
      throw new BinanceApiError("Binance Futures 行情响应缺少 HTTP 状态。");
    }
    const rawText = stdout.slice(0, markerIndex);
    const statusCode = Number(stdout.slice(markerIndex + marker.length).trim());
    this.emitApiLatency({
      operation: `${String(method).toUpperCase()} ${path}`,
      transport: "curl",
      startedAt: successfulRequestStartedAt,
      success: statusCode >= 200 && statusCode < 300,
      status: statusCode,
    });
    return this.parsePublicMarketResponse(statusCode, rawText);
  }

  assertTradingCredentials() {
    if (!this.apiKey || !this.apiSecret) {
      throw new BinanceApiError(
        "缺少当前环境的 USDⓈ-M API Key 或 Secret；行情可连接，但不能查询账户、下单或撤单。"
      );
    }
  }

  createSignedWsApiParams(params = {}) {
    const signedParams = super.createSignedWsApiParams(params);
    delete signedParams.signature;
    signedParams.recvWindow = Number(signedParams.recvWindow);
    signedParams.timestamp = Number(signedParams.timestamp);
    signedParams.signature = this.createWsApiSignature(signedParams);
    return signedParams;
  }

  async exchangeInfo(symbol, { forceRefresh = false } = {}) {
    const normalizedSymbol = this.validateSymbol(symbol);
    const cached = this.exchangeInfoCache.get(normalizedSymbol);
    const cacheExpired = cached && Date.now() - cached.loadedAt >= 300_000;
    if (!forceRefresh && cached) {
      if (cacheExpired) this.refreshExchangeInfoSnapshotInBackground();
      return cached.data;
    }

    const snapshotExpired = this.exchangeInfoSnapshot &&
      Date.now() - this.exchangeInfoSnapshot.loadedAt >= 300_000;
    if (forceRefresh || !this.exchangeInfoSnapshot) {
      await this.refreshExchangeInfoSnapshot();
    } else if (snapshotExpired) {
      this.refreshExchangeInfoSnapshotInBackground();
    }

    let result = this.exchangeInfoSnapshot.data;
    let symbolInfo = (result.symbols || []).find(
      (item) => item.symbol === normalizedSymbol
    );
    // 旧快照里不存在的交易对可能是刚上线的合约，此时必须刷新一次确认。
    if (!symbolInfo && snapshotExpired && !forceRefresh) {
      await this.refreshExchangeInfoSnapshot();
      result = this.exchangeInfoSnapshot.data;
      symbolInfo = (result.symbols || []).find(
        (item) => item.symbol === normalizedSymbol
      );
    }
    if (!symbolInfo) {
      throw new BinanceApiError("Invalid symbol.", {
        status: 400,
        code: -1121,
        data: { code: -1121, msg: "Invalid symbol." },
      });
    }

    const data = {
      ...result,
      symbols: [symbolInfo],
      symbol: symbolInfo,
      marketType: this.marketType,
    };
    this.exchangeInfoCache.set(normalizedSymbol, {
      loadedAt: Date.now(),
      data,
    });
    return data;
  }

  refreshExchangeInfoSnapshotInBackground() {
    if (
      Date.now() - this.exchangeInfoSnapshotRefreshAttemptAt < 30_000
    ) {
      return this.exchangeInfoSnapshotRefreshPromise;
    }
    const promise = this.refreshExchangeInfoSnapshot();
    promise.catch((error) => {
      this.emit("market-error", {
        marketType: this.marketType,
        message: `永续交易规则后台刷新失败：${error.message}`,
        symbol: this.marketSymbol,
        time: Date.now(),
      });
    });
    return promise;
  }

  refreshExchangeInfoSnapshot() {
    if (this.exchangeInfoSnapshotRefreshPromise) {
      return this.exchangeInfoSnapshotRefreshPromise;
    }
    this.exchangeInfoSnapshotRefreshAttemptAt = Date.now();
    const promise = (async () => {
      const result = await this.request("GET", "/fapi/v1/exchangeInfo");
      this.exchangeInfoSnapshot = { loadedAt: Date.now(), data: result };
      for (const [symbol, cached] of this.exchangeInfoCache) {
        const symbolInfo = (result.symbols || []).find(
          (item) => item.symbol === symbol
        );
        if (!symbolInfo) continue;
        this.exchangeInfoCache.set(symbol, {
          loadedAt: Date.now(),
          data: {
            ...result,
            symbols: [symbolInfo],
            symbol: symbolInfo,
            marketType: this.marketType,
          },
        });
      }
      return result;
    })();
    this.exchangeInfoSnapshotRefreshPromise = promise;
    promise.finally(() => {
      if (this.exchangeInfoSnapshotRefreshPromise === promise) {
        this.exchangeInfoSnapshotRefreshPromise = null;
      }
    }).catch(() => {});
    return promise;
  }

  async marketOverview(symbol, { interval = "1m", limit = 50 } = {}) {
    const normalizedSymbol = this.validateSymbol(symbol);
    const normalizedLimit = Math.min(1000, Math.max(1, Number(limit) || 50));
    const [price, bookTicker, markPrice, ticker24hr, recentTrades, aggregateTrades, klines] =
      await Promise.all([
        this.request("GET", "/fapi/v1/ticker/price", { symbol: normalizedSymbol }),
        this.request("GET", "/fapi/v1/ticker/bookTicker", { symbol: normalizedSymbol }),
        this.request("GET", "/fapi/v1/premiumIndex", { symbol: normalizedSymbol }),
        this.request("GET", "/fapi/v1/ticker/24hr", { symbol: normalizedSymbol }),
        this.request("GET", "/fapi/v1/trades", { symbol: normalizedSymbol, limit: normalizedLimit }),
        this.request("GET", "/fapi/v1/aggTrades", { symbol: normalizedSymbol, limit: normalizedLimit }),
        this.request("GET", "/fapi/v1/klines", {
          symbol: normalizedSymbol,
          interval,
          limit: normalizedLimit,
        }),
      ]);

    let historicalTrades = [];
    let historicalTradesError = null;
    try {
      historicalTrades = await this.request("GET", "/fapi/v1/historicalTrades", {
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
      marketType: this.marketType,
      symbol: normalizedSymbol,
      price,
      bookTicker,
      averagePrice: {
        price: markPrice.markPrice,
        label: "标记价格",
      },
      markPrice,
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

  async prepareOrder(order, { forcePositionModeRefresh = false } = {}) {
    const symbol = this.validateSymbol(order.symbol);
    const side = String(order.side || "").toUpperCase();
    const requestedType = String(order.type || "").toUpperCase();
    const type = requestedType;
    const supportedTypes = new Set([
      "LIMIT",
      "MARKET",
      "STOP",
      "STOP_MARKET",
      "TAKE_PROFIT",
      "TAKE_PROFIT_MARKET",
      "TRAILING_STOP_MARKET",
    ]);

    if (!["BUY", "SELL"].includes(side)) {
      throw new BinanceApiError(`side 只支持 BUY 或 SELL，当前值：${side}`);
    }
    if (!supportedTypes.has(type)) {
      throw new BinanceApiError(`当前页面不支持该永续委托类型：${requestedType}`);
    }
    const positionEffect = String(order.positionEffect || "AUTO").toUpperCase();
    if (!["AUTO", "OPEN", "CLOSE"].includes(positionEffect)) {
      throw new BinanceApiError(
        `U 本位仓位动作只支持 AUTO、OPEN 或 CLOSE，当前值：${positionEffect}`
      );
    }
    const explicitReduceOnly = order.reduceOnly === true ||
      String(order.reduceOnly || "").toLowerCase() === "true";
    const closePosition = order.closePosition === true ||
      String(order.closePosition || "").toLowerCase() === "true";
    const reduceOnly = positionEffect === "CLOSE" || explicitReduceOnly;
    if (positionEffect === "OPEN" && explicitReduceOnly) {
      throw new BinanceApiError("U 本位开仓不能同时启用 reduceOnly。");
    }
    if (
      closePosition &&
      !["STOP_MARKET", "TAKE_PROFIT_MARKET"].includes(type)
    ) {
      throw new BinanceApiError(
        "closePosition 只适用于 STOP_MARKET 或 TAKE_PROFIT_MARKET 条件平仓。"
      );
    }

    const [positionMode, info] = await Promise.all([
      this.resolveOrderPositionSide(order, side, {
        forceRefresh: forcePositionModeRefresh,
      }),
      this.exchangeInfo(symbol),
    ]);
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
      positionSide: positionMode.positionSide,
      type,
      selfTradePreventionMode: this.requireSelfTradePrevention(symbolInfo),
      timeInForce: String(order.timeInForce || "")
        .toUpperCase() || undefined,
      quantity: order.quantity,
      quoteOrderQty: order.quoteOrderQty,
      price: order.price,
      stopPrice: order.stopPrice,
      reduceOnly: reduceOnly && !closePosition ? true : undefined,
      closePosition: closePosition ? true : undefined,
      workingType: String(order.workingType || "").toUpperCase() || undefined,
      priceProtect: order.priceProtect,
      activationPrice: order.activationPrice,
      callbackRate: order.callbackRate,
      goodTillDate: order.goodTillDate,
      priceMatch: String(order.priceMatch || "").toUpperCase() || undefined,
      newClientOrderId: this.buildBrokerClientOrderId(order.newClientOrderId),
      newOrderRespType: order.newOrderRespType || "ACK",
    });

    if (
      params.workingType &&
      !["MARK_PRICE", "CONTRACT_PRICE"].includes(params.workingType)
    ) {
      throw new BinanceApiError(
        "workingType 只支持 MARK_PRICE 或 CONTRACT_PRICE。"
      );
    }
    if (params.priceProtect && !["true", "false"].includes(params.priceProtect)) {
      throw new BinanceApiError("priceProtect 必须是 true 或 false。");
    }
    if (params.priceMatch && !FUTURES_PRICE_MATCH_MODES.has(params.priceMatch)) {
      throw new BinanceApiError(`U 本位 priceMatch 不支持当前值：${params.priceMatch}`);
    }
    if (params.priceMatch && params.price) {
      throw new BinanceApiError("U 本位 priceMatch 不能与 price 同时发送。");
    }
    if (
      params.priceMatch &&
      !["LIMIT", "STOP", "TAKE_PROFIT"].includes(type)
    ) {
      throw new BinanceApiError("priceMatch 只适用于 LIMIT、STOP 或 TAKE_PROFIT。");
    }
    if (
      (params.activationPrice || params.callbackRate) &&
      type !== "TRAILING_STOP_MARKET"
    ) {
      throw new BinanceApiError(
        "activationPrice 和 callbackRate 只适用于 TRAILING_STOP_MARKET。"
      );
    }
    if (
      params.priceProtect &&
      !["STOP", "STOP_MARKET", "TAKE_PROFIT", "TAKE_PROFIT_MARKET"].includes(type)
    ) {
      throw new BinanceApiError("priceProtect 只适用于止损或止盈条件单。");
    }
    if (params.goodTillDate && params.timeInForce !== "GTD") {
      throw new BinanceApiError("goodTillDate 只能与 timeInForce=GTD 一起使用。");
    }
    if (params.timeInForce === "GTD") {
      const goodTillDate = Number(params.goodTillDate);
      if (!Number.isFinite(goodTillDate) || goodTillDate <= Date.now() + 600_000) {
        throw new BinanceApiError(
          "GTD 委托的 goodTillDate 必须晚于当前时间至少 600 秒。"
        );
      }
      params.goodTillDate = String(Math.floor(goodTillDate / 1_000) * 1_000);
    }

    if (type === "LIMIT" || type === "STOP" || type === "TAKE_PROFIT") {
      params.timeInForce ||= "GTC";
    }
    if (
      (type === "LIMIT" || type === "STOP" || type === "TAKE_PROFIT") &&
      !params.price &&
      !params.priceMatch
    ) {
      throw new BinanceApiError(`${requestedType} 委托必须提供 price。`);
    }
    if (!closePosition && !params.quantity && !params.quoteOrderQty) {
      throw new BinanceApiError("永续委托必须提供 quantity 或 quoteOrderQty。");
    }
    if (params.quantity && params.quoteOrderQty) {
      throw new BinanceApiError("按数量和按总价只能选择一种下单模式。");
    }
    if (params.quoteOrderQty) {
      this.assertPositiveOrderAmount("订单总价 quoteOrderQty", params.quoteOrderQty);
    }
    if ((type.includes("STOP") || type.includes("TAKE_PROFIT")) && !params.stopPrice) {
      if (type !== "TRAILING_STOP_MARKET") {
        throw new BinanceApiError(`${requestedType} 委托必须提供 stopPrice。`);
      }
    }
    if (type === "TRAILING_STOP_MARKET" && !params.callbackRate) {
      throw new BinanceApiError("TRAILING_STOP_MARKET 委托必须提供 callbackRate。");
    }
    if (closePosition) {
      delete params.quantity;
      delete params.quoteOrderQty;
      delete params.reduceOnly;
    }
    if (type === "MARKET" || type.endsWith("_MARKET")) {
      delete params.price;
      delete params.timeInForce;
    }
    if (!type.includes("STOP") && !type.includes("TAKE_PROFIT")) {
      delete params.stopPrice;
    }

    const adjustments = [];
    let orderSizing = params.quoteOrderQty
      ? {
          mode: "quote-total",
          requestedQuoteOrderQty: params.quoteOrderQty,
          directQuoteOrderQty: false,
        }
      : { mode: "quantity" };
    if (params.price && filters.PRICE_FILTER) {
      const original = params.price;
      params.price = this.alignToStep(params.price, filters.PRICE_FILTER.tickSize);
      this.assertFilterRange(
        "price",
        params.price,
        filters.PRICE_FILTER.minPrice,
        filters.PRICE_FILTER.maxPrice
      );
      if (original !== params.price) adjustments.push(`price: ${original} -> ${params.price}`);
    }
    if (params.stopPrice && filters.PRICE_FILTER) {
      const original = params.stopPrice;
      params.stopPrice = this.alignToStep(params.stopPrice, filters.PRICE_FILTER.tickSize);
      this.assertFilterRange(
        "stopPrice",
        params.stopPrice,
        filters.PRICE_FILTER.minPrice,
        filters.PRICE_FILTER.maxPrice
      );
      if (original !== params.stopPrice) adjustments.push(`stopPrice: ${original} -> ${params.stopPrice}`);
    }
    if (params.activationPrice && filters.PRICE_FILTER) {
      const original = params.activationPrice;
      params.activationPrice = this.alignToStep(
        params.activationPrice,
        filters.PRICE_FILTER.tickSize
      );
      this.assertFilterRange(
        "activationPrice",
        params.activationPrice,
        filters.PRICE_FILTER.minPrice,
        filters.PRICE_FILTER.maxPrice
      );
      if (original !== params.activationPrice) {
        adjustments.push(
          `activationPrice: ${original} -> ${params.activationPrice}`
        );
      }
    }
    if (params.callbackRate) {
      this.assertFilterRange("callbackRate", params.callbackRate, "0.1", "10");
    }

    if (params.quoteOrderQty) {
      const requestedQuoteOrderQty = params.quoteOrderQty;
      const reference = await this.resolveTotalOrderReferencePrice(symbol, [
        { value: params.price, source: "委托价" },
        { value: params.stopPrice, source: "触发价" },
      ]);
      params.quantity = quantityFilter
        ? divideDecimalToStep(
            requestedQuoteOrderQty,
            reference.price,
            quantityFilter.stepSize
          )
        : String(Number(requestedQuoteOrderQty) / Number(reference.price));
      delete params.quoteOrderQty;
      orderSizing = {
        mode: "quote-total",
        requestedQuoteOrderQty,
        directQuoteOrderQty: false,
        referencePrice: String(reference.price),
        referenceSource: reference.source,
      };
    }

    if (params.quantity && quantityFilter) {
      const original = params.quantity;
      params.quantity = this.alignToStep(params.quantity, quantityFilter.stepSize);
      this.assertFilterRange(
        "quantity",
        params.quantity,
        quantityFilter.minQty,
        quantityFilter.maxQty
      );
      if (orderSizing.mode === "quote-total") {
        orderSizing.convertedQuantity = params.quantity;
        adjustments.push(
          `总价模式: ${orderSizing.requestedQuoteOrderQty} / ` +
          `${orderSizing.referencePrice}（${orderSizing.referenceSource}） -> ` +
          `quantity ${params.quantity}`
        );
      } else if (original !== params.quantity) {
        adjustments.push(`quantity: ${original} -> ${params.quantity}`);
      }
    }

    const minNotional = filters.MIN_NOTIONAL?.notional || filters.MIN_NOTIONAL?.minNotional;
    const notionalReferencePrice = String(
      params.price || params.stopPrice || orderSizing.referencePrice || 0
    );
    const notional = multiplyDecimal(
      notionalReferencePrice,
      params.quantity || "0"
    );
    if (isPositiveDecimal(notional) && isPositiveDecimal(minNotional)) {
      this.assertFilterRange("订单金额", notional, minNotional, undefined);
    }

    return {
      params,
      adjustments,
      symbolInfo,
      orderSizing,
      positionMode,
      positionEffect,
      isAlgoOrder: FUTURES_ALGO_ORDER_TYPES.has(type),
    };
  }

  toAlgoOrderParams(params) {
    return this.normalizeParams({
      algoType: "CONDITIONAL",
      symbol: params.symbol,
      side: params.side,
      positionSide: params.positionSide,
      type: params.type,
      timeInForce: params.timeInForce,
      quantity: params.quantity,
      reduceOnly: params.reduceOnly,
      price: params.price,
      triggerPrice: params.stopPrice,
      workingType: params.workingType,
      priceProtect: params.priceProtect,
      clientAlgoId: params.newClientOrderId,
      newOrderRespType: params.newOrderRespType,
      closePosition: params.closePosition,
      activatePrice: params.activationPrice,
      callbackRate: params.callbackRate,
      priceMatch: params.priceMatch,
      selfTradePreventionMode: params.selfTradePreventionMode,
      goodTillDate: params.goodTillDate,
    });
  }

  normalizeAlgoOrder(order = {}, overrides = {}) {
    const normalized = {
      ...order,
      orderId: order.algoId ?? order.ai ?? order.aid ?? order.orderId,
      actualOrderId:
        order.actualOrderId ?? order.actualOrderID ?? order.actualOrder?.orderId,
      clientOrderId:
        order.clientAlgoId ?? order.caid ?? order.clientOrderId ?? order.c,
      symbol: order.symbol ?? order.s,
      side: order.side ?? order.S,
      type: order.orderType ?? order.type ?? order.o,
      status: order.algoStatus ?? order.status ?? order.X,
      price: order.price ?? order.p ?? "0",
      stopPrice: order.triggerPrice ?? order.stopPrice ?? order.sp ?? "0",
      origQty: order.quantity ?? order.origQty ?? order.q ?? "0",
      executedQty:
        order.executedQty ?? order.actualExecutedQty ?? order.z ?? "0",
      averagePrice:
        order.avgPrice ?? order.averagePrice ?? order.ap ?? "0",
      cumulativeQuoteQty:
        order.cumQuote ?? order.cumulativeQuoteQty ?? order.Z ?? "0",
      reduceOnly: order.reduceOnly ?? order.R,
      closePosition: order.closePosition ?? order.cp,
      updateTime:
        order.updateTime ?? order.T ?? order.E ?? order.createTime ?? Date.now(),
      algoOrder: true,
      marketType: this.marketType,
      ...overrides,
    };
    if (normalized.orderId !== undefined && normalized.orderId !== null) {
      this.knownAlgoOrderIds.add(String(normalized.orderId));
    }
    if (normalized.clientOrderId) {
      this.knownAlgoClientOrderIds.add(String(normalized.clientOrderId));
    }
    return normalized;
  }

  isKnownAlgoOrder({ orderId, origClientOrderId, algoId, clientAlgoId } = {}) {
    const resolvedOrderId = algoId ?? orderId;
    const resolvedClientOrderId = clientAlgoId ?? origClientOrderId;
    return Boolean(
      (resolvedOrderId !== undefined &&
        this.knownAlgoOrderIds.has(String(resolvedOrderId))) ||
      (resolvedClientOrderId &&
        this.knownAlgoClientOrderIds.has(String(resolvedClientOrderId)))
    );
  }

  isOrderNotFoundError(error) {
    return [-2011, -2013].includes(Number(error?.code)) ||
      /unknown order|order does not exist/i.test(error?.message || "");
  }

  async placeOrder(
    order,
    {
      testOnly = false,
      positionModeRetry = false,
      forcePositionModeRefresh = false,
    } = {}
  ) {
    const {
      params,
      adjustments,
      orderSizing,
      positionMode,
      positionEffect,
      isAlgoOrder,
    } =
      await this.prepareOrder(order, { forcePositionModeRefresh });
    let result;
    let transport;
    let fallbackReason;
    try {
      if (testOnly) {
        result = await this.signedRest("POST", "/fapi/v1/order/test", params);
        transport = "https-keepalive";
      } else if (isAlgoOrder) {
        const algoParams = this.toAlgoOrderParams(params);
        ({ result, transport, fallbackReason } =
          await this.requestWsApiWithRestFallback(
            "algoOrder.place",
            algoParams,
            () => this.request(
              "POST",
              "/fapi/v1/algoOrder",
              algoParams,
              true,
              this.tradingRestBase
            ),
            { retrySafe: false, waitForWebSocketReady: true }
          ));
        result = this.normalizeAlgoOrder(result);
      } else {
        ({ result, transport, fallbackReason } =
          await this.requestWsApiWithRestFallback(
            "order.place",
            params,
            () => this.request(
              "POST",
              "/fapi/v1/order",
              params,
              true,
              this.tradingRestBase
            ),
            { retrySafe: false, waitForWebSocketReady: true }
          ));
      }
    } catch (error) {
      if (!testOnly) this.attachOrderAttempt(error, params);
      if (
        !positionModeRetry &&
        !order.positionSide &&
        this.isPositionSideMismatchError(error)
      ) {
        this.positionModeCache = null;
        return this.placeOrder(order, {
          testOnly,
          positionModeRetry: true,
          forcePositionModeRefresh: true,
        });
      }
      throw error;
    }
    return {
      ...result,
      marketType: this.marketType,
      testOnly,
      adjustments,
      orderSizing,
      positionMode: positionMode.positionMode,
      positionSide: positionMode.positionSide,
      positionEffect,
      reduceOnly: params.reduceOnly === "true",
      algoOrder: isAlgoOrder && !testOnly,
      selfTradePrevention: {
        mode: this.selfTradePreventionMode,
        enforced: true,
        apiEffective: ["IOC", "GTC", "GTD"].includes(params.timeInForce),
        limitation:
          "Binance USDⓈ-M 文档仅保证该模式在 IOC/GTC/GTD 下生效。",
      },
      transport,
      ...(fallbackReason ? { fallbackReason } : {}),
      preflightBalanceCheck: false,
    };
  }

  async cancelOrder({ symbol, orderId, origClientOrderId, algoOrder }) {
    if (!orderId && !origClientOrderId) {
      throw new BinanceApiError("撤单必须提供 orderId 或 origClientOrderId。");
    }
    const params = {
      symbol: this.validateSymbol(symbol),
      orderId,
      origClientOrderId,
    };
    if (algoOrder === true || this.isKnownAlgoOrder(params)) {
      return this.cancelAlgoOrder({
        symbol: params.symbol,
        algoId: orderId,
        clientAlgoId: origClientOrderId,
      });
    }
    let response;
    try {
      response = await this.requestWsApiWithRestFallback(
        "order.cancel",
        params,
        () => this.request(
          "DELETE",
          "/fapi/v1/order",
          params,
          true,
          this.tradingRestBase
        )
      );
    } catch (error) {
      if (!this.isOrderNotFoundError(error) || algoOrder === false) throw error;
      return this.cancelAlgoOrder({
        symbol: params.symbol,
        algoId: orderId,
        clientAlgoId: origClientOrderId,
      });
    }
    const { result, transport, fallbackReason } = response;
    return {
      ...result,
      marketType: this.marketType,
      transport,
      ...(fallbackReason ? { fallbackReason } : {}),
    };
  }

  async queryOrder({ symbol, orderId, origClientOrderId }) {
    if (!orderId && !origClientOrderId) {
      throw new BinanceApiError("查询单笔订单必须提供 orderId 或 origClientOrderId。");
    }
    if (this.isKnownAlgoOrder({ orderId, origClientOrderId })) {
      return this.queryAlgoOrder({
        algoId: orderId,
        clientAlgoId: origClientOrderId,
      });
    }
    try {
      return await this.signedWsOrRest("order.status", "GET", "/fapi/v1/order", {
        symbol: this.validateSymbol(symbol),
        orderId,
        origClientOrderId,
      });
    } catch (error) {
      if (!this.isOrderNotFoundError(error)) throw error;
      return this.queryAlgoOrder({
        algoId: orderId,
        clientAlgoId: origClientOrderId,
      });
    }
  }

  async openOrders({ symbol, critical = false } = {}) {
    const normalizedSymbol = symbol ? this.validateSymbol(symbol) : undefined;
    const [regularOrders, algoOrders] = await Promise.all([
      this.signedRest("GET", "/fapi/v1/openOrders", {
        symbol: normalizedSymbol,
      }, { critical }),
      this.openAlgoOrders({ symbol: normalizedSymbol, critical }),
    ]);
    return [
      ...regularOrders,
      ...algoOrders,
    ];
  }

  async cancelAllOpenOrders({ symbol }) {
    const normalizedSymbol = this.validateSymbol(symbol);
    const existing = await this.openOrders({
      symbol: normalizedSymbol,
      critical: true,
    });
    await Promise.all([
      this.signedRest("DELETE", "/fapi/v1/allOpenOrders", {
        symbol: normalizedSymbol,
      }),
      this.signedRest("DELETE", "/fapi/v1/algoOpenOrders", {
        symbol: normalizedSymbol,
      }),
    ]);
    return existing.map((order) => ({
      ...order,
      status: "CANCELED",
      updateTime: Date.now(),
      marketType: this.marketType,
    }));
  }

  async amendOrder({ symbol, orderId, origClientOrderId, newQty }) {
    if (!newQty || Number(newQty) <= 0) {
      throw new BinanceApiError("修改订单必须提供大于 0 的 newQty。");
    }
    const current = await this.queryOrder({ symbol, orderId, origClientOrderId });
    if (!current.price || Number(current.price) <= 0) {
      throw new BinanceApiError("当前永续订单没有可用于修改的限价价格。");
    }
    const info = await this.exchangeInfo(symbol);
    const lotSize = info.symbol?.filters?.find(
      (filter) => filter.filterType === "LOT_SIZE"
    );
    const quantity = lotSize
      ? this.alignToStep(newQty, lotSize.stepSize)
      : String(newQty);
    const positionMode = await this.resolveOrderPositionSide(
      { positionSide: current.positionSide },
      current.side
    );
    return this.signedWsOrRest(
      "order.modify",
      "PUT",
      "/fapi/v1/order",
      {
        symbol: this.validateSymbol(symbol),
        orderId,
        origClientOrderId,
        side: current.side,
        positionSide: positionMode.positionSide,
        quantity,
        price: current.price,
      },
      { retrySafe: false }
    );
  }

  async cancelReplace({ cancelOrderId, cancelOrigClientOrderId, ...order }) {
    if (!cancelOrderId && !cancelOrigClientOrderId) {
      throw new BinanceApiError("撤单重报必须提供原订单 ID。");
    }
    const cancelResult = await this.cancelOrder({
      symbol: order.symbol,
      orderId: cancelOrderId,
      origClientOrderId: cancelOrigClientOrderId,
    });
    const newOrderResult = await this.placeOrder(order);
    return {
      ...newOrderResult,
      cancelResult,
      newOrderResult,
      cancelReplaceMode: "SEQUENTIAL",
    };
  }

  async allOrders({ symbol, orderId, startTime, endTime, limit = 100 } = {}) {
    return this.signedRest("GET", "/fapi/v1/allOrders", {
      symbol: symbol ? this.validateSymbol(symbol) : undefined,
      orderId,
      startTime,
      endTime,
      limit,
    });
  }

  async queryAlgoOrder({ algoId, clientAlgoId } = {}) {
    if (!algoId && !clientAlgoId) {
      throw new BinanceApiError(
        "查询 U 本位 Algo Order 必须提供 algoId 或 clientAlgoId。"
      );
    }
    const order = await this.signedRest("GET", "/fapi/v1/algoOrder", {
      algoId,
      clientAlgoId,
    });
    return this.normalizeAlgoOrder(order);
  }

  async cancelAlgoOrder({ symbol, algoId, clientAlgoId } = {}) {
    if (!algoId && !clientAlgoId) {
      throw new BinanceApiError(
        "撤销 U 本位 Algo Order 必须提供 algoId 或 clientAlgoId。"
      );
    }
    const result = await this.signedRest("DELETE", "/fapi/v1/algoOrder", {
      algoId,
      clientAlgoId,
    });
    return this.normalizeAlgoOrder(result, {
      symbol: symbol ? this.validateSymbol(symbol) : result.symbol,
      status: "CANCELED",
      updateTime: Date.now(),
    });
  }

  async openAlgoOrders({ symbol, algoId, critical = false } = {}) {
    const orders = await this.signedRest("GET", "/fapi/v1/openAlgoOrders", {
      algoType: "CONDITIONAL",
      symbol: symbol ? this.validateSymbol(symbol) : undefined,
      algoId,
    }, { critical });
    return orders.map((order) => this.normalizeAlgoOrder(order));
  }

  async allAlgoOrders({
    symbol,
    algoId,
    startTime,
    endTime,
    limit = 100,
  } = {}) {
    const orders = await this.signedRest("GET", "/fapi/v1/allAlgoOrders", {
      symbol: this.validateSymbol(symbol),
      algoId,
      startTime,
      endTime,
      limit,
    });
    return orders.map((order) => this.normalizeAlgoOrder(order));
  }

  async myTrades({ symbol, orderId, startTime, endTime, fromId, limit = 100 } = {}) {
    const trades = await this.signedRest("GET", "/fapi/v1/userTrades", {
      symbol: this.validateSymbol(symbol),
      orderId,
      startTime,
      endTime,
      fromId,
      limit,
    });
    return trades.map((trade) => ({
      ...trade,
      isBuyer: trade.buyer,
      isMaker: trade.maker,
      marketType: this.marketType,
    }));
  }

  async accountStatus({ omitZeroBalances, critical = false } = {}) {
    let account;
    try {
      account = await this.signedWsOrRest(
        "v2/account.status",
        "GET",
        "/fapi/v3/account",
        {},
        { retrySafe: true, critical }
      );
    } catch (error) {
      // 新版 WS 查询只返回存在持仓或挂单的合约，数据量更小；若某个
      // Futures WS 节点尚未支持它，只读请求可以安全地降级到 V3 REST。
      const isWsBusinessError = Boolean(
        error?.data &&
        !error.data.localRateLimitGuard &&
        (Object.prototype.hasOwnProperty.call(error.data, "id") ||
          Object.prototype.hasOwnProperty.call(error.data, "error"))
      );
      if (!isWsBusinessError) throw error;
      account = await this.signedRest(
        "GET",
        "/fapi/v3/account",
        {},
        { critical }
      );
    }
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw new BinanceApiError("Binance U 本位账户响应无效。", {
        data: {
          operation: "account.status",
          invalidField: "result",
        },
      });
    }

    const positions = Array.isArray(account.positions)
      ? this.normalizePositionRiskRows(account.positions, {
          operation: "account.status",
        })
      : account.positions;
    let assets = Array.isArray(account.assets)
      ? account.assets.map((asset) => {
          const unrealizedProfit = String(
            asset?.unrealizedProfit ?? asset?.unRealizedProfit ?? "0"
          ).trim();
          return {
            ...asset,
            unrealizedProfit,
            unRealizedProfit: unrealizedProfit,
          };
        })
      : [];
    if (omitZeroBalances) {
      assets = assets.filter((asset) =>
        Number(asset.walletBalance) !== 0 || Number(asset.unrealizedProfit) !== 0
      );
    }
    const totalUnrealizedProfit =
      account.totalUnrealizedProfit ?? account.totalUnRealizedProfit;
    return {
      ...account,
      ...(totalUnrealizedProfit === undefined
        ? {}
        : { totalUnrealizedProfit: String(totalUnrealizedProfit).trim() }),
      positions,
      assets,
      marketType: this.marketType,
      accountType: "USDⓈ-M Futures",
      permissions: ["FUTURES"],
      balances: assets.map((asset) => ({
        asset: asset.asset,
        free: asset.availableBalance,
        locked: String(
          Number(asset.walletBalance || 0) - Number(asset.availableBalance || 0)
        ),
        walletBalance: asset.walletBalance,
        unrealizedProfit: asset.unrealizedProfit,
      })),
    };
  }

  normalizePositionRiskRows(
    result,
    { operation = "v2/account.position" } = {}
  ) {
    if (!Array.isArray(result)) {
      throw new BinanceApiError(
        "Binance U 本位持仓响应无效：期望 positions 数组。",
        {
          data: {
            operation,
            invalidField: "result",
            receivedType: result === null ? "null" : typeof result,
          },
        }
      );
    }

    return result.map((position, index) => {
      if (!position || typeof position !== "object" || Array.isArray(position)) {
        throw new BinanceApiError(
          `Binance U 本位持仓响应无效：第 ${index + 1} 行不是对象。`,
          {
            data: {
              operation,
              invalidField: `result[${index}]`,
            },
          }
        );
      }

      const symbol = String(position.symbol ?? "").trim().toUpperCase();
      if (!symbol) {
        throw new BinanceApiError(
          `Binance U 本位持仓响应无效：第 ${index + 1} 行缺少 symbol。`,
          {
            data: {
              operation,
              invalidField: `result[${index}].symbol`,
            },
          }
        );
      }

      const positionAmt = String(position.positionAmt ?? "").trim();
      try {
        parseDecimal(positionAmt, "positionAmt");
      } catch {
        throw new BinanceApiError(
          `Binance U 本位持仓响应无效：${symbol} 的 positionAmt 不是有效十进制数。`,
          {
            data: {
              operation,
              invalidField: `result[${index}].positionAmt`,
              symbol,
            },
          }
        );
      }

      const unrealizedProfit = String(
        position.unrealizedProfit ?? position.unRealizedProfit ?? "0"
      ).trim();
      const rawMarginType = String(position.marginType ?? "")
        .trim()
        .toLowerCase();
      const marginType = rawMarginType === "crossed"
        ? "cross"
        : rawMarginType;
      const isolatedText = String(position.isolated ?? "")
        .trim()
        .toLowerCase();
      const explicitIsolated = position.isolated === true ||
        isolatedText === "true"
        ? true
        : position.isolated === false || isolatedText === "false"
          ? false
          : undefined;
      const isolated = explicitIsolated ?? (
        marginType
          ? marginType === "isolated"
          : false
      );

      return {
        ...position,
        symbol,
        positionAmt,
        unrealizedProfit,
        unRealizedProfit: unrealizedProfit,
        marginType: isolated ? "isolated" : "cross",
        isolated,
      };
    });
  }

  async positionRisk({ symbol, critical = true } = {}) {
    const normalizedSymbol = symbol ? this.validateSymbol(symbol) : undefined;
    const params = { symbol: normalizedSymbol };
    let positions;
    try {
      positions = await this.signedWsOrRest(
        "v2/account.position",
        "GET",
        "/fapi/v3/positionRisk",
        params,
        {
          // 查询接口可安全重试；WebSocket 传输失败后立即用 REST 复核。
          retrySafe: true,
          critical,
        }
      );
    } catch (error) {
      // 不同 Futures WebSocket API 节点可能尚未提供 v2/account.position。
      // 这种 WS 业务响应对只读持仓查询可安全降级到 REST；REST 自身错误则
      // 原样抛出，避免对同一个失败请求进行无意义的二次调用。
      const isWsBusinessError = Boolean(
        error?.data &&
        !error.data.localRateLimitGuard &&
        (Object.prototype.hasOwnProperty.call(error.data, "id") ||
          Object.prototype.hasOwnProperty.call(error.data, "error"))
      );
      if (!isWsBusinessError) throw error;
      positions = await this.signedRest(
        "GET",
        "/fapi/v3/positionRisk",
        params,
        { critical }
      );
    }
    return this.normalizePositionRiskRows(positions);
  }

  async currentPositions(options = {}) {
    return this.positionRisk(options);
  }

  async incomeHistory({
    incomeType,
    symbol,
    startTime,
    endTime,
    page = 1,
    limit = 1000,
  } = {}) {
    return this.signedRest("GET", "/fapi/v1/income", {
      incomeType,
      symbol: symbol ? this.validateSymbol(symbol) : undefined,
      startTime,
      endTime,
      page: Math.max(1, Math.floor(Number(page) || 1)),
      limit: Math.min(1000, Math.max(1, Math.floor(Number(limit) || 1000))),
    });
  }

  async signTradFiPerpsAgreement() {
    if (this.testnet) {
      throw new BinanceApiError(
        "TradFi-Perps 协议签署接口仅适用于 Binance 正式环境。"
      );
    }

    const result = await this.signedRest(
      "POST",
      "/fapi/v1/stock/contract"
    );
    return {
      ...result,
      marketType: this.marketType,
      agreement: "TradFi-Perps",
      signedForCurrentApiAccount: true,
    };
  }

  async accountCommission({ symbol }) {
    const result = await this.signedRest("GET", "/fapi/v1/commissionRate", {
      symbol: this.validateSymbol(symbol),
    });
    return {
      ...result,
      marketType: this.marketType,
      standardCommission: {
        maker: result.makerCommissionRate,
        taker: result.takerCommissionRate,
        buyer: "-",
        seller: "-",
      },
      specialCommission: null,
      taxCommission: null,
    };
  }

  async accountRateLimits() {
    return this.signedRest("GET", "/fapi/v1/rateLimit/order");
  }

  async setCountdownCancelAll({ symbol, countdownTime }) {
    const normalizedCountdown = Math.floor(Number(countdownTime));
    if (
      !Number.isFinite(normalizedCountdown) ||
      normalizedCountdown < 0 ||
      normalizedCountdown > 600_000
    ) {
      throw new BinanceApiError(
        "U 本位自动撤单 countdownTime 必须是 0-600000 毫秒。"
      );
    }
    return this.signedRest("POST", "/fapi/v1/countdownCancelAll", {
      symbol: this.validateSymbol(symbol),
      countdownTime: normalizedCountdown,
    });
  }

  normalizeFuturesUserEvent(message) {
    if (message.e === "ALGO_UPDATE") {
      const order = message.o || message.ao || message.a || {};
      const normalized = this.normalizeAlgoOrder(order, {
        updateTime: order.updateTime ?? order.T ?? message.T ?? message.E,
      });
      return {
        e: "executionReport",
        E: message.E,
        T: message.T ?? normalized.updateTime,
        s: normalized.symbol,
        c: normalized.clientOrderId,
        S: normalized.side,
        o: normalized.type,
        f: order.timeInForce ?? order.f,
        q: normalized.origQty,
        p: normalized.price,
        P: normalized.stopPrice,
        x: order.executionType ?? order.x ?? normalized.status,
        X: normalized.status,
        i: normalized.orderId,
        actualOrderId: normalized.actualOrderId,
        l: order.lastExecutedQty ?? order.l ?? "0",
        z: normalized.executedQty,
        L: order.lastExecutedPrice ?? order.L ?? "0",
        ap: normalized.averagePrice,
        cumQuote: normalized.cumulativeQuoteQty,
        ps: order.positionSide ?? order.ps,
        positionSide: order.positionSide ?? order.ps,
        R: order.reduceOnly ?? order.R,
        reduceOnly: order.reduceOnly ?? order.R,
        cp: order.closePosition ?? order.cp,
        closePosition: order.closePosition ?? order.cp,
        algoOrder: true,
        marketType: this.marketType,
        rawEvent: message,
      };
    }
    if (message.e === "CONDITIONAL_ORDER_TRIGGER_REJECT") {
      const order = message.or || message.o || message.order || {};
      const normalized = this.normalizeAlgoOrder(order, {
        status: "REJECTED",
        updateTime: message.T ?? message.E,
      });
      return {
        e: "executionReport",
        E: message.E,
        T: message.T ?? message.E,
        s: normalized.symbol,
        c: normalized.clientOrderId,
        S: normalized.side,
        o: normalized.type,
        q: normalized.origQty,
        p: normalized.price,
        P: normalized.stopPrice,
        x: "REJECTED",
        X: "REJECTED",
        i: normalized.orderId,
        r: order.rejectReason ?? order.r ?? message.r ?? "条件单触发被拒绝",
        algoOrder: true,
        marketType: this.marketType,
        rawEvent: message,
      };
    }
    if (message.e === "TRADE_LITE") {
      return { ...message, marketType: this.marketType, lite: true };
    }
    if (message.e !== "ORDER_TRADE_UPDATE" || !message.o) return message;
    const order = message.o;
    return {
      e: "executionReport",
      E: message.E,
      T: order.T ?? message.T,
      s: order.s,
      c: order.c,
      S: order.S,
      o: order.o,
      f: order.f,
      q: order.q,
      p: order.p,
      P: order.sp,
      x: order.x,
      X: order.X,
      i: order.i,
      l: order.l,
      z: order.z,
      L: order.L,
      ap: order.ap,
      cumQuote: order.cumQuote,
      n: order.n,
      N: order.N,
      t: order.t,
      rp: order.rp,
      ma: order.ma,
      ps: order.ps,
      positionSide: order.ps,
      R: order.R,
      reduceOnly: order.R,
      cp: order.cp,
      closePosition: order.cp,
      marketType: this.marketType,
      rawEvent: message,
    };
  }

  async connectUserData() {
    this.assertTradingCredentials();
    if (this.userDataSocket?.readyState === WebSocket.OPEN && this.futuresListenKey) {
      const result = { subscriptionId: this.futuresListenKey, reused: true };
      this.emit("user-data-status", {
        status: "connected",
        marketType: this.marketType,
        ...result,
        time: Date.now(),
      });
      return result;
    }

    this.disconnectUserData(true);
    this.userDataManualClose = false;
    this.userDataReconnectDelayMs = 1_000;
    const listenKeyResult = await this.request(
      "POST",
      "/fapi/v1/listenKey",
      {},
      false,
      this.tradingRestBase
    );
    this.futuresListenKey = listenKeyResult.listenKey;
    return this.openFuturesUserDataSocket();
  }

  createFuturesUserDataSocketUrl(listenKey = this.futuresListenKey) {
    const normalizedListenKey = String(listenKey || "").trim();
    if (!normalizedListenKey) {
      throw new BinanceApiError("永续账户事件缺少 listenKey。");
    }
    return `${this.userDataWsBase}/${encodeURIComponent(normalizedListenKey)}`;
  }

  openFuturesUserDataSocket() {
    const listenKey = this.futuresListenKey;
    if (!listenKey) {
      return Promise.reject(new BinanceApiError("永续账户事件缺少 listenKey。"));
    }

    return new Promise((resolve, reject) => {
      const url = this.createFuturesUserDataSocketUrl(listenKey);
      const connectStartedAt = performance.now();
      const socket = new WebSocket(url);
      let connected = false;
      let connectLatencyReported = false;
      const reportConnectLatency = (success) => {
        if (connectLatencyReported) return;
        connectLatencyReported = true;
        this.emitApiLatency({
          operation: "账户事件流连接",
          transport: "websocket-stream",
          startedAt: connectStartedAt,
          success,
          background: true,
        });
      };
      const timeoutId = setTimeout(() => {
        if (!connected) {
          reportConnectLatency(false);
          reject(new BinanceApiError("永续账户事件连接超时。"));
          socket.terminate();
        }
      }, 15_000);

      this.userDataSocket = socket;
      this.emit("user-data-status", {
        status: "connecting",
        marketType: this.marketType,
        url,
        time: Date.now(),
      });

      socket.on("open", () => {
        connected = true;
        clearTimeout(timeoutId);
        reportConnectLatency(true);
        this.userDataReconnectDelayMs = 1_000;
        this.startListenKeyKeepAlive();
        const result = { subscriptionId: listenKey };
        this.emit("user-data-status", {
          status: "connected",
          marketType: this.marketType,
          ...result,
          time: Date.now(),
        });
        resolve(result);
      });

      socket.on("message", (buffer) => {
        try {
          const message = JSON.parse(buffer.toString());
          this.emit("user-data-event", {
            subscriptionId: listenKey,
            marketType: this.marketType,
            event: this.normalizeFuturesUserEvent(message),
            receivedAt: Date.now(),
          });
        } catch (error) {
          this.emit("user-data-error", {
            marketType: this.marketType,
            message: `永续账户事件解析失败：${error.message}`,
            time: Date.now(),
          });
        }
      });

      socket.on("error", (error) => {
        this.emit("user-data-error", {
          marketType: this.marketType,
          message: error.message,
          time: Date.now(),
        });
        if (!connected) {
          clearTimeout(timeoutId);
          reportConnectLatency(false);
          reject(new BinanceApiError(`永续账户事件连接失败：${error.message}`));
        }
      });

      socket.on("close", (code, reasonBuffer) => {
        clearTimeout(timeoutId);
        if (!connected) reportConnectLatency(false);
        if (this.userDataSocket !== socket) return;
        this.userDataSocket = null;
        this.stopListenKeyKeepAlive();
        this.emit("user-data-status", {
          status: this.userDataManualClose ? "disconnected" : "reconnecting",
          marketType: this.marketType,
          code,
          reason: reasonBuffer?.toString() || "",
          time: Date.now(),
        });
        if (!this.userDataManualClose) this.scheduleFuturesUserDataReconnect();
      });
    });
  }

  startListenKeyKeepAlive() {
    this.stopListenKeyKeepAlive();
    this.futuresListenKeyKeepAliveTimer = setInterval(() => {
      if (!this.futuresListenKey) return;
      this.request(
        "PUT",
        "/fapi/v1/listenKey",
        {},
        false,
        this.tradingRestBase
      ).catch((error) => {
        this.emit("user-data-error", {
          marketType: this.marketType,
          message: `永续账户事件续期失败：${error.message}`,
          time: Date.now(),
        });
      });
    }, 45 * 60 * 1000);
    this.futuresListenKeyKeepAliveTimer.unref?.();
  }

  stopListenKeyKeepAlive() {
    clearInterval(this.futuresListenKeyKeepAliveTimer);
    this.futuresListenKeyKeepAliveTimer = null;
  }

  scheduleFuturesUserDataReconnect() {
    clearTimeout(this.userDataReconnectTimer);
    const delay = this.userDataReconnectDelayMs;
    this.userDataReconnectDelayMs = Math.min(delay * 2, 30_000);
    this.userDataReconnectTimer = setTimeout(() => {
      this.connectUserData().catch((error) => {
        this.emit("user-data-error", {
          marketType: this.marketType,
          message: error.message,
          time: Date.now(),
        });
      });
    }, delay);
  }

  disconnectUserData(manual = true) {
    this.userDataManualClose = manual;
    clearTimeout(this.userDataReconnectTimer);
    this.userDataReconnectTimer = null;
    this.stopListenKeyKeepAlive();

    if (this.userDataSocket) {
      const socket = this.userDataSocket;
      this.userDataSocket = null;
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "client disconnect");
      } else {
        socket.terminate();
      }
    }
    this.futuresListenKey = null;
    return { disconnected: true };
  }
}

module.exports = {
  BinanceUsdMClient,
  FUTURES_REST_BASE,
  FUTURES_USER_DATA_WS_BASE,
  FUTURES_WS_BASE,
  FUTURES_WS_API_BASE,
};
