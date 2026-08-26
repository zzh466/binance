const { execFile } = require("node:child_process");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const { promisify } = require("node:util");
const WebSocket = require("ws");
const { resolveCurlExecutable } = require("../platformSupport");
const {
  BinanceSpotClient,
  BinanceApiError,
} = require("./binanceSpotClient");

const FUTURES_REST_BASE = {
  testnet: "https://demo-fapi.binance.com",
  production: "https://fapi.binance.com",
};

const FUTURES_WS_BASE = {
  testnet: "wss://demo-fstream.binance.com/ws",
  production: "wss://fstream.binance.com/ws",
};

const FUTURES_WS_API_BASE = {
  testnet: "wss://testnet.binancefuture.com/ws-fapi/v1",
  production: "wss://ws-fapi.binance.com/ws-fapi/v1",
};

const FUTURES_DOH_ENDPOINT = "https://doh.pub/dns-query";
const FUTURES_REST_HOST = "fapi.binance.com";
const FUTURES_STREAM_HOST = "fstream.binance.com";
const FUTURES_FRONT_SNI = "data-stream.binance.vision";
const FUTURES_PUBLIC_REST_BASE = "https://d2ukl3c6tymv7q.cloudfront.net";
const FUTURES_STREAM_BOOTSTRAP_ADDRESSES = [
  "52.192.95.242",
  "54.150.96.238",
  "52.192.28.89",
  "52.195.59.139",
  "52.69.115.12",
  "54.64.207.111",
  "35.73.94.225",
  "43.206.204.231",
];
const execFileAsync = promisify(execFile);

function fetchJson(url, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { Accept: "application/dns-json" },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`DoH HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(chunks.join("")));
        } catch (error) {
          reject(new Error(`DoH 响应解析失败：${error.message}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("DoH 请求超时")));
    request.on("error", reject);
  });
}

function normalizeDohAnswers(payload, hostname) {
  const answers = Array.isArray(payload?.Answer) ? payload.Answer : [];
  const addresses = [...new Set(
    answers
      .filter((answer) => Number(answer.type) === 1)
      .map((answer) => String(answer.data || "").trim())
      .filter((address) => net.isIP(address) === 4)
  )];
  const canonicalName = answers
    .find((answer) => Number(answer.type) === 5)
    ?.data?.replace(/\.$/, "");

  if (!addresses.length) {
    throw new Error(`加密 DNS 未返回 ${hostname} 的 IPv4 地址。`);
  }

  return { hostname, addresses, canonicalName };
}

async function resolveOverDoh(hostname) {
  const query = new URLSearchParams({ name: hostname, type: "A" });
  const payload = await fetchJson(`${FUTURES_DOH_ENDPOINT}?${query}`);
  return normalizeDohAnswers(payload, hostname);
}

function createRotatingLookup(addresses) {
  let cursor = 0;
  return (_hostname, options, callback) => {
    const normalizedOptions = typeof options === "object" ? options : {};
    const normalizedCallback = typeof options === "function" ? options : callback;
    if (normalizedOptions.all) {
      normalizedCallback(null, addresses.map((address) => ({ address, family: 4 })));
      return;
    }
    const address = addresses[cursor % addresses.length];
    cursor += 1;
    normalizedCallback(null, address, 4);
  };
}

function probeFuturesStreamAddress(address, timeoutMs = 4_000) {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: address,
      port: 443,
      servername: FUTURES_FRONT_SNI,
      checkServerIdentity(_hostname, certificate) {
        return tls.checkServerIdentity(FUTURES_STREAM_HOST, certificate);
      },
      rejectUnauthorized: true,
    });
    const finish = (result) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once("secureConnect", () => finish(address));
    socket.once("error", () => finish(null));
  });
}

