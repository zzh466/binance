const assert = require("node:assert/strict");
const test = require("node:test");
const { BinanceApiError } = require("../src/binance/binanceSpotClient");
const {
  BinanceUsdMClient,
  FUTURES_WS_API_BASE,
} = require("../src/binance/binanceUsdMClient");
const {
  BinanceUnifiedClient,
  MARKET_FUTURES,
  MARKET_SPOT,
} = require("../src/binance/binanceUnifiedClient");

function futuresSymbol(symbol = "SKHYUSDT") {
  return {
    symbol,
    status: "TRADING",
    contractType: "PERPETUAL",
    baseAsset: "SKHY",
    quoteAsset: "USDT",
    filters: [
      {
        filterType: "PRICE_FILTER",
        minPrice: "0.1",
        maxPrice: "1000000",
        tickSize: "0.1",
      },
      {
        filterType: "LOT_SIZE",
        minQty: "0.001",
        maxQty: "1000",
        stepSize: "0.001",
      },
      { filterType: "MIN_NOTIONAL", notional: "5" },
    ],
  };
}

function seedTradingTime(client) {
  client.serverTimeCache.set(client.tradingRestBase, {
    serverTime: Date.now(),
    localMidpoint: Date.now(),
    offsetMs: 0,
    baseUrl: client.tradingRestBase,
    synchronizedAt: Date.now(),
  });
}

function seedPositionMode(client, dualSidePosition = false) {
  client.positionModeCache = {
    dualSidePosition,
    positionMode: dualSidePosition ? "HEDGE" : "ONE_WAY",
    loadedAt: Date.now(),
  };
}

test("USDⓈ-M exchangeInfo 从 Futures 列表中解析指定合约", async () => {
  const client = new BinanceUsdMClient({ testnet: false });
  client.request = async (method, path) => {
    assert.equal(method, "GET");
    assert.equal(path, "/fapi/v1/exchangeInfo");
    return { symbols: [futuresSymbol()] };
  };

  const result = await client.exchangeInfo("skhyusdt");
  assert.equal(result.marketType, MARKET_FUTURES);
  assert.equal(result.symbol.symbol, "SKHYUSDT");
  assert.equal(result.symbol.contractType, "PERPETUAL");
  client.close();
});

test("永续下单通过 WebSocket 并映射 Spot 风格止损限价类型", async () => {
  const client = new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
    brokerLinkId: "tdk3UjFd",
  });
  client.exchangeInfo = async () => ({ symbol: futuresSymbol() });
  seedPositionMode(client);
  seedTradingTime(client);
  let submitted;
  const socket = {
    readyState: 1,
    send(payload) {
      submitted = JSON.parse(payload);
      setImmediate(() => client.handleWsApiResponse({
        id: submitted.id,
        status: 200,
        result: { symbol: submitted.params.symbol, orderId: 7, status: "NEW" },
      }, socket));
    },
    close() {
      this.readyState = 3;
    },
    terminate() {
      this.readyState = 3;
    },
  };
  client.tradingWsApiSocket = socket;

  const result = await client.placeOrder({
    symbol: "SKHYUSDT",
    side: "SELL",
    type: "STOP_LOSS_LIMIT",
    quantity: "0.0319",
    price: "200.19",
    stopPrice: "199.99",
    timeInForce: "GTC",
  });

  assert.equal(submitted.method, "order.place");
  assert.equal(submitted.params.type, "STOP");
  assert.equal(submitted.params.quantity, "0.031");
  assert.equal(submitted.params.price, "200.1");
  assert.equal(submitted.params.positionSide, "BOTH");
  assert.equal(submitted.params.newOrderRespType, "ACK");
  assert.equal(submitted.params.selfTradePreventionMode, "EXPIRE_MAKER");
  assert.match(
    submitted.params.newClientOrderId,
    /^x-tdk3UjFd-[0-9]{13}[a-f0-9]{8}$/
  );
  assert.ok(submitted.params.newClientOrderId.length <= 36);
  assert.equal(result.marketType, MARKET_FUTURES);
  assert.equal(result.transport, "websocket");
  assert.equal(result.selfTradePrevention.apiEffective, true);
  client.close();
});

test("统一客户端把现货和合约 LinkID 分别传给对应底层客户端", () => {
  const client = new BinanceUnifiedClient({
    spotBrokerLinkId: "P8DHAU8C",
    futuresBrokerLinkId: "tdk3UjFd",
  });

  assert.equal(client.spot.brokerLinkId, "P8DHAU8C");
  assert.equal(client.futures.brokerLinkId, "tdk3UjFd");
  client.close();
});

