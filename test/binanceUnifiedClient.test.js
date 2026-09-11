const assert = require("node:assert/strict");
const test = require("node:test");
const { BinanceApiError } = require("../src/binance/binanceClientBase");
const {
  BinanceUsdMClient,
  FUTURES_REST_BASE,
  FUTURES_USER_DATA_WS_BASE,
  FUTURES_WS_BASE,
  FUTURES_WS_API_BASE,
} = require("../src/binance/binanceUsdMClient");
const {
  BinanceUnifiedClient,
  MARKET_FUTURES,
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

test("USDⓈ-M 全部订单查询允许省略 symbol", async () => {
  const client = new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
  });
  let request;
  client.signedRest = async (method, path, params) => {
    request = { method, path, params };
    return [];
  };

  await client.allOrders({ startTime: 100, endTime: 200, limit: 1_000 });

  assert.equal(request.method, "GET");
  assert.equal(request.path, "/fapi/v1/allOrders");
  assert.equal(request.params.symbol, undefined);
  assert.equal(request.params.startTime, 100);
  assert.equal(request.params.endTime, 200);
  client.close();
});

test("永续原生 STOP 下单通过 WebSocket Algo Order 接口", async () => {
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
        result: {
          symbol: submitted.params.symbol,
          algoId: 7,
          clientAlgoId: submitted.params.clientAlgoId,
          orderType: submitted.params.type,
          algoStatus: "NEW",
        },
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
    type: "STOP",
    quantity: "0.0319",
    price: "200.19",
    stopPrice: "199.99",
    timeInForce: "GTC",
  });

  assert.equal(submitted.method, "algoOrder.place");
  assert.equal(submitted.params.type, "STOP");
  assert.equal(submitted.params.quantity, "0.031");
  assert.equal(submitted.params.price, "200.1");
  assert.equal(submitted.params.positionSide, "BOTH");
  assert.equal(submitted.params.newOrderRespType, "ACK");
  assert.equal(submitted.params.selfTradePreventionMode, "EXPIRE_MAKER");
  assert.match(
    submitted.params.clientAlgoId,
    /^x-tdk3UjFd-[0-9]{13}[a-f0-9]{8}$/
  );
  assert.ok(submitted.params.clientAlgoId.length <= 36);
  assert.equal(submitted.params.algoType, "CONDITIONAL");
  assert.equal(submitted.params.triggerPrice, "199.9");
  assert.equal(result.marketType, MARKET_FUTURES);
  assert.equal(result.transport, "websocket");
  assert.equal(result.selfTradePrevention.apiEffective, true);
  client.close();
});

test("纯 U 本位客户端把 Futures LinkID 传给底层客户端", () => {
  const client = new BinanceUnifiedClient({
    futuresBrokerLinkId: "tdk3UjFd",
  });

  assert.equal(client.futures.brokerLinkId, "tdk3UjFd");
  assert.equal(client.spot, undefined);
  client.close();
});

