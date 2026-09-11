const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const { performance } = require("node:perf_hooks");
const WebSocket = require("ws");
const {
  alignDecimalToStep,
  compareDecimal,
  isPositiveDecimal,
} = require("./decimalMath");

const DEPTH_SPEEDS = new Set(["100ms", "1000ms"]);
const PARTIAL_DEPTH_LEVELS = new Set([5, 10, 20]);
const DEFAULT_DEPTH_LEVELS = 20;
const SERVER_TIME_CACHE_TTL_MS = 120_000;
const SERVER_TIME_REFRESH_INTERVAL_MS = 30_000;
const DYNAMIC_PRICE_MAX_AGE_MS = 10_000;
const WS_API_REQUEST_TIMEOUT_MS = 5_000;
const WS_API_CONNECT_TIMEOUT_MS = 10_000;
const WS_API_HEARTBEAT_INTERVAL_MS = 20_000;
const REQUIRED_SELF_TRADE_PREVENTION_MODE = "EXPIRE_MAKER";
const CLIENT_ORDER_ID_PATTERN = /^[.A-Za-z0-9_:/-]{1,36}$/;

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
          headers: response.headers || {},
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

class BinanceClientBase extends EventEmitter {
  constructor({
    apiKey = "",
    apiSecret = "",
    testnet = true,
    depthSpeed = "100ms",
    preflightBalanceCheck = false,
    brokerLinkId = "",
    rateLimitCoordinator = null,
    marketType = "",
    restBase = "",
    tradingRestBase = restBase,
    wsBase = "",
    wsApiBase = "",
    timePath = "",
    pingPath = "",
    tickerPricePath = "",
    depthLevels = DEFAULT_DEPTH_LEVELS,
  } = {}) {
    super();

    this.apiKey = apiKey.trim();
    this.apiSecret = apiSecret.trim();
    this.testnet = Boolean(testnet);
    this.marketType = String(marketType || "");
    this.selfTradePreventionMode = REQUIRED_SELF_TRADE_PREVENTION_MODE;
    this.brokerLinkId = String(brokerLinkId || "").trim();
    this.rateLimitCoordinator = rateLimitCoordinator;

    this.restBase = String(restBase || "");
    this.tradingRestBase = String(tradingRestBase || restBase || "");
    this.wsBase = String(wsBase || "");
    this.wsApiBase = String(wsApiBase || "");
    this.tradingWsApiBase = this.wsApiBase;
    this.timePath = String(timePath || "");
    this.pingPath = String(pingPath || "");

    this.depthSpeed = DEPTH_SPEEDS.has(depthSpeed) ? depthSpeed : "100ms";

    const normalizedDepthLevels = Number(depthLevels);
    const initialDepthLevels = PARTIAL_DEPTH_LEVELS.has(normalizedDepthLevels)
      ? normalizedDepthLevels
      : DEFAULT_DEPTH_LEVELS;
    this.depthDisplayLevels = initialDepthLevels;
    this.depthStreamLevels = initialDepthLevels;
    this.depthMode = "partial";

    this.preflightBalanceCheck = Boolean(preflightBalanceCheck);
    this.publicHttpsAgent = null;
    this.publicHostHeader = null;
    this.marketWebSocketOptions = null;
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 1_000,
      maxSockets: 16,
      maxFreeSockets: 8,
      scheduling: "lifo",
    });

    this.serverTimeOffsetMs = 0;
    this.tradingServerTimeOffsetMs = 0;
    this.serverTimeCache = new Map();
    this.serverTimeSyncPromises = new Map();
    this.serverTimeRefreshTimer = null;

    this.marketSocket = null;
    this.marketSymbol = null;
    this.marketManualClose = false;
    this.marketReconnectTimer = null;
    this.marketReconnectDelayMs = 1_000;
    this.tradeSocket = null;
    this.tradeReconnectTimer = null;
    this.tradeReconnectDelayMs = 1_000;

    this.exchangeInfoCache = new Map();
    this.lastTradePriceCache = new Map();
    this.tickerPricePath = String(tickerPricePath || "");
    this.userDataSocket = null;
    this.userDataManualClose = false;
    this.userDataReconnectTimer = null;
    this.userDataReconnectDelayMs = 1_000;
    this.tradingWsApiSocket = null;
    this.tradingWsApiConnectionPromise = null;
    this.tradingWsApiManualClose = false;
    this.tradingWsApiReconnectTimer = null;
    this.tradingWsApiReconnectDelayMs = 1_000;
    this.tradingWsApiHeartbeatTimer = null;
    this.tradingWsApiHeartbeatAlive = true;
    this.tradingWsApiHeartbeatStartedAt = null;
    this.wsApiPendingRequests = new Map();
  }

  emitApiLatency({
    operation,
    transport,
    startedAt,
    elapsedMs,
    success = true,
    status,
    background = false,
  } = {}) {
    const measuredElapsedMs = Number.isFinite(Number(elapsedMs))
      ? Number(elapsedMs)
      : performance.now() - Number(startedAt);
    if (!Number.isFinite(measuredElapsedMs) || measuredElapsedMs < 0) {
      return null;
    }

    const payload = {
      marketType: this.marketType,
      operation: String(operation || "Binance API"),
      transport: String(transport || "unknown"),
      elapsedMs: Number(measuredElapsedMs.toFixed(3)),
      success: Boolean(success),
      background: Boolean(background),
      time: Date.now(),
      ...(status === undefined ? {} : { status: Number(status) }),
    };
    this.emit("latency-update", payload);
    return payload;
  }

  reportWsApiLatency(pending, details = {}) {
    if (!pending || pending.latencyReported) return null;
    pending.latencyReported = true;
    return this.emitApiLatency({
      operation: pending.method,
      transport: "websocket-api",
      startedAt: pending.startedAt,
      ...details,
    });
  }

  attachOrderAttempt(error, params = {}) {
    const status = error?.data?.executionStatus === "UNKNOWN"
      ? "UNKNOWN"
      : "REJECTED";
    const orderAttempt = {
      ...params,
      marketType: this.marketType,
      status,
      rejectReason: error?.message || "订单未被接受",
      updateTime: Date.now(),
    };
    error.data = { ...(error.data || {}), orderAttempt };
    this.emit("order-state-update", orderAttempt);
    return error;
  }

  buildBrokerClientOrderId(existingClientOrderId) {
    const existing = String(existingClientOrderId || "").trim();
    if (!this.brokerLinkId) return existing || undefined;

    if (!/^[A-Za-z0-9]+$/.test(this.brokerLinkId)) {
      throw new BinanceApiError(
        `经纪商 LinkID 格式无效：${this.brokerLinkId}`
      );
    }

    const prefix = `x-${this.brokerLinkId}-`;
    const suffix = existing.startsWith(prefix)
      ? existing.slice(prefix.length)
      : existing || `${Date.now()}${crypto.randomBytes(4).toString("hex")}`;
    const clientOrderId = `${prefix}${suffix}`;

    if (!CLIENT_ORDER_ID_PATTERN.test(clientOrderId)) {
      throw new BinanceApiError(
        "拼接 LinkID 后的 newClientOrderId 必须为 1-36 个受支持字符。"
      );
    }

    return clientOrderId;
  }

  async initialize() {
    await this.syncServerTime();
    clearInterval(this.serverTimeRefreshTimer);
    this.serverTimeRefreshTimer = setInterval(() => {
      this.syncServerTime().catch((error) => {
        this.emit("user-data-error", {
          message: `后台服务器时间同步失败：${error.message}`,
          time: Date.now(),
        });
      });
    }, SERVER_TIME_REFRESH_INTERVAL_MS);
    this.serverTimeRefreshTimer.unref?.();

    this.startTradingWebSocketInBackground();
  }

  async syncServerTime() {
    const baseUrls = [...new Set([this.restBase, this.tradingRestBase])];
    const settledResults = await Promise.allSettled(
      baseUrls.map((baseUrl) => this.syncServerTimeForBase(baseUrl))
    );
    const tradingIndex = baseUrls.indexOf(this.tradingRestBase);
    const tradingResult = settledResults[tradingIndex];
    if (tradingResult.status === "rejected") throw tradingResult.reason;
    return tradingResult.value;
  }

  async syncTradingServerTime() {
    return this.syncServerTimeForBase(this.tradingRestBase);
  }

  async syncServerTimeForBase(baseUrl) {
    const pendingSync = this.serverTimeSyncPromises.get(baseUrl);
    if (pendingSync) {
      return pendingSync;
    }

    const syncPromise = (async () => {
      const before = Date.now();
      const result = await this.requestPublicGet(this.timePath, {}, baseUrl);
      const after = Date.now();

      const localMidpoint = Math.floor((before + after) / 2);
      const offsetMs = Number(result.serverTime) - localMidpoint;
      const synchronized = {
        serverTime: Number(result.serverTime),
        localMidpoint,
        offsetMs,
        baseUrl,
        synchronizedAt: after,
        reused: false,
      };

      this.serverTimeCache.set(baseUrl, synchronized);
      if (baseUrl === this.tradingRestBase) {
        this.tradingServerTimeOffsetMs = offsetMs;
      }
      if (baseUrl === this.restBase) {
        this.serverTimeOffsetMs = offsetMs;
      }

      return synchronized;
    })();

    this.serverTimeSyncPromises.set(baseUrl, syncPromise);
    try {
      return await syncPromise;
    } finally {
      if (this.serverTimeSyncPromises.get(baseUrl) === syncPromise) {
        this.serverTimeSyncPromises.delete(baseUrl);
      }
    }
  }

  async ensureServerTimeForBase(baseUrl) {
    const cached = this.serverTimeCache.get(baseUrl);
    const ageMs = cached ? Date.now() - cached.synchronizedAt : Infinity;

    if (cached && ageMs < SERVER_TIME_CACHE_TTL_MS) {
      return { ...cached, ageMs, reused: true };
    }

    return this.syncServerTimeForBase(baseUrl);
  }

  async ensureTradingServerTime() {
    return this.ensureServerTimeForBase(this.tradingRestBase);
  }

  getTimestamp(baseUrl = this.tradingRestBase) {
    const offsetMs = this.serverTimeCache.get(baseUrl)?.offsetMs ??
      (baseUrl === this.tradingRestBase
        ? this.tradingServerTimeOffsetMs
        : this.serverTimeOffsetMs);
    return Date.now() + offsetMs;
  }

  assertTradingCredentials() {
    if (!this.apiKey || !this.apiSecret) {
      throw new BinanceApiError(
        "缺少当前环境的 U 本位 API Key 或 API Secret；行情可连接，但不能查询账户、下单或撤单。"
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

  guardRateLimit({ operation, critical = false } = {}) {
    if (!this.rateLimitCoordinator) return;
    try {
      this.rateLimitCoordinator.beforeRequest({
        critical,
        marketType: this.marketType,
      });
    } catch (error) {
      throw new BinanceApiError(error.message, {
        status: 429,
        code: -1003,
        data: {
          ...(error.data || {}),
          localRateLimitGuard: true,
          operation,
        },
      });
    }
  }

  observeRateLimit(details = {}) {
    if (!this.rateLimitCoordinator) return null;
    const snapshot = this.rateLimitCoordinator.observe({
      marketType: this.marketType,
      ...details,
    });
    this.emit("rate-limit-update", snapshot);
    return snapshot;
  }

  async request(
    method,
    path,
    params = {},
    signed = false,
    baseUrl = this.restBase,
    requestOptions = {}
  ) {
    const upperMethod = String(method).toUpperCase();
    const operation = `${upperMethod} ${path}`;
    const critical = requestOptions.critical === true || path.endsWith("/time") ||
      (signed && ["POST", "PUT", "DELETE"].includes(upperMethod));
    this.guardRateLimit({ operation, critical });
    const normalized = this.normalizeParams(params);

    if (signed) {
      this.assertTradingCredentials();

      normalized.recvWindow ??= "5000";
      normalized.timestamp = String(this.getTimestamp(baseUrl));

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

    const isPublicBase = baseUrl === this.restBase;
    if (isPublicBase && this.publicHostHeader) {
      headers.Host = this.publicHostHeader;
    }

    let response;
    const requestStartedAt = performance.now();
    try {
      response = await requestHttps(url, {
        method,
        headers,
        timeout: 10_000,
        agent: isPublicBase && this.publicHttpsAgent
          ? this.publicHttpsAgent
          : this.httpsAgent,
      });
    } catch (error) {
      this.emitApiLatency({
        operation: `${String(method).toUpperCase()} ${path}`,
        transport: "https-keepalive",
        startedAt: requestStartedAt,
        success: false,
      });
      throw new BinanceApiError(`请求 Binance 失败：${error.message}`, {
        data: { cause: error.name },
      });
    }

    this.emitApiLatency({
      operation,
      transport: "https-keepalive",
      startedAt: requestStartedAt,
      success: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
    });
    this.observeRateLimit({
      headers: response.headers,
      status: response.statusCode,
    });

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

  async requestPublicGet(
    path,
    params = {},
    baseUrl = this.restBase,
    options = {}
  ) {
    return this.request("GET", path, params, false, baseUrl, options);
  }

  validateSymbol(symbol) {
    const normalized = String(symbol || "").trim().toUpperCase();

    if (!/^[A-Z0-9]{5,20}$/.test(normalized)) {
      throw new BinanceApiError(`交易对格式非法：${symbol}`);
    }

    return normalized;
  }

  async ping() {
    await this.requestPublicGet(this.pingPath);
    return {
      connected: true,
      environment: this.testnet ? "testnet" : "production",
      marketType: this.marketType,
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
    if (!isPositiveDecimal(value) || !isPositiveDecimal(step)) {
      return String(value);
    }
    return alignDecimalToStep(value, step, mode);
  }

  assertFilterRange(name, value, min, max) {
    if (isPositiveDecimal(min) && compareDecimal(value, min) < 0) {
      throw new BinanceApiError(`${name} ${value} 小于当前环境允许的最小值 ${min}。`);
    }
    if (isPositiveDecimal(max) && compareDecimal(value, max) > 0) {
      throw new BinanceApiError(`${name} ${value} 大于当前环境允许的最大值 ${max}。`);
    }
  }

  assertPositiveOrderAmount(name, value) {
    if (!isPositiveDecimal(value)) {
      throw new BinanceApiError(`${name} 必须是大于 0 的数字。`);
    }
    return String(value);
  }

  requireSelfTradePrevention(symbolInfo) {
    const allowedModes = Array.isArray(
      symbolInfo?.allowedSelfTradePreventionModes
    )
      ? symbolInfo.allowedSelfTradePreventionModes.map((mode) =>
          String(mode).toUpperCase()
        )
      : [];

    if (
      allowedModes.length &&
      !allowedModes.includes(this.selfTradePreventionMode)
    ) {
      throw new BinanceApiError(
        `${symbolInfo?.symbol || "当前交易对"} 不允许 ` +
        `${this.selfTradePreventionMode} 自成交预防模式；允许值：` +
        `${allowedModes.join(", ")}。`
      );
    }

    return this.selfTradePreventionMode;
  }

  describeSelfTradePrevention() {
    return {
      mode: this.selfTradePreventionMode,
      enforced: true,
      scope: "同一账户，或由 Binance 配置为相同 tradeGroupId 的 U 本位账户",
    };
  }

  async resolveTotalOrderReferencePrice(symbol, preferredPrices = []) {
    for (const candidate of preferredPrices) {
      const price = String(candidate?.value ?? "");
      if (isPositiveDecimal(price)) {
        return { price, source: candidate.source };
      }
    }

    const cached = this.lastTradePriceCache.get(symbol);
    if (
      cached &&
      Date.now() - cached.loadedAt <= DYNAMIC_PRICE_MAX_AGE_MS &&
      isPositiveDecimal(cached.price)
    ) {
      return { price: String(cached.price), source: "最新成交价缓存" };
    }

    const ticker = await this.request("GET", this.tickerPricePath, { symbol });
    const price = String(ticker.price ?? "");
    if (!isPositiveDecimal(price)) {
      throw new BinanceApiError(`${symbol} 没有可用于总价换算的有效行情价格。`);
    }
    return { price, source: "ticker 最新价" };
  }

  async signedRest(method, path, params = {}, options = {}) {
    this.assertTradingCredentials();
    await this.ensureTradingServerTime();
    return this.request(
      method,
      path,
      params,
      true,
      this.tradingRestBase,
      options
    );
  }

  async signedWsOrRest(
    wsMethod,
    restMethod,
    restPath,
    params = {},
    options = {}
  ) {
    const { result } = await this.requestWsApiWithRestFallback(
      wsMethod,
      params,
      () => this.request(
        restMethod,
        restPath,
        params,
        true,
        this.tradingRestBase,
        { critical: options.critical === true }
      ),
      options
    );
    return result;
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

  createSignedWsApiParams(params = {}) {
    const signedParams = this.normalizeParams({
      ...params,
      recvWindow: params.recvWindow || 5_000,
      apiKey: this.apiKey,
      timestamp: this.getTimestamp(this.tradingRestBase),
    });
    signedParams.signature = this.createWsApiSignature(signedParams);
    return signedParams;
  }

  createWsTransportError(message, details = {}) {
    return new BinanceApiError(message, {
      data: {
        transport: "websocket",
        transportFailure: true,
        ...details,
      },
    });
  }

  isWsTransportError(error) {
    return error?.data?.transport === "websocket" &&
      error?.data?.transportFailure === true;
  }

  startTradingWebSocketInBackground() {
    if (!this.apiKey || !this.apiSecret || !this.tradingWsApiBase) return;
    this.tradingWsApiManualClose = false;
    this.connectTradingWebSocket().catch((error) => {
      this.lastTradingWsApiError = {
        message: error.message,
        time: Date.now(),
      };
    });
  }

  connectTradingWebSocket() {
    if (!this.tradingWsApiBase) {
      return Promise.reject(this.createWsTransportError(
        "当前市场不支持 Binance WebSocket API。",
        { requestSent: false }
      ));
    }
    if (this.tradingWsApiSocket?.readyState === WebSocket.OPEN) {
      return Promise.resolve({
        connected: true,
        reused: true,
        url: this.tradingWsApiBase,
      });
    }
    if (this.tradingWsApiConnectionPromise) {
      return this.tradingWsApiConnectionPromise;
    }

    clearTimeout(this.tradingWsApiReconnectTimer);
    this.tradingWsApiReconnectTimer = null;
    this.tradingWsApiManualClose = false;
    const connectionPromise = this.openTradingWebSocket();
    this.tradingWsApiConnectionPromise = connectionPromise;
    connectionPromise.finally(() => {
      if (this.tradingWsApiConnectionPromise === connectionPromise) {
        this.tradingWsApiConnectionPromise = null;
      }
    }).catch(() => {});
    return connectionPromise;
  }

  openTradingWebSocket() {
    return new Promise((resolve, reject) => {
      const url = this.tradingWsApiBase;
      let socket;
      let opened = false;
      let settled = false;
      let lastError = null;

      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };

      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(this.createWsTransportError(
          `Binance WebSocket API 连接失败：${error.message}`,
          { cause: error.name, url, requestSent: false }
        ));
        return;
      }

      this.tradingWsApiSocket = socket;
      const connectTimeoutId = setTimeout(() => {
        if (opened) return;
        const error = this.createWsTransportError(
          "Binance WebSocket API 连接超时。",
          { url, requestSent: false }
        );
        settle(reject, error);
        socket.terminate();
      }, WS_API_CONNECT_TIMEOUT_MS);

      socket.on("open", () => {
        opened = true;
        clearTimeout(connectTimeoutId);
        this.tradingWsApiReconnectDelayMs = 1_000;
        this.lastTradingWsApiError = null;
        this.startTradingWebSocketHeartbeat(socket);
        settle(resolve, { connected: true, reused: false, url });
      });

      socket.on("message", (buffer) => {
        let message;
        try {
          message = JSON.parse(buffer.toString());
        } catch {
          return;
        }
        if (message?.event?.e === "serverShutdown") {
          socket.close(1012, "server shutdown");
          return;
        }
        this.handleWsApiResponse(message, socket);
      });

      socket.on("pong", () => {
        if (this.tradingWsApiSocket === socket) {
          this.tradingWsApiHeartbeatAlive = true;
          if (this.tradingWsApiHeartbeatStartedAt !== null) {
            this.emitApiLatency({
              operation: "ping/pong 心跳",
              transport: "websocket-heartbeat",
              startedAt: this.tradingWsApiHeartbeatStartedAt,
              success: true,
              background: true,
            });
            this.tradingWsApiHeartbeatStartedAt = null;
          }
        }
      });

      socket.on("error", (error) => {
        lastError = error;
        if (!opened) {
          clearTimeout(connectTimeoutId);
          settle(reject, this.createWsTransportError(
            `Binance WebSocket API 连接失败：${error.message}`,
            { cause: error.name, url, requestSent: false }
          ));
        }
      });

      socket.on("close", (code, reasonBuffer) => {
        clearTimeout(connectTimeoutId);
        const wasCurrentSocket = this.tradingWsApiSocket === socket;
        if (wasCurrentSocket) this.stopTradingWebSocketHeartbeat();
        const reason = reasonBuffer?.toString() || "";
        const error = this.createWsTransportError(
          opened
            ? "Binance WebSocket API 持久连接已关闭。"
            : `Binance WebSocket API 连接失败：${lastError?.message || reason || code}`,
          { code, reason, url, requestSent: false }
        );
        if (!opened) settle(reject, error);
        this.rejectWsApiRequestsForSocket(socket, error);
        if (wasCurrentSocket) {
          this.tradingWsApiSocket = null;
        }
        if (wasCurrentSocket && !this.tradingWsApiManualClose) {
          this.scheduleTradingWebSocketReconnect();
        }
      });
    });
  }

  startTradingWebSocketHeartbeat(socket) {
    this.stopTradingWebSocketHeartbeat();
    this.tradingWsApiHeartbeatAlive = true;
    this.tradingWsApiHeartbeatTimer = setInterval(() => {
      if (
        this.tradingWsApiSocket !== socket ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      if (!this.tradingWsApiHeartbeatAlive) {
        if (this.tradingWsApiHeartbeatStartedAt !== null) {
          this.emitApiLatency({
            operation: "ping/pong 心跳",
            transport: "websocket-heartbeat",
            startedAt: this.tradingWsApiHeartbeatStartedAt,
            success: false,
            background: true,
          });
          this.tradingWsApiHeartbeatStartedAt = null;
        }
        socket.terminate();
        return;
      }
      this.tradingWsApiHeartbeatAlive = false;
      this.tradingWsApiHeartbeatStartedAt = performance.now();
      try {
        socket.ping();
      } catch {
        this.emitApiLatency({
          operation: "ping/pong 心跳",
          transport: "websocket-heartbeat",
          startedAt: this.tradingWsApiHeartbeatStartedAt,
          success: false,
          background: true,
        });
        this.tradingWsApiHeartbeatStartedAt = null;
        socket.terminate();
      }
    }, WS_API_HEARTBEAT_INTERVAL_MS);
    this.tradingWsApiHeartbeatTimer.unref?.();
  }

  stopTradingWebSocketHeartbeat() {
    clearInterval(this.tradingWsApiHeartbeatTimer);
    this.tradingWsApiHeartbeatTimer = null;
    this.tradingWsApiHeartbeatStartedAt = null;
  }

  scheduleTradingWebSocketReconnect() {
    if (this.tradingWsApiManualClose || !this.tradingWsApiBase) return;
    clearTimeout(this.tradingWsApiReconnectTimer);
    const delay = this.tradingWsApiReconnectDelayMs;
    this.tradingWsApiReconnectDelayMs = Math.min(delay * 2, 30_000);
    this.tradingWsApiReconnectTimer = setTimeout(() => {
      this.connectTradingWebSocket().catch(() => {});
    }, delay);
    this.tradingWsApiReconnectTimer.unref?.();
  }

  disconnectTradingWebSocket(manual = true) {
    this.tradingWsApiManualClose = manual;
    clearTimeout(this.tradingWsApiReconnectTimer);
    this.tradingWsApiReconnectTimer = null;
    this.stopTradingWebSocketHeartbeat();
    const socket = this.tradingWsApiSocket;
    this.tradingWsApiSocket = null;
    if (!socket) return { disconnected: true };

    this.rejectWsApiRequestsForSocket(
      socket,
      this.createWsTransportError(
        "Binance WebSocket API 持久连接已断开。",
        { requestSent: false }
      )
    );
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "client disconnect");
    } else {
      socket.terminate();
    }
    return { disconnected: true };
  }

  getTradingWebSocketStatus() {
    const readyState = this.tradingWsApiSocket?.readyState;
    const statusByReadyState = {
      [WebSocket.CONNECTING]: "connecting",
      [WebSocket.OPEN]: "connected",
      [WebSocket.CLOSING]: "closing",
      [WebSocket.CLOSED]: "disconnected",
    };
    return {
      status: statusByReadyState[readyState] || "disconnected",
      url: this.tradingWsApiBase,
      reconnectDelayMs: this.tradingWsApiReconnectDelayMs,
      lastError: this.lastTradingWsApiError || null,
    };
  }

  getPersistentWsApiSocket(url = this.wsApiBase) {
    if (
      url === this.tradingWsApiBase &&
      this.tradingWsApiSocket?.readyState === WebSocket.OPEN
    ) {
      return this.tradingWsApiSocket;
    }
    return null;
  }

  async ensureTradingWebSocketReady() {
    const existing = this.getPersistentWsApiSocket(this.tradingWsApiBase);
    if (existing) return existing;

    await this.connectTradingWebSocket();
    const connected = this.getPersistentWsApiSocket(this.tradingWsApiBase);
    if (!connected) {
      throw this.createWsTransportError(
        "Binance WebSocket API 连接完成后仍不可用。",
        { url: this.tradingWsApiBase, requestSent: false }
      );
    }
    return connected;
  }

  async requestWsApiWithRestFallback(
    method,
    params,
    restFallback,
    {
      retrySafe = true,
      waitForWebSocketReady = false,
      critical = false,
    } = {}
  ) {
    this.assertTradingCredentials();
    await this.ensureTradingServerTime();
    let socket = this.getPersistentWsApiSocket(this.tradingWsApiBase);
    let connectionError = null;

    if (!socket && waitForWebSocketReady) {
      try {
        socket = await this.ensureTradingWebSocketReady();
      } catch (error) {
        if (!this.isWsTransportError(error)) throw error;
        connectionError = error;
      }
    }

    if (!socket) {
      this.startTradingWebSocketInBackground();
      return {
        result: await restFallback(),
        transport: "https-keepalive",
        fallbackReason: connectionError?.message || "websocket-not-connected",
      };
    }

    try {
      return {
        result: await this.requestWsApiOnSocket(
          socket,
          method,
          this.createSignedWsApiParams(params),
          { url: this.tradingWsApiBase, critical }
        ),
        transport: "websocket",
      };
    } catch (error) {
      if (!this.isWsTransportError(error)) throw error;
      if (
        this.tradingWsApiSocket === socket &&
        socket.readyState === WebSocket.OPEN
      ) {
        socket.terminate();
      }
      this.startTradingWebSocketInBackground();
      if (!retrySafe && error.data?.requestSent) {
        throw new BinanceApiError(
          `${error.message} 请求可能已经到达 Binance，为避免重复操作未自动改用 HTTP。请通过订单状态确认结果。`,
          {
            data: {
              ...error.data,
              executionStatus: "UNKNOWN",
              method,
            },
          }
        );
      }
      return {
        result: await restFallback(),
        transport: "https-keepalive-fallback",
        fallbackReason: error.message,
      };
    }
  }

  requestWsApiOnSocket(
    socket,
    method,
    params,
    { url = this.wsApiBase, critical = false } = {}
  ) {
    return new Promise((resolve, reject) => {
      try {
        this.guardRateLimit({
          operation: method,
          critical: critical === true ||
            /(?:^|\.)(?:place|cancel|cancelAll|amend|modify)$/.test(method) ||
            method === "order.cancelReplace",
        });
      } catch (error) {
        reject(error);
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) {
        reject(this.createWsTransportError(
          "Binance WebSocket API 持久连接不可用。",
          { method, url, readyState: socket.readyState, requestSent: false }
        ));
        return;
      }

      const id = crypto.randomUUID();
      const startedAt = performance.now();
      const timeoutId = setTimeout(() => {
        const pending = this.wsApiPendingRequests.get(id);
        if (!pending) return;
        this.wsApiPendingRequests.delete(id);
        this.reportWsApiLatency(pending, { success: false });
        reject(this.createWsTransportError(
          "Binance WebSocket API 请求超时。",
          { method, url, requestSent: pending.requestSent }
        ));
        if (this.tradingWsApiSocket === socket) socket.terminate();
      }, WS_API_REQUEST_TIMEOUT_MS);

      const pending = {
        socket,
        method,
        url,
        timeoutId,
        startedAt,
        latencyReported: false,
        requestSent: false,
        resolve,
        reject,
      };
      this.wsApiPendingRequests.set(id, pending);

      try {
        socket.send(JSON.stringify({ id, method, params }));
        pending.requestSent = true;
      } catch (error) {
        clearTimeout(timeoutId);
        this.wsApiPendingRequests.delete(id);
        this.reportWsApiLatency(pending, { success: false });
        reject(this.createWsTransportError(
          `Binance WebSocket API 请求发送失败：${error.message}`,
          { cause: error.name, method, url, requestSent: false }
        ));
      }
    });
  }

  handleWsApiResponse(message, socket) {
    const pending = this.wsApiPendingRequests.get(message?.id);
    if (!pending || pending.socket !== socket) {
      return false;
    }

    clearTimeout(pending.timeoutId);
    this.wsApiPendingRequests.delete(message.id);
    const success = !message.error &&
      (message.status === undefined ||
        (message.status >= 200 && message.status < 300));
    this.reportWsApiLatency(pending, {
      success,
      status: message.status,
    });
    this.observeRateLimit({
      rateLimits: message.rateLimits,
      status: message.status,
    });

    if (!success) {
      const apiError = message.error || {};
      pending.reject(new BinanceApiError(
        apiError.msg || `Binance WebSocket API HTTP ${message.status}`,
        {
          status: message.status,
          code: apiError.code,
          data: message,
        }
      ));
    } else {
      pending.resolve(message.result);
    }

    return true;
  }

  rejectWsApiRequestsForSocket(socket, error) {
    for (const [id, pending] of this.wsApiPendingRequests) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timeoutId);
      this.wsApiPendingRequests.delete(id);
      this.reportWsApiLatency(pending, { success: false });
      pending.reject(this.createWsTransportError(error.message, {
        ...error.data,
        method: pending.method,
        requestSent: pending.requestSent,
      }));
    }
  }

  setDepthLevels(levels) {
    const normalizedLevels = Number(levels);
    if (!PARTIAL_DEPTH_LEVELS.has(normalizedLevels)) {
      throw new TypeError("行情档位只支持 5、10 或 20 档。");
    }

    this.depthDisplayLevels = normalizedLevels;
    this.depthStreamLevels = normalizedLevels;
    return normalizedLevels;
  }

  connectDepth(symbol, { depthLevels } = {}) {
    const normalizedSymbol = this.validateSymbol(symbol);
    if (depthLevels !== undefined) {
      this.setDepthLevels(depthLevels);
    }
    this.disconnectMarket();

    this.marketSymbol = normalizedSymbol;
    this.marketManualClose = false;
    this.marketReconnectDelayMs = 1_000;
    this.tradeReconnectDelayMs = 1_000;

    // 页面加载行情后立即预热下单所需的静态交易规则，避免首次按键下单
    // 才去等待 exchangeInfo。
    this.exchangeInfo(normalizedSymbol).catch((error) => {
      this.emit("market-error", {
        message: `下单规则预热失败：${error.message}`,
        symbol: normalizedSymbol,
        time: Date.now(),
      });
    });

    this.openDepthSocket();
    this.openTradeSocket();

    return {
      symbol: normalizedSymbol,
      stream: this.getDepthStreamName(normalizedSymbol),
      depthMode: this.depthMode,
      streamLevels: this.depthStreamLevels,
      displayLevels: this.depthDisplayLevels,
    };
  }

  getDepthStreamName(symbol) {
    return `${symbol.toLowerCase()}@depth${this.depthStreamLevels}@${this.depthSpeed}`;
  }

  openTradeSocket() {
    if (!this.marketSymbol || this.marketManualClose) {
      return;
    }

    const symbol = this.marketSymbol;
    const url = `${this.wsBase}/${symbol.toLowerCase()}@trade`;
    const connectStartedAt = performance.now();
    const socket = this.createMarketWebSocket(url);
    let connected = false;
    let connectLatencyReported = false;
    const reportConnectLatency = (success) => {
      if (connectLatencyReported) return;
      connectLatencyReported = true;
      this.emitApiLatency({
        operation: `${symbol.toLowerCase()}@trade 连接`,
        transport: "websocket-stream",
        startedAt: connectStartedAt,
        success,
      });
    };
    this.tradeSocket = socket;

    socket.on("open", () => {
      if (this.tradeSocket === socket) {
        connected = true;
        reportConnectLatency(true);
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

        const receivedAt = Date.now();
        this.lastTradePriceCache.set(symbol, {
          price: String(message.p),
          loadedAt: receivedAt,
          eventTime: Number(message.E),
        });

        this.emit("trade-update", {
          marketType: this.marketType,
          symbol: message.s || symbol,
          price: String(message.p),
          quantity: String(message.q),
          tradeId: Number(message.t),
          eventTime: Number(message.E),
          tradeTime: Number(message.T),
          receivedAt,
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
      if (!connected) reportConnectLatency(false);
      this.emit("market-error", {
        message: `成交行情连接失败：${error.message}`,
        symbol,
        time: Date.now(),
      });
    });

    socket.on("close", () => {
      if (!connected) reportConnectLatency(false);
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
    const streamName = this.getDepthStreamName(symbol);
    const url = `${this.wsBase}/${streamName}`;
    const connectStartedAt = performance.now();
    const socket = this.createMarketWebSocket(url);
    let connected = false;
    let connectLatencyReported = false;
    const reportConnectLatency = (success) => {
      if (connectLatencyReported) return;
      connectLatencyReported = true;
      this.emitApiLatency({
        operation: `${streamName} 连接`,
        transport: "websocket-stream",
        startedAt: connectStartedAt,
        success,
      });
    };

    this.marketSocket = socket;

    socket.on("open", () => {
      if (this.marketSocket !== socket) {
        return;
      }

      connected = true;
      reportConnectLatency(true);
      this.marketReconnectDelayMs = 1_000;
      this.emit("market-status", {
        status: "connected",
        marketType: this.marketType,
        symbol,
        url,
        depthMode: this.depthMode,
        streamLevels: this.depthStreamLevels,
        time: Date.now(),
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

      if (
        message.e !== "depthUpdate" ||
        !Array.isArray(message.b) ||
        !Array.isArray(message.a)
      ) {
        return;
      }
      this.emitPartialDepthUpdate(message, symbol);
    });

    socket.on("error", (error) => {
      if (!connected) reportConnectLatency(false);
      this.emit("market-error", {
        message: error.message,
        symbol,
        time: Date.now(),
      });
    });

    socket.on("close", (code, reasonBuffer) => {
      if (!connected) reportConnectLatency(false);
      if (this.marketSocket === socket) {
        this.marketSocket = null;
      }

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

  createMarketWebSocket(url) {
    return new WebSocket(url, this.marketWebSocketOptions || undefined);
  }

  normalizePartialDepthLevels(levels) {
    return (levels || [])
      .slice(0, this.depthDisplayLevels)
      .map(([price, quantity]) => ({
        price: String(price),
        quantity: String(quantity),
      }));
  }

  emitPartialDepthUpdate(message, symbol = this.marketSymbol) {
    const lastUpdateId = Number(message.u);
    const bids = this.normalizePartialDepthLevels(message.b);
    const asks = this.normalizePartialDepthLevels(message.a);

    this.emit("depth-update", {
      marketType: this.marketType,
      symbol: message.s || symbol,
      lastUpdateId: Number.isFinite(lastUpdateId) ? lastUpdateId : null,
      firstUpdateId: message.U === undefined ? null : Number(message.U),
      finalUpdateId: message.u === undefined ? null : Number(message.u),
      eventTime: message.E ?? null,
      receivedAt: Date.now(),
      streamLevels: this.depthStreamLevels,
      displayLevels: this.depthDisplayLevels,
      bids,
      asks,
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
      marketType: this.marketType,
      symbol: this.marketSymbol,
      time: Date.now(),
    });

    this.marketSymbol = null;
  }

  close() {
    clearInterval(this.serverTimeRefreshTimer);
    this.serverTimeRefreshTimer = null;
    this.disconnectMarket();
    this.disconnectUserData();
    this.disconnectTradingWebSocket();
    if (this.publicHttpsAgent && this.publicHttpsAgent !== this.httpsAgent) {
      this.publicHttpsAgent.destroy();
    }
    this.httpsAgent.destroy();
    this.removeAllListeners();
  }
}

module.exports = {
  BinanceClientBase,
  BinanceApiError,
  REQUIRED_SELF_TRADE_PREVENTION_MODE,
};