const FUTURES_TYPE_MAP = {
  LIMIT_MAKER: { type: "LIMIT", timeInForce: "GTX" },
  STOP_LOSS: { type: "STOP_MARKET" },
  STOP_LOSS_LIMIT: { type: "STOP" },
  TAKE_PROFIT_LIMIT: { type: "TAKE_PROFIT" },
  TAKE_PROFIT: { type: "TAKE_PROFIT_MARKET" },
};

class BinanceUsdMClient extends BinanceSpotClient {
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
    this.wsApiBase = this.testnet
      ? FUTURES_WS_API_BASE.testnet
      : FUTURES_WS_API_BASE.production;
    this.tradingWsApiBase = this.wsApiBase;
    this.timePath = "/fapi/v1/time";
    this.pingPath = "/fapi/v1/ping";
    this.depthPath = "/fapi/v1/depth";
    this.supportsAveragePriceStream = false;

    this.exchangeInfoSnapshot = null;
    this.futuresListenKey = null;
    this.futuresListenKeyKeepAliveTimer = null;
    this.productionMarketTransportPromise = null;
    this.platform = options.platform || process.platform;
    this.publicMarketFetch = options.publicMarketFetch || null;
    this.publicMarketTransport = null;
    this.publicMarketTimeoutMs = Math.max(
      1_000,
      Number(options.publicMarketTimeoutMs) || 6_000
    );
    this.curlExecutable = options.curlExecutable || resolveCurlExecutable();
    this.executeFile = options.executeFile || execFileAsync;
  }

  async ensureProductionMarketTransport() {
    if (this.testnet) return null;
    if (this.productionMarketTransportPromise) {
      return this.productionMarketTransportPromise;
    }

    this.productionMarketTransportPromise = (async () => {
      let resolvedAddresses = [];
      try {
        resolvedAddresses = (await resolveOverDoh(FUTURES_STREAM_HOST)).addresses;
      } catch {
        // DoH 在部分网络会被阻断或污染；下方证书探测会校验候选地址。
      }
      const candidates = [...new Set([
        ...resolvedAddresses,
        ...FUTURES_STREAM_BOOTSTRAP_ADDRESSES,
      ])];
      const streamAddresses = (await Promise.all(
        candidates.map((address) => probeFuturesStreamAddress(address))
      )).filter(Boolean);
      if (!streamAddresses.length) {
        throw new Error("没有通过 Binance 证书校验的 Futures 行情流节点。");
      }

      this.marketWebSocketOptions = {
        lookup: createRotatingLookup(streamAddresses),
        servername: FUTURES_FRONT_SNI,
        checkServerIdentity(_hostname, certificate) {
          return tls.checkServerIdentity(FUTURES_STREAM_HOST, certificate);
        },
      };

      return {
        restBase: this.restBase,
        streamAddresses,
      };
    })().catch((error) => {
      this.productionMarketTransportPromise = null;
      throw new BinanceApiError(`准备 Futures 行情直连失败：${error.message}`, {
        data: { cause: error.name },
      });
    });

    return this.productionMarketTransportPromise;
  }

  async request(method, path, params = {}, signed = false, baseUrl = this.restBase) {
    if (
      !this.testnet &&
      !signed &&
      String(method).toUpperCase() === "GET" &&
      path.startsWith("/fapi/v1/") &&
      baseUrl === this.restBase
    ) {
      return this.requestPublicMarketData(method, path, params);
    }
    return super.request(method, path, params, signed, baseUrl);
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
    try {
      const response = await this.publicMarketFetch(url, {
        method,
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const rawText = await response.text();
      return this.parsePublicMarketResponse(Number(response.status), rawText);
    } catch (error) {
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
    for (let attempt = 1; attempt <= 3; attempt += 1) {
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
        requestError = null;
        break;
      } catch (error) {
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
      throw new BinanceApiError("Binance Futures 行情响应缺少 HTTP 状态。");
    }
    const rawText = stdout.slice(0, markerIndex);
    const statusCode = Number(stdout.slice(markerIndex + marker.length).trim());
    return this.parsePublicMarketResponse(statusCode, rawText);
  }

  async connectDepth(symbol) {
    await this.ensureProductionMarketTransport();
    return super.connectDepth(symbol);
  }

  isFirstDepthEventApplicable(event, snapshotUpdateId) {
    return (
      Number(event.U) <= snapshotUpdateId &&
      snapshotUpdateId <= Number(event.u)
    );
  }

  applyDepthEventToOrderBook(event) {
    return this.orderBook.applyFuturesEvent(event);
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
    if (!forceRefresh && cached && Date.now() - cached.loadedAt < 300_000) {
      return cached.data;
    }

    if (
      forceRefresh ||
      !this.exchangeInfoSnapshot ||
      Date.now() - this.exchangeInfoSnapshot.loadedAt >= 300_000
    ) {
      const result = await this.request("GET", "/fapi/v1/exchangeInfo");
      this.exchangeInfoSnapshot = { loadedAt: Date.now(), data: result };
    }

    const result = this.exchangeInfoSnapshot.data;
    const symbolInfo = (result.symbols || []).find(
      (item) => item.symbol === normalizedSymbol
    );
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

  async prepareOrder(order) {
    const symbol = this.validateSymbol(order.symbol);
    const side = String(order.side || "").toUpperCase();
    const requestedType = String(order.type || "").toUpperCase();
    const mapped = FUTURES_TYPE_MAP[requestedType] || { type: requestedType };
    const type = mapped.type;
    const supportedTypes = new Set([
      "LIMIT",
      "MARKET",
      "STOP",
      "STOP_MARKET",
      "TAKE_PROFIT",
      "TAKE_PROFIT_MARKET",
    ]);

    if (!["BUY", "SELL"].includes(side)) {
      throw new BinanceApiError(`side 只支持 BUY 或 SELL，当前值：${side}`);
    }
    if (!supportedTypes.has(type)) {
      throw new BinanceApiError(`当前页面不支持该永续委托类型：${requestedType}`);
    }
    if (order.icebergQty) {
      throw new BinanceApiError("当前永续接口不支持页面里的 icebergQty 参数。");
    }
    if (order.trailingDelta) {
      throw new BinanceApiError("永续跟踪止损使用 callbackRate，不能直接使用 Spot trailingDelta。");
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
      timeInForce: mapped.timeInForce || order.timeInForce,
      quantity: order.quantity,
      price: order.price,
      stopPrice: order.stopPrice,
      newClientOrderId: order.newClientOrderId,
      newOrderRespType: order.newOrderRespType || "RESULT",
    });

    if (type === "LIMIT" || type === "STOP" || type === "TAKE_PROFIT") {
      params.timeInForce ||= "GTC";
    }
    if ((type === "LIMIT" || type === "STOP" || type === "TAKE_PROFIT") && !params.price) {
      throw new BinanceApiError(`${requestedType} 委托必须提供 price。`);
    }
    if (!params.quantity) {
      throw new BinanceApiError("永续委托必须提供 quantity。");
    }
    if ((type.includes("STOP") || type.includes("TAKE_PROFIT")) && !params.stopPrice) {
      throw new BinanceApiError(`${requestedType} 委托必须提供 stopPrice。`);
    }
    if (type === "MARKET" || type.endsWith("_MARKET")) {
      delete params.price;
      delete params.timeInForce;
    }
    if (!type.includes("STOP") && !type.includes("TAKE_PROFIT")) {
      delete params.stopPrice;
    }

    const adjustments = [];
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
      if (original !== params.stopPrice) adjustments.push(`stopPrice: ${original} -> ${params.stopPrice}`);
    }
    if (quantityFilter) {
      const original = params.quantity;
      params.quantity = this.alignToStep(params.quantity, quantityFilter.stepSize);
      this.assertFilterRange(
        "quantity",
        params.quantity,
        quantityFilter.minQty,
        quantityFilter.maxQty
      );
      if (original !== params.quantity) adjustments.push(`quantity: ${original} -> ${params.quantity}`);
    }

    const minNotional = filters.MIN_NOTIONAL?.notional || filters.MIN_NOTIONAL?.minNotional;
    const notional = Number(params.price || params.stopPrice || 0) * Number(params.quantity || 0);
    if (notional > 0 && Number(minNotional) > 0) {
      this.assertFilterRange("订单金额", notional, minNotional, undefined);
    }

    return { params, adjustments, symbolInfo };
  }

  async placeOrder(order, { testOnly = false } = {}) {
    const { params, adjustments } = await this.prepareOrder(order);
    let result;
    let transport;
    let fallbackReason;
    if (testOnly) {
      result = await this.signedRest("POST", "/fapi/v1/order/test", params);
      transport = "https-keepalive";
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
          { retrySafe: false }
        ));
    }
    return {
      ...result,
      marketType: this.marketType,
      testOnly,
      adjustments,
      transport,
      ...(fallbackReason ? { fallbackReason } : {}),
      preflightBalanceCheck: false,
    };
  }

  async cancelOrder({ symbol, orderId, origClientOrderId }) {
    if (!orderId && !origClientOrderId) {
      throw new BinanceApiError("撤单必须提供 orderId 或 origClientOrderId。");
    }
    const params = {
      symbol: this.validateSymbol(symbol),
      orderId,
      origClientOrderId,
    };
    const { result, transport, fallbackReason } =
      await this.requestWsApiWithRestFallback(
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
    return this.signedWsOrRest("order.status", "GET", "/fapi/v1/order", {
      symbol: this.validateSymbol(symbol),
      orderId,
      origClientOrderId,
    });
  }

  async openOrders({ symbol } = {}) {
    return this.signedRest("GET", "/fapi/v1/openOrders", {
      symbol: symbol ? this.validateSymbol(symbol) : undefined,
    });
  }

  async cancelAllOpenOrders({ symbol }) {
    const normalizedSymbol = this.validateSymbol(symbol);
    const existing = await this.openOrders({ symbol: normalizedSymbol });
    await this.signedRest("DELETE", "/fapi/v1/allOpenOrders", {
      symbol: normalizedSymbol,
    });
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
    return this.signedWsOrRest(
      "order.modify",
      "PUT",
      "/fapi/v1/order",
      {
        symbol: this.validateSymbol(symbol),
        orderId,
        origClientOrderId,
        side: current.side,
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
      symbol: this.validateSymbol(symbol),
      orderId,
      startTime,
      endTime,
      limit,
    });
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

  async accountStatus({ omitZeroBalances } = {}) {
    const account = await this.signedWsOrRest(
      "account.status",
      "GET",
      "/fapi/v2/account"
    );
    let assets = Array.isArray(account.assets) ? account.assets : [];
    if (omitZeroBalances) {
      assets = assets.filter((asset) =>
        Number(asset.walletBalance) !== 0 || Number(asset.unrealizedProfit) !== 0
      );
    }
    return {
      ...account,
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

  normalizeFuturesUserEvent(message) {
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
      n: order.n,
      N: order.N,
      t: order.t,
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

  openFuturesUserDataSocket() {
    const listenKey = this.futuresListenKey;
    if (!listenKey) {
      return Promise.reject(new BinanceApiError("永续账户事件缺少 listenKey。"));
    }

    return new Promise((resolve, reject) => {
      const url = `${this.wsBase}/${listenKey}`;
      const socket = new WebSocket(url);
      let connected = false;
      const timeoutId = setTimeout(() => {
        if (!connected) {
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
          reject(new BinanceApiError(`永续账户事件连接失败：${error.message}`));
        }
      });

      socket.on("close", (code, reasonBuffer) => {
        clearTimeout(timeoutId);
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
  FUTURES_WS_BASE,
  FUTURES_WS_API_BASE,
};