test("统一客户端把现货和永续的延迟事件路由到同一出口", async () => {
  const client = new BinanceUnifiedClient();
  const updates = [];
  client.on("latency-update", (payload) => updates.push(payload));

  client.spot.emit("latency-update", {
    operation: "GET /v3/time",
    transport: "https-keepalive",
    elapsedMs: 12.345,
  });
  client.futures.emit("latency-update", {
    operation: "ping/pong 心跳",
    transport: "websocket-heartbeat",
    elapsedMs: 8.765,
    background: true,
  });

  assert.deepEqual(updates, [
    {
      marketType: MARKET_SPOT,
      operation: "GET /v3/time",
      transport: "https-keepalive",
      elapsedMs: 12.345,
    },
    {
      marketType: MARKET_FUTURES,
      operation: "ping/pong 心跳",
      transport: "websocket-heartbeat",
      elapsedMs: 8.765,
      background: true,
    },
  ]);
  client.close();
});

test("未指定合约时同时连接现货和 U 本位账户订单事件", async () => {
  const client = new BinanceUnifiedClient({
    spotCredentials: { apiKey: "spot-key", apiSecret: "spot-secret" },
    futuresCredentials: { apiKey: "futures-key", apiSecret: "futures-secret" },
  });
  const connectedMarkets = [];
  client.spot.connectUserData = async () => {
    connectedMarkets.push(MARKET_SPOT);
    return { subscriptionId: "spot-subscription" };
  };
  client.futures.connectUserData = async () => {
    connectedMarkets.push(MARKET_FUTURES);
    return { subscriptionId: "futures-subscription" };
  };

  const result = await client.connectUserData();

  assert.deepEqual(connectedMarkets.sort(), [MARKET_FUTURES, MARKET_SPOT]);
  assert.equal(result.connected.spot.marketType, MARKET_SPOT);
  assert.equal(result.connected.futures.marketType, MARKET_FUTURES);
  assert.deepEqual(result.failedMarketTypes, []);
  client.close();
});

test("永续 exchangeInfo 过期后立即复用旧缓存并刷新全市场快照", async () => {
  const client = new BinanceUsdMClient();
  const staleSymbol = futuresSymbol();
  const staleData = {
    symbols: [staleSymbol],
    symbol: staleSymbol,
    marketType: MARKET_FUTURES,
  };
  client.exchangeInfoSnapshot = {
    loadedAt: Date.now() - 600_000,
    data: { symbols: [staleSymbol] },
  };
  client.exchangeInfoCache.set("SKHYUSDT", {
    loadedAt: Date.now() - 600_000,
    data: staleData,
  });
  let resolveRequest;
  client.request = async () => new Promise((resolve) => {
    resolveRequest = resolve;
  });

  const result = await client.exchangeInfo("SKHYUSDT");

  assert.equal(result, staleData);
  const refreshPromise = client.exchangeInfoSnapshotRefreshPromise;
  resolveRequest({ symbols: [staleSymbol] });
  await refreshPromise;
  assert.ok(client.exchangeInfoCache.get("SKHYUSDT").loadedAt > Date.now() - 1_000);
  client.close();
});

test("统一市场路由过期后先复用结果，不阻塞报单链路", async () => {
  const client = new BinanceUnifiedClient();
  const cached = {
    symbol: "BTCUSDT",
    marketType: MARKET_SPOT,
    client: client.spot,
    exchangeInfo: { symbol: { symbol: "BTCUSDT" } },
    resolvedAt: Date.now() - 600_000,
  };
  client.marketResolutionCache.set("auto:BTCUSDT", cached);
  let resolveRefresh;
  client.spot.exchangeInfo = async () => new Promise((resolve) => {
    resolveRefresh = resolve;
  });

  const result = await client.resolveMarket("BTCUSDT");

  assert.equal(result, cached);
  const refreshPromise = client.marketResolutionRefreshPromises.get("auto:BTCUSDT");
  resolveRefresh({ symbol: { symbol: "BTCUSDT" } });
  await refreshPromise;
  assert.ok(client.marketResolutionCache.get("auto:BTCUSDT").resolvedAt > cached.resolvedAt);
  client.close();
});