test("纯 U 本位客户端把 Futures 延迟事件路由到统一出口", async () => {
  const client = new BinanceUnifiedClient();
  const updates = [];
  client.on("latency-update", (payload) => updates.push(payload));

  client.futures.emit("latency-update", {
    operation: "ping/pong 心跳",
    transport: "websocket-heartbeat",
    elapsedMs: 8.765,
    background: true,
  });

  assert.deepEqual(updates, [
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

test("最近 24 小时全账户同步查询 U 本位全合约订单", async () => {
  const client = new BinanceUnifiedClient({
    futuresCredentials: { apiKey: "futures-key", apiSecret: "futures-secret" },
  });
  const startTime = 1_000;
  const endTime = startTime + 24 * 60 * 60 * 1000;
  let futuresQuery;
  client.futures.allOrders = async (options) => {
    futuresQuery = options;
    return [{ symbol: "SOLUSDT", orderId: 3, status: "CANCELED" }];
  };
  client.futures.openAlgoOrders = async () => [];
  client.futures.allAlgoOrders = async () => [];

  const result = await client.recentAccountOrders({
    startTime,
    endTime,
  });

  assert.equal(futuresQuery.symbol, undefined);
  assert.equal(futuresQuery.startTime, startTime);
  assert.equal(result.orders.length, 1);
  assert.deepEqual(
    result.orders.map(({ marketType, symbol }) => [marketType, symbol]).sort(),
    [[MARKET_FUTURES, "SOLUSDT"]]
  );
  assert.equal(result.markets.spot, undefined);
  assert.equal(result.markets.futures.orderCount, 1);
  assert.deepEqual(result.warnings, []);
  client.close();
});

test("U 本位测试服务要求 symbol 时按已知合约自动回退", async () => {
  const client = new BinanceUnifiedClient({
    futuresCredentials: { apiKey: "futures-key", apiSecret: "futures-secret" },
  });
  const queriedSymbols = [];
  client.futures.openOrders = async () => ([{
    symbol: "BTCUSDT",
    orderId: 4,
    status: "NEW",
  }]);
  client.futures.allOrders = async ({ symbol }) => {
    if (!symbol) {
      throw new BinanceApiError("Mandatory parameter 'symbol' was not sent.", {
        status: 400,
        code: -1102,
        data: { code: -1102, msg: "Mandatory parameter 'symbol' was not sent." },
      });
    }
    queriedSymbols.push(symbol);
    return [{ symbol, orderId: symbol === "BTCUSDT" ? 4 : 5, status: "NEW" }];
  };
  client.futures.openAlgoOrders = async () => [];
  client.futures.allAlgoOrders = async () => [];

  const result = await client.recentAccountOrders({
    startTime: 1_000,
    endTime: 1_001,
    knownFuturesSymbols: ["ETHUSDT"],
  });

  assert.deepEqual(queriedSymbols.sort(), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(result.markets.futures.queryMode, "per-symbol-fallback");
  assert.equal(result.orders.length, 2);
  assert.deepEqual(result.warnings, []);
  client.close();
});

test("未指定合约时只连接 U 本位账户订单事件", async () => {
  const client = new BinanceUnifiedClient({
    futuresCredentials: { apiKey: "futures-key", apiSecret: "futures-secret" },
  });
  const connectedMarkets = [];
  client.futures.connectUserData = async () => {
    connectedMarkets.push(MARKET_FUTURES);
    return { subscriptionId: "futures-subscription" };
  };

  const result = await client.connectUserData();

  assert.deepEqual(connectedMarkets, [MARKET_FUTURES]);
  assert.equal(result.marketType, MARKET_FUTURES);
  assert.equal(result.subscriptionId, "futures-subscription");
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

test("纯 U 本位客户端拒绝现货市场类型", async () => {
  const client = new BinanceUnifiedClient();
  await assert.rejects(
    client.resolveMarket("BTCUSDT", { marketType: "spot" }),
    /仅支持 U 本位永续/
  );
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

test("USDⓈ-M 平仓动作强制 reduceOnly，开仓动作不携带该参数", async () => {
  const client = new BinanceUsdMClient({ testnet: true });
  client.exchangeInfo = async () => ({ symbol: futuresSymbol() });
  seedPositionMode(client);

  const closing = await client.prepareOrder({
    symbol: "SKHYUSDT",
    side: "SELL",
    type: "LIMIT",
    quantity: "0.1",
    price: "200",
    positionEffect: "CLOSE",
  });
  const opening = await client.prepareOrder({
    symbol: "SKHYUSDT",
    side: "BUY",
    type: "LIMIT",
    quantity: "0.1",
    price: "200",
    positionEffect: "OPEN",
  });

  assert.equal(closing.params.reduceOnly, "true");
  assert.equal(closing.positionEffect, "CLOSE");
  assert.equal(opening.params.reduceOnly, undefined);
  assert.equal(opening.positionEffect, "OPEN");
  client.close();
});

test("USDⓈ-M 高级订单参数在发送前校验适用范围", async () => {
  const client = new BinanceUsdMClient({ testnet: true });
  client.exchangeInfo = async () => ({ symbol: futuresSymbol() });
  seedPositionMode(client);

  await assert.rejects(
    client.prepareOrder({
      symbol: "SKHYUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: "0.1",
      priceMatch: "OPPONENT",
    }),
    /priceMatch 只适用于/
  );
  await assert.rejects(
    client.prepareOrder({
      symbol: "SKHYUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: "0.1",
      priceMatch: "nearest",
    }),
    /priceMatch 不支持/
  );
  client.close();
});

test("USDⓈ-M Algo Order 响应与 ALGO_UPDATE 统一为普通订单状态结构", () => {
  const client = new BinanceUsdMClient({ testnet: true });
  const order = client.normalizeAlgoOrder({
    algoId: 77,
    clientAlgoId: "algo-77",
    symbol: "SKHYUSDT",
    side: "SELL",
    orderType: "STOP",
    algoStatus: "NEW",
    quantity: "0.1",
    triggerPrice: "190",
  });
  const event = client.normalizeFuturesUserEvent({
    e: "ALGO_UPDATE",
    E: 100,
    T: 99,
    o: {
      algoId: 77,
      clientAlgoId: "algo-77",
      symbol: "SKHYUSDT",
      side: "SELL",
      orderType: "STOP",
      algoStatus: "CANCELED",
      quantity: "0.1",
      triggerPrice: "190",
    },
  });

  assert.equal(order.orderId, 77);
  assert.equal(order.algoOrder, true);
  assert.equal(event.e, "executionReport");
  assert.equal(event.X, "CANCELED");
  assert.equal(event.algoOrder, true);
  client.close();
});

test("USDⓈ-M Algo Order 撤单响应缺少 symbol 时沿用请求合约", async () => {
  const client = new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
  });
  client.signedRest = async (method, path, params) => {
    assert.equal(method, "DELETE");
    assert.equal(path, "/fapi/v1/algoOrder");
    assert.deepEqual(params, { algoId: 77, clientAlgoId: undefined });
    return { algoId: 77, clientAlgoId: "algo-77", code: 200 };
  };

  const result = await client.cancelAlgoOrder({
    symbol: "SKHYUSDT",
    algoId: 77,
  });

  assert.equal(result.symbol, "SKHYUSDT");
  assert.equal(result.status, "CANCELED");
  assert.equal(result.algoOrder, true);
  client.close();
});

test("USDⓈ-M 自动撤单倒计时调用 countdownCancelAll 并校验范围", async () => {
  const client = new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
  });
  let submitted;
  client.signedRest = async (method, path, params) => {
    submitted = { method, path, params };
    return { symbol: params.symbol, countdownTime: params.countdownTime };
  };

  await client.setCountdownCancelAll({
    symbol: "SKHYUSDT",
    countdownTime: 120_000,
  });
  assert.deepEqual(submitted, {
    method: "POST",
    path: "/fapi/v1/countdownCancelAll",
    params: { symbol: "SKHYUSDT", countdownTime: 120_000 },
  });
  await assert.rejects(
    client.setCountdownCancelAll({ symbol: "SKHYUSDT", countdownTime: 600_001 }),
    /0-600000/
  );
  client.close();
});

test("最近订单查询达到上限时按时间二分补齐而不是截断", async () => {
  const client = new BinanceUnifiedClient();
  const source = [
    { orderId: 1, updateTime: 10 },
    { orderId: 2, updateTime: 20 },
    { orderId: 3, updateTime: 30 },
    { orderId: 4, updateTime: 40 },
  ];
  const queriedWindows = [];
  const warnings = [];
  const result = await client.queryCompleteOrderWindow({
    fetchPage: async ({ startTime, endTime, limit }) => {
      queriedWindows.push([startTime, endTime]);
      return source.filter((order) =>
        order.updateTime >= startTime && order.updateTime <= endTime
      ).slice(0, limit);
    },
    startTime: 1,
    endTime: 50,
    limit: 2,
    warningContext: { marketType: MARKET_FUTURES, operation: "allOrders" },
    warnings,
  });

  assert.deepEqual(result.map((order) => order.orderId).sort(), [1, 2, 3, 4]);
  assert.ok(queriedWindows.length > 1);
  assert.deepEqual(warnings, []);
  client.close();
});

test("STP 安全状态会识别 tradeGroupId=-1 与期望交易组不匹配", async () => {
  const client = new BinanceUnifiedClient({
    futuresCredentials: { apiKey: "future", apiSecret: "secret" },
    expectedFuturesTradeGroupId: "9",
  });
  client.futures.accountStatus = async () => ({ tradeGroupId: 7 });

  const result = await client.tradingSafetyStatus();

  assert.equal(result.crossAccountReady, false);
  assert.equal(result.markets.spot, undefined);
  assert.equal(result.markets.futures.matchesExpected, false);
  assert.equal(result.warnings.length, 1);
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
  const postOnly = await client.placeOrder({
    symbol: "SKHYUSDT",
    side: "SELL",
    type: "LIMIT",
    timeInForce: "GTX",
    quantity: "0.1",
    price: "200",
  }, { testOnly: true });

  assert.equal(market.selfTradePrevention.mode, "EXPIRE_MAKER");
  assert.equal(market.selfTradePrevention.apiEffective, false);
  assert.equal(postOnly.selfTradePrevention.apiEffective, false);
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
  assert.equal(testnet.restBase, "https://testnet.binancefuture.com");
  assert.equal(testnet.restBase, FUTURES_REST_BASE.testnet);
  assert.equal(testnet.wsBase, "wss://stream.binancefuture.com/ws");
  assert.equal(testnet.wsBase, FUTURES_WS_BASE.testnet);
  assert.equal(
    production.wsBase,
    "wss://fstream.binance.com/public/ws"
  );
  assert.equal(production.wsBase, FUTURES_WS_BASE.production);
  assert.equal(
    production.userDataWsBase,
    "wss://fstream.binance.com/private/ws"
  );
  assert.equal(
    production.userDataWsBase,
    FUTURES_USER_DATA_WS_BASE.production
  );
  assert.equal(
    production.createFuturesUserDataSocketUrl("listen/key"),
    "wss://fstream.binance.com/private/ws/listen%2Fkey"
  );
  production.close();
  testnet.close();
});

test("darwin 与 win32 的正式 U 本位行情都使用官方 public 路径", () => {
  for (const platform of ["darwin", "win32"]) {
    const client = new BinanceUsdMClient({ testnet: false, platform });
    assert.equal(client.wsBase, FUTURES_WS_BASE.production);
    assert.equal(client.marketWebSocketOptions, null);
    assert.equal(client.userDataWsBase, FUTURES_USER_DATA_WS_BASE.production);
    client.close();
  }
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

test("纯 U 本位客户端直接把订单路由到 USDⓈ-M", async () => {
  const client = new BinanceUnifiedClient({ testnet: false });
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

test("显式请求现货市场会被拒绝", async () => {
  const client = new BinanceUnifiedClient({ testnet: false });
  await assert.rejects(
    client.resolveMarket("BTCUSDT", { marketType: "spot" }),
    /仅支持 U 本位永续/
  );
  await assert.rejects(
    client.placeOrder({ symbol: "BTCUSDT", marketType: "spot" }),
    /仅支持 U 本位永续/
  );
  client.close();
});

test("已查询 U 本位订单可以直接路由撤单", async () => {
  const client = new BinanceUnifiedClient({ testnet: false });
  client.futures.exchangeInfo = async () => ({
    symbol: futuresSymbol("BTCUSDT"),
  });
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

test("一键平所有先撤 U 本位挂单，再按持仓反方向提交 reduceOnly 市价单并复核", async () => {
  const client = new BinanceUnifiedClient({
    testnet: false,
    futuresCredentials: {
      apiKey: "future-key",
      apiSecret: "future-secret",
    },
  });
  const openAccount = {
    positions: [
      {
        symbol: "BTCUSDT",
        positionAmt: "0.010",
        entryPrice: "70000",
        unrealizedProfit: "1.5",
        positionSide: "BOTH",
      },
      {
        symbol: "ETHUSDT",
        positionAmt: "-0.200",
        entryPrice: "3500",
        unrealizedProfit: "-2",
        positionSide: "BOTH",
      },
    ],
  };
  const accounts = [
    openAccount,
    openAccount,
    { positions: [] },
    { positions: [] },
  ];
  client.futures.accountStatus = async () => accounts.shift();
  let openOrderQueryCount = 0;
  client.futures.openOrders = async () => {
    openOrderQueryCount += 1;
    return openOrderQueryCount === 1
      ? [{ symbol: "BTCUSDT", orderId: 7, status: "NEW" }]
      : [];
  };
  const canceledSymbols = [];
  client.futures.cancelAllOpenOrders = async ({ symbol }) => {
    canceledSymbols.push(symbol);
    return symbol === "BTCUSDT"
      ? [{ symbol, orderId: 7, status: "CANCELED" }]
      : [];
  };
  const submitted = [];
  client.futures.placeOrder = async (order) => {
    submitted.push(order);
    return {
      symbol: order.symbol,
      orderId: order.symbol === "BTCUSDT" ? 8 : 9,
      status: "ACKNOWLEDGED",
      marketType: MARKET_FUTURES,
    };
  };

  const result = await client.closeAllFuturesPositions({
    verificationDelays: [0, 0],
  });

  assert.deepEqual(canceledSymbols.sort(), ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(submitted, [
    {
      symbol: "BTCUSDT",
      side: "SELL",
      positionSide: "BOTH",
      positionEffect: "CLOSE",
      reduceOnly: true,
      type: "MARKET",
      quantity: "0.010",
      newOrderRespType: "ACK",
    },
    {
      symbol: "ETHUSDT",
      side: "BUY",
      positionSide: "BOTH",
      positionEffect: "CLOSE",
      reduceOnly: true,
      type: "MARKET",
      quantity: "0.2",
      newOrderRespType: "ACK",
    },
  ]);
  assert.equal(result.verifiedFlat, true);
  assert.equal(result.positionFlatConfirmations, 2);
  assert.equal(result.remainingPositions.length, 0);
  assert.equal(result.remainingOpenOrders.length, 0);
  assert.equal(result.orders.length, 3);
  client.close();
});

test("一键平所有有委托失败或仍有持仓时不会误报已全部平仓", async () => {
  const client = new BinanceUnifiedClient({
    testnet: false,
    futuresCredentials: {
      apiKey: "future-key",
      apiSecret: "future-secret",
    },
  });
  const openAccount = {
    positions: [{
      symbol: "BTCUSDT",
      positionAmt: "0.010",
      positionSide: "BOTH",
    }],
  };
  client.futures.accountStatus = async () => openAccount;
  client.futures.openOrders = async () => [];
  client.futures.cancelAllOpenOrders = async () => [];
  client.futures.placeOrder = async () => {
    throw new BinanceApiError("余额或权限不足", { code: -2010 });
  };

  const result = await client.closeAllFuturesPositions({
    verificationDelays: [0],
  });

  assert.equal(result.verifiedFlat, false);
  assert.equal(result.positionsVerified, true);
  assert.equal(result.remainingPositions.length, 1);
  assert.equal(result.closeAttempts.length, 1);
  assert.equal(result.closeAttempts[0].ok, false);
  assert.equal(result.closeAttempts[0].error.code, -2010);
  client.close();
});

test("一键平所有只执行 U 本位清仓并透传复核结果", async () => {
  const client = new BinanceUnifiedClient({ testnet: false });
  let futuresCalled = false;
  client.closeAllFuturesPositions = async () => {
    futuresCalled = true;
    return {
      marketType: MARKET_FUTURES,
      verifiedFlat: true,
      remainingPositions: [],
      remainingOpenOrders: [],
      orders: [{
        symbol: "BTCUSDT",
        orderId: 12,
        marketType: MARKET_FUTURES,
      }],
    };
  };

  const result = await client.closeAllPositions();

  assert.equal(futuresCalled, true);
  assert.equal(result.verifiedFlat, true);
  assert.equal(result.markets.futures.verifiedFlat, true);
  assert.equal(result.orders.length, 1);
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
      ap: "199.5",
      rp: "1.25",
      ma: "USDT",
      n: "0.05",
      N: "USDT",
      t: 99,
    },
  });

  assert.equal(result.e, "executionReport");
  assert.equal(result.s, "SKHYUSDT");
  assert.equal(result.i, 9);
  assert.equal(result.X, "NEW");
  assert.equal(result.ap, "199.5");
  assert.equal(result.rp, "1.25");
  assert.equal(result.ma, "USDT");
  assert.equal(result.n, "0.05");
  assert.equal(result.t, 99);
  client.close();
});

test("永续默认使用二十档部分深度并转换为页面行情", () => {
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

  assert.equal(client.getDepthStreamName("BTCUSDT"), "btcusdt@depth20@100ms");
  assert.equal(update.streamLevels, 20);
  assert.equal(update.displayLevels, 20);
  assert.equal(update.firstUpdateId, 105);
  assert.equal(update.finalUpdateId, 110);
  assert.deepEqual(update.bids[0], { price: "50000", quantity: "2" });
  assert.deepEqual(update.asks[0], { price: "50001", quantity: "3" });
  client.close();
});

test("永续部分深度只允许在五、十、二十档之间切换", () => {
  const client = new BinanceUsdMClient();
  const levels = Array.from({ length: 20 }, (_, index) => [
    String(50_000 - index),
    String(index + 1),
  ]);

  for (const depthLevels of [5, 10, 20]) {
    let update;
    client.once("depth-update", (payload) => {
      update = payload;
    });
    client.setDepthLevels(String(depthLevels));
    client.emitPartialDepthUpdate({
      e: "depthUpdate",
      s: "BTCUSDT",
      U: 1,
      u: 2,
      b: levels,
      a: levels,
    });

    assert.equal(
      client.getDepthStreamName("BTCUSDT"),
      `btcusdt@depth${depthLevels}@100ms`
    );
    assert.equal(update.bids.length, depthLevels);
    assert.equal(update.asks.length, depthLevels);
    assert.equal(update.displayLevels, depthLevels);
  }

  assert.throws(
    () => client.setDepthLevels(15),
    /只支持 5、10 或 20 档/
  );
  assert.equal(client.depthStreamLevels, 20);
  client.close();
});

test("运行时切换行情档位会按当前 U 本位合约重连", async () => {
  const client = new BinanceUnifiedClient();
  client.activeSymbol = "BTCUSDT";
  const connections = [];
  client.futures.connectDepth = async (symbol) => {
    connections.push({ symbol, stream: client.futures.getDepthStreamName(symbol) });
    return {
      symbol,
      stream: client.futures.getDepthStreamName(symbol),
      depthMode: client.depthMode,
      streamLevels: client.depthStreamLevels,
      displayLevels: client.depthDisplayLevels,
    };
  };

  const result = await client.setDepthLevels(5);

  assert.deepEqual(connections, [{
    symbol: "BTCUSDT",
    stream: "btcusdt@depth5@100ms",
  }]);
  assert.equal(result.streamLevels, 5);
  assert.equal(result.displayLevels, 5);
  assert.equal(result.reconnected, true);
  assert.equal(result.marketType, MARKET_FUTURES);
  client.close();
});
