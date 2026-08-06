const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const WebSocket = require("ws");
const { LocalOrderBook } = require("./localOrderBook");
const { SocksProxyAgent } = require("socks-proxy-agent");

const DEFAULT_SOCKS5_PROXY = "socks5h://139.224.34.110:1080";
const REST_BASE = {
  testnet: "https://testnet.binance.vision/api",
  production: "https://api.binance.com/api",
};

const WS_BASE = {
  testnet: "wss://stream.testnet.binance.vision/ws",
  production: "wss://stream.binance.com:9443/ws",
};

const DEPTH_SPEEDS = new Set(["100ms", "1000ms"]);
const DEPTH_SNAPSHOT_LIMITS = new Set([100, 500, 1000, 5000]);

function requestHttpsThroughProxy(url, options = {}) {
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
    socks5Proxy = DEFAULT_SOCKS5_PROXY,
    depthSpeed = "100ms",
    depthSnapshotLimit = 1000,
    depthDisplayLevels = 10,
  } = {}) {
    super();

    this.apiKey = apiKey.trim();
    this.apiSecret = apiSecret.trim();
    this.testnet = Boolean(testnet);
    this.socks5Proxy = String(socks5Proxy || DEFAULT_SOCKS5_PROXY).trim();
    this.proxyAgent = new SocksProxyAgent(this.socks5Proxy);

    this.restBase = this.testnet ? REST_BASE.testnet : REST_BASE.production;
    this.wsBase = this.testnet ? WS_BASE.testnet : WS_BASE.production;

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

    this.marketSocket = null;
    this.marketSymbol = null;
    this.marketManualClose = false;
    this.marketReconnectTimer = null;
    this.marketReconnectDelayMs = 1_000;

    this.orderBook = new LocalOrderBook();
    this.depthEventBuffer = [];
    this.depthReady = false;
    this.depthSyncVersion = 0;
  }

  async initialize() {
    await this.syncServerTime();
  }

  async syncServerTime() {
    const before = Date.now();
    const result = await this.request("GET", "/v3/time");
    const after = Date.now();

    const localMidpoint = Math.floor((before + after) / 2);
    this.serverTimeOffsetMs = Number(result.serverTime) - localMidpoint;

    return {
      serverTime: Number(result.serverTime),
      localMidpoint,
      offsetMs: this.serverTimeOffsetMs,
    };
  }

  getTimestamp() {
    return Date.now() + this.serverTimeOffsetMs;
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

  async request(method, path, params = {}, signed = false) {
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
    const url = `${this.restBase}${path}${query ? `?${query}` : ""}`;

    const headers = {
      Accept: "application/json",
    };

    if (this.apiKey) {
      headers["X-MBX-APIKEY"] = this.apiKey;
    }

    let response;
    try {
      response = await requestHttpsThroughProxy(url, {
        method,
        headers,
        agent: this.proxyAgent,
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

  async placeOrder(order) {
    const symbol = this.validateSymbol(order.symbol);
    const side = String(order.side || "").toUpperCase();
    const type = String(order.type || "").toUpperCase();

    if (!["BUY", "SELL"].includes(side)) {
      throw new BinanceApiError(`side 只支持 BUY 或 SELL，当前值：${side}`);
    }

    if (!["LIMIT", "MARKET"].includes(type)) {
      throw new BinanceApiError(
        `示例代码只支持 LIMIT 或 MARKET，当前值：${type}`
      );
    }

    const params = {
      symbol,
      side,
      type,
      newClientOrderId: order.newClientOrderId,
      newOrderRespType: order.newOrderRespType || "RESULT",
    };

    if (type === "LIMIT") {
      if (!order.quantity || !order.price) {
        throw new BinanceApiError("LIMIT 委托必须提供 quantity 和 price。");
      }

      params.timeInForce = order.timeInForce || "GTC";
      params.quantity = order.quantity;
      params.price = order.price;
    } else {
      if (order.quantity) {
        params.quantity = order.quantity;
      } else if (order.quoteOrderQty) {
        params.quoteOrderQty = order.quoteOrderQty;
      } else {
        throw new BinanceApiError(
          "MARKET 委托必须提供 quantity 或 quoteOrderQty。"
        );
      }
    }

    return this.request("POST", "/v3/order", params, true);
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

    return this.request("DELETE", "/v3/order", params, true);
  }

  connectDepth(symbol) {
    const normalizedSymbol = this.validateSymbol(symbol);
    this.disconnectMarket();

    this.marketSymbol = normalizedSymbol;
    this.marketManualClose = false;
    this.marketReconnectDelayMs = 1_000;

    this.openDepthSocket();

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

  openDepthSocket() {
    if (!this.marketSymbol || this.marketManualClose) {
      return;
    }

    const symbol = this.marketSymbol;
    const streamName = `${symbol.toLowerCase()}@depth@${this.depthSpeed}`;
    const url = `${this.wsBase}/${streamName}`;
    const socket = new WebSocket(url, { agent: this.proxyAgent });

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
    console.log(result)
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

  disconnectMarket() {
    this.marketManualClose = true;
    clearTimeout(this.marketReconnectTimer);
    this.marketReconnectTimer = null;
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

    this.emit("market-status", {
      status: "disconnected",
      symbol: this.marketSymbol,
      time: Date.now(),
    });

    this.marketSymbol = null;
  }

  close() {
    this.disconnectMarket();
    this.removeAllListeners();
  }
}

module.exports = {
  BinanceSpotClient,
  BinanceApiError,
};