test("USDⓈ-M LIMIT 按总价下单时换算 quantity 且不发送 quoteOrderQty", async () => {
  const client = new BinanceUsdMClient({ testnet: true });
  client.exchangeInfo = async () => ({ symbol: futuresSymbol() });
  seedPositionMode(client);

  const result = await client.prepareOrder({
    symbol: "SKHYUSDT",
    side: "BUY",
    type: "LIMIT",
    quoteOrderQty: "20",
    price: "200.19",
  });

  assert.equal(result.params.price, "200.1");
  assert.equal(result.params.quantity, "0.099");
  assert.equal(result.params.quoteOrderQty, undefined);
  assert.equal(result.params.positionSide, "BOTH");
  assert.equal(result.orderSizing.referenceSource, "委托价");
  assert.equal(result.orderSizing.convertedQuantity, "0.099");
  client.close();
});

test("USDⓈ-M MARKET 按总价下单时复用最新成交价缓存", async () => {
  const client = new BinanceUsdMClient({ testnet: true });
  client.exchangeInfo = async () => ({ symbol: futuresSymbol() });
  seedPositionMode(client);
  client.lastTradePriceCache.set("SKHYUSDT", {
    price: "200",
    loadedAt: Date.now(),
  });
  client.request = async () => {
    throw new Error("存在新鲜成交价缓存时不应额外查询 ticker");
  };

  const result = await client.prepareOrder({
    symbol: "SKHYUSDT",
    side: "SELL",
    type: "MARKET",
    quoteOrderQty: "20",
  });

  assert.equal(result.params.quantity, "0.100");
  assert.equal(result.params.quoteOrderQty, undefined);
  assert.equal(result.params.selfTradePreventionMode, "EXPIRE_MAKER");
  assert.equal(result.orderSizing.referenceSource, "最新成交价缓存");
  assert.equal(result.orderSizing.referencePrice, "200");
  client.close();
});

test("USDⓈ-M MARKET 与 GTX 会明确标记 STP 不在官方保证范围", async () => {
  const client = new BinanceUsdMClient({ testnet: true });
  client.exchangeInfo = async () => ({ symbol: futuresSymbol() });
  seedPositionMode(client);
  client.signedRest = async (_method, _path, params) => ({
    symbol: params.symbol,
    status: "TEST_ACCEPTED",
  });

  const market = await client.placeOrder({
    symbol: "SKHYUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: "0.1",
  }, { testOnly: true });
  const limitMaker = await client.placeOrder({
    symbol: "SKHYUSDT",
    side: "SELL",
    type: "LIMIT_MAKER",
    quantity: "0.1",
    price: "200",
  }, { testOnly: true });

  assert.equal(market.selfTradePrevention.mode, "EXPIRE_MAKER");
  assert.equal(market.selfTradePrevention.apiEffective, false);
  assert.equal(limitMaker.selfTradePrevention.apiEffective, false);
  client.close();
});

test("USDⓈ-M 检测到双向持仓时自动切换为单向并发送 BOTH", async () => {
  const client = new BinanceUsdMClient({ testnet: true });
  client.exchangeInfo = async () => ({ symbol: futuresSymbol() });
  seedPositionMode(client, true);
  let modeChange;
  client.signedRest = async (method, path, params) => {
    modeChange = { method, path, params };
    return { code: 200, msg: "success" };
  };

  const result = await client.prepareOrder({
    symbol: "SKHYUSDT",
    side: "BUY",
    type: "LIMIT",
    quantity: "0.1",
    price: "200",
  });

  assert.deepEqual(modeChange, {
    method: "POST",
    path: "/fapi/v1/positionSide/dual",
    params: { dualSidePosition: "false" },
  });
  assert.equal(result.params.positionSide, "BOTH");
  assert.equal(result.positionMode.positionMode, "ONE_WAY");
  assert.equal(client.positionModeCache.dualSidePosition, false);
  client.close();
});

test("USDⓈ-M 持仓模式缓存失效导致 -4061 时刷新模式并仅重试一次", async () => {
  const client = new BinanceUsdMClient({ testnet: true });
  client.exchangeInfo = async () => ({ symbol: futuresSymbol() });
  seedPositionMode(client, false);
  const submittedPositionSides = [];
  let modeQueryCount = 0;
  let modeChangeCount = 0;
  client.signedRest = async (method, path, params) => {
    if (method === "GET" && path === "/fapi/v1/positionSide/dual") {
      modeQueryCount += 1;
      return { dualSidePosition: true };
    }
    if (method === "POST" && path === "/fapi/v1/positionSide/dual") {
      modeChangeCount += 1;
      assert.deepEqual(params, { dualSidePosition: "false" });
      return { code: 200, msg: "success" };
    }
    if (path === "/fapi/v1/order/test") {
      submittedPositionSides.push(params.positionSide);
      if (submittedPositionSides.length === 1) {
        throw new BinanceApiError(
          "Order's position side does not match user's setting",
          { status: 400, code: -4061 }
        );
      }
      return { status: "TEST_ACCEPTED" };
    }
    throw new Error(`未预期的路径：${path}`);
  };

  const result = await client.placeOrder({
    symbol: "SKHYUSDT",
    side: "SELL",
    type: "LIMIT",
    quantity: "0.1",
    price: "200",
  }, { testOnly: true });

  assert.deepEqual(submittedPositionSides, ["BOTH", "BOTH"]);
  assert.equal(modeQueryCount, 1);
  assert.equal(modeChangeCount, 1);
  assert.equal(result.positionMode, "ONE_WAY");
  assert.equal(result.positionSide, "BOTH");
  client.close();
});

test("USDⓈ-M 存在持仓时不强行切换模式并返回可操作提示", async () => {
  const client = new BinanceUsdMClient({ testnet: false });
  seedPositionMode(client, true);
  client.signedRest = async () => {
    throw new BinanceApiError("Position mode cannot be changed", {
      status: 400,
      code: -4068,
    });
  };

  await assert.rejects(
    client.ensureOneWayPositionMode(),
    (error) =>
      error instanceof BinanceApiError &&
      error.code === -4068 &&
      /请先平掉所有 U 本位持仓/.test(error.message)
  );
  client.close();
});

test("USDⓈ-M 正式和测试环境使用各自官方 WebSocket API", () => {
  const production = new BinanceUsdMClient({ testnet: false });
  const testnet = new BinanceUsdMClient({ testnet: true });
  assert.equal(production.tradingWsApiBase, FUTURES_WS_API_BASE.production);
  assert.equal(testnet.tradingWsApiBase, FUTURES_WS_API_BASE.testnet);
  production.close();
  testnet.close();
});

test("正式环境可为当前 USDⓈ-M 子账号签署 TradFi-Perps 协议", async () => {
  const client = new BinanceUsdMClient({ testnet: false });
  let submitted;
  client.signedRest = async (method, path, params) => {
    submitted = { method, path, params };
    return { code: 200, msg: "success" };
  };

  const result = await client.signTradFiPerpsAgreement();

  assert.deepEqual(submitted, {
    method: "POST",
    path: "/fapi/v1/stock/contract",
    params: undefined,
  });
  assert.equal(result.code, 200);
  assert.equal(result.agreement, "TradFi-Perps");
  assert.equal(result.signedForCurrentApiAccount, true);
  client.close();
});

test("Testnet 不会误调用正式环境 TradFi-Perps 协议接口", async () => {
  const client = new BinanceUsdMClient({ testnet: true });
  client.signedRest = async () => {
    throw new Error("Testnet 不应调用协议接口");
  };

  await assert.rejects(
    client.signTradFiPerpsAgreement(),
    (error) =>
      error instanceof BinanceApiError && /仅适用于 Binance 正式环境/.test(error.message)
  );
  client.close();
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform} WebSocket 失效后安全查询自动降级到 HTTP`, async () => {
    const client = new BinanceUsdMClient({
      apiKey: "future-key",
      apiSecret: "future-secret",
      platform,
    });
    seedTradingTime(client);
    client.tradingWsApiSocket = {
      readyState: 1,
      close() {},
      terminate() {},
    };
    client.requestWsApiOnSocket = async () => {
      throw client.createWsTransportError("连接已失效。", {
        requestSent: true,
      });
    };
    let reconnectRequested = false;
    client.startTradingWebSocketInBackground = () => {
      reconnectRequested = true;
    };
    let submitted;
    client.request = async (method, path, params, signed, baseUrl) => {
      submitted = { method, path, params, signed, baseUrl };
      return { symbol: params.symbol, orderId: 9, status: "NEW" };
    };

    const result = await client.queryOrder({
      symbol: "BTCUSDT",
      orderId: 9,
    });

    assert.equal(result.orderId, 9);
    assert.equal(submitted.method, "GET");
    assert.equal(submitted.path, "/fapi/v1/order");
    assert.equal(submitted.signed, true);
    assert.equal(submitted.baseUrl, client.tradingRestBase);
    assert.equal(reconnectRequested, true);
    client.tradingWsApiSocket = null;
    client.close();
  });
}

test("真实下单已写入 WebSocket 后响应丢失时不会用 HTTP 重复报单", async () => {
  const client = new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
  });
  seedTradingTime(client);
  client.exchangeInfo = async () => ({ symbol: futuresSymbol() });
  seedPositionMode(client);
  client.tradingWsApiSocket = {
    readyState: 1,
    close() {},
    terminate() {},
  };
  client.requestWsApiOnSocket = async () => {
    throw client.createWsTransportError("连接在发送后关闭。", {
      requestSent: true,
    });
  };
  let httpOrderCount = 0;
  client.request = async () => {
    httpOrderCount += 1;
    return {};
  };

  await assert.rejects(
    client.placeOrder({
      symbol: "SKHYUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: "0.1",
      price: "200",
    }),
    (error) => error.data?.executionStatus === "UNKNOWN"
  );
  assert.equal(httpOrderCount, 0);
  client.tradingWsApiSocket = null;
  client.close();
});

test("统一客户端在现货返回 Invalid symbol 后自动路由到 USDⓈ-M", async () => {
  const client = new BinanceUnifiedClient({ testnet: false });
  client.spot.exchangeInfo = async () => {
    throw new BinanceApiError("Invalid symbol.", { code: -1121, status: 400 });
  };
  client.futures.exchangeInfo = async () => ({
    marketType: MARKET_FUTURES,
    symbol: futuresSymbol(),
  });
  client.futures.placeOrder = async (order) => ({
    symbol: order.symbol,
    orderId: 88,
    status: "NEW",
  });

  const result = await client.placeOrder({ symbol: "SKHYUSDT" });
  assert.equal(result.marketType, MARKET_FUTURES);
  assert.equal(result.orderId, 88);
  client.close();
});

test("同名合约同时存在时默认保留现货路由", async () => {
  const client = new BinanceUnifiedClient({ testnet: false });
  client.spot.exchangeInfo = async () => ({
    symbol: { symbol: "BTCUSDT", status: "TRADING" },
  });
  client.futures.exchangeInfo = async () => {
    throw new Error("同名合约不应继续查询 Futures");
  };

  const result = await client.resolveMarket("BTCUSDT");
  assert.equal(result.marketType, MARKET_SPOT);
  client.close();
});

test("已查询订单携带的内部市场类型可精确路由撤单", async () => {
  const client = new BinanceUnifiedClient({ testnet: false });
  client.futures.exchangeInfo = async () => ({
    symbol: futuresSymbol("BTCUSDT"),
  });
  client.spot.cancelAllOpenOrders = async () => {
    throw new Error("不应撤销现货订单");
  };
  client.futures.cancelAllOpenOrders = async () => ([{
    symbol: "BTCUSDT",
    orderId: 3,
    status: "CANCELED",
  }]);

  const result = await client.cancelAllOpenOrders({
    symbol: "BTCUSDT",
    marketType: MARKET_FUTURES,
  });
  assert.equal(result[0].marketType, MARKET_FUTURES);
  assert.equal(result[0].status, "CANCELED");
  client.close();
});

test("永续 ORDER_TRADE_UPDATE 被转换为现有界面可消费的 executionReport", () => {
  const client = new BinanceUsdMClient();
  const result = client.normalizeFuturesUserEvent({
    e: "ORDER_TRADE_UPDATE",
    E: 100,
    T: 101,
    o: {
      s: "SKHYUSDT",
      c: "client-1",
      S: "SELL",
      o: "LIMIT",
      q: "0.001",
      p: "200",
      x: "NEW",
      X: "NEW",
      i: 9,
      l: "0",
      z: "0",
    },
  });

  assert.equal(result.e, "executionReport");
  assert.equal(result.s, "SKHYUSDT");
  assert.equal(result.i, 9);
  assert.equal(result.X, "NEW");
  client.close();
});

test("永续十档部分深度事件直接转换为页面行情", () => {
  const client = new BinanceUsdMClient();
  let update;
  client.once("depth-update", (payload) => {
    update = payload;
  });

  client.emitPartialDepthUpdate({
    e: "depthUpdate",
    s: "BTCUSDT",
    U: 105,
    u: 110,
    pu: 100,
    b: [["50000", "2"]],
    a: [["50001", "3"]],
  });

  assert.equal(client.getDepthStreamName("BTCUSDT"), "btcusdt@depth10@100ms");
  assert.equal(update.firstUpdateId, 105);
  assert.equal(update.finalUpdateId, 110);
  assert.deepEqual(update.bids[0], { price: "50000", quantity: "2" });
  assert.deepEqual(update.asks[0], { price: "50001", quantity: "3" });
  client.close();
});
