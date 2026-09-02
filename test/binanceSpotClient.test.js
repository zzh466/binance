const assert = require("node:assert/strict");
const test = require("node:test");
const { BinanceSpotClient, BinanceApiError } = require("../src/binance/binanceSpotClient");

function createClient(testnet = true) {
  return new BinanceSpotClient({
    apiKey: "test-key",
    apiSecret: "test-secret",
    testnet,
  });
}

test("交易地址随环境切换", () => {
  const testnet = createClient(true);
  assert.match(testnet.tradingRestBase, /testnet/);

  const production = createClient(false);
  assert.doesNotMatch(production.tradingRestBase, /testnet/);
});

test("正式环境公共行情使用 Binance Vision，交易仍使用正式交易域名", () => {
  const production = createClient(false);

  assert.equal(production.restBase, "https://data-api.binance.vision/api");
  assert.equal(production.wsBase, "wss://data-stream.binance.vision/ws");
  assert.equal(production.tradingRestBase, "https://api.binance.com/api");
  assert.equal(
    production.tradingWsApiBase,
    "wss://ws-api.binance.com:443/ws-api/v3"
  );
});

test("现货默认使用十档部分深度流且只向界面发送十档", () => {
  const client = createClient(false);
  client.marketSymbol = "BTCUSDT";
  let update;
  client.once("depth-update", (payload) => {
    update = payload;
  });
  const bids = Array.from({ length: 12 }, (_, index) => [
    String(50000 - index),
    String(index + 1),
  ]);
  const asks = Array.from({ length: 12 }, (_, index) => [
    String(50001 + index),
    String(index + 1),
  ]);

  client.emitPartialDepthUpdate({ lastUpdateId: 102, bids, asks });

  assert.equal(client.getDepthStreamName("BTCUSDT"), "btcusdt@depth10@100ms");
  assert.equal(client.depthMode, "partial");
  assert.equal(update.lastUpdateId, 102);
  assert.equal(update.bids.length, 10);
  assert.equal(update.asks.length, 10);
  assert.deepEqual(update.bids[0], { price: "50000", quantity: "1" });
  client.close();
});

test("WebSocket API 请求响应会发布统一延迟事件", async () => {
  const client = createClient();
  let submitted;
  const socket = {
    readyState: 1,
    send(payload) {
      submitted = JSON.parse(payload);
      setImmediate(() => client.handleWsApiResponse({
        id: submitted.id,
        status: 200,
        result: { orderId: 7 },
      }, socket));
    },
  };
  const latencyPromise = new Promise((resolve) => {
    client.once("latency-update", resolve);
  });

  const result = await client.requestWsApiOnSocket(
    socket,
    "order.place",
    { symbol: "BTCUSDT" }
  );
  const latency = await latencyPromise;

  assert.deepEqual(result, { orderId: 7 });
  assert.equal(latency.marketType, "spot");
  assert.equal(latency.operation, "order.place");
  assert.equal(latency.transport, "websocket-api");
  assert.equal(latency.success, true);
  assert.ok(Number.isFinite(latency.elapsedMs));
  assert.ok(latency.elapsedMs >= 0);
  client.close();
});

test("prepareOrder 按交易过滤器对价格和数量向下对齐", async () => {
  const client = createClient();
  client.exchangeInfo = async () => ({
    symbol: {
      status: "TRADING",
      filters: [
        { filterType: "PRICE_FILTER", minPrice: "1.00", maxPrice: "1000000", tickSize: "0.10" },
        { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
        { filterType: "MIN_NOTIONAL", minNotional: "5" },
      ],
    },
  });
  client.request = async (_method, path) => {
    assert.equal(path, "/v3/avgPrice");
    return { price: "50000" };
  };

  const result = await client.prepareOrder({
    symbol: "BTCUSDT",
    side: "BUY",
    type: "LIMIT",
    quantity: "0.0019",
    price: "50000.19",
  });

  assert.equal(result.params.quantity, "0.001");
  assert.equal(result.params.price, "50000.10");
  assert.equal(result.params.timeInForce, "GTC");
  assert.equal(result.params.newOrderRespType, "ACK");
  assert.equal(result.params.selfTradePreventionMode, "EXPIRE_MAKER");
  assert.equal(result.adjustments.length, 2);
});

test("正式现货服务器时间同步同时预热公共域名和交易域名", async () => {
  const client = createClient(false);
  const synchronizedBases = [];
  client.syncServerTimeForBase = async (baseUrl) => {
    synchronizedBases.push(baseUrl);
    return { baseUrl, offsetMs: baseUrl === client.tradingRestBase ? 7 : 3 };
  };

  const result = await client.syncServerTime();

  assert.deepEqual(synchronizedBases.sort(), [
    client.restBase,
    client.tradingRestBase,
  ].sort());
  assert.equal(result.baseUrl, client.tradingRestBase);
  assert.equal(result.offsetMs, 7);
  client.close();
});

test("现货 exchangeInfo 过期后立即复用旧缓存并在后台刷新", async () => {
  const client = createClient();
  const staleData = {
    symbol: { symbol: "BTCUSDT", status: "TRADING", filters: [] },
  };
  client.exchangeInfoCache.set("BTCUSDT", {
    loadedAt: Date.now() - 600_000,
    data: staleData,
  });
  let resolveRequest;
  let requestCount = 0;
  client.request = async () => {
    requestCount += 1;
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  };

  const result = await client.exchangeInfo("BTCUSDT");

  assert.equal(result, staleData);
  assert.equal(requestCount, 1);
  const refreshPromise = client.exchangeInfoRefreshPromises.get("BTCUSDT");
  resolveRequest({
    symbols: [{ symbol: "BTCUSDT", status: "TRADING", filters: [] }],
  });
  await refreshPromise;
  assert.ok(client.exchangeInfoCache.get("BTCUSDT").loadedAt > Date.now() - 1_000);
  client.close();
});

test("现货底层报单参数自动拼接 LinkID 并生成唯一 client order id", async () => {
  const client = new BinanceSpotClient({
    apiKey: "test-key",
    apiSecret: "test-secret",
    brokerLinkId: "P8DHAU8C",
  });
  client.exchangeInfo = async () => ({
    symbol: { status: "TRADING", filters: [] },
  });

  const first = await client.prepareOrder({
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: "0.001",
  });
  const second = await client.prepareOrder({
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: "0.001",
  });

  assert.match(
    first.params.newClientOrderId,
    /^x-P8DHAU8C-[0-9]{13}[a-f0-9]{8}$/
  );
  assert.ok(first.params.newClientOrderId.length <= 36);
  assert.notEqual(first.params.newClientOrderId, second.params.newClientOrderId);
  client.close();
});

test("已经包含目标 LinkID 的 newClientOrderId 不会被重复拼接", () => {
  const client = new BinanceSpotClient({ brokerLinkId: "P8DHAU8C" });

  assert.equal(
    client.buildBrokerClientOrderId("x-P8DHAU8C-custom-order"),
    "x-P8DHAU8C-custom-order"
  );
  client.close();
});

test("现货交易对不支持 EXPIRE_MAKER 时在本地下单前拒绝", async () => {
  const client = createClient();
  client.exchangeInfo = async () => ({
    symbol: {
      symbol: "BTCUSDT",
      status: "TRADING",
      allowedSelfTradePreventionModes: ["NONE", "EXPIRE_TAKER"],
      filters: [],
    },
  });

  await assert.rejects(
    client.prepareOrder({
      symbol: "BTCUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: "0.01",
    }),
    (error) =>
      error instanceof BinanceApiError &&
      /不允许 EXPIRE_MAKER/.test(error.message)
  );
  client.close();
});

test("现货 OCO、OTO、OTOCO 全部使用 ACK、EXPIRE_MAKER 并等待交易 WebSocket", async () => {
  const client = createClient();
  client.exchangeInfo = async () => ({
    symbol: {
      symbol: "BTCUSDT",
      status: "TRADING",
      allowedSelfTradePreventionModes: ["EXPIRE_MAKER"],
      filters: [],
    },
  });
  const submissions = [];
  client.signedWsOrRest = async (wsMethod, _restMethod, _path, params, options) => {
    submissions.push({ wsMethod, params, options });
    return { accepted: true };
  };

  await client.placeOco({
    symbol: "BTCUSDT",
    side: "SELL",
    quantity: "0.01",
    abovePrice: "110",
    belowPrice: "90",
    belowStopPrice: "95",
  });
  await client.placeOto({
    symbol: "BTCUSDT",
    workingSide: "BUY",
    workingPrice: "90",
    workingQuantity: "0.01",
    pendingSide: "SELL",
    pendingPrice: "110",
    pendingQuantity: "0.01",
  });
  await client.placeOtoco({
    symbol: "BTCUSDT",
    workingSide: "BUY",
    workingPrice: "90",
    workingQuantity: "0.01",
    pendingSide: "SELL",
    pendingQuantity: "0.01",
    pendingAbovePrice: "110",
    pendingBelowPrice: "80",
    pendingBelowStopPrice: "85",
  });

  assert.deepEqual(
    submissions.map(({ wsMethod, params, options }) => [
      wsMethod,
      params.selfTradePreventionMode,
      params.newOrderRespType,
      options.waitForWebSocketReady,
    ]),
    [
      ["orderList.place.oco", "EXPIRE_MAKER", "ACK", true],
      ["orderList.place.oto", "EXPIRE_MAKER", "ACK", true],
      ["orderList.place.otoco", "EXPIRE_MAKER", "ACK", true],
    ]
  );
  client.close();
});

test("prepareOrder 在本地拒绝不满足最小成交额的订单", async () => {
  const client = createClient();
  client.exchangeInfo = async () => ({
    symbol: {
      status: "TRADING",
      filters: [
        { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "1000000", tickSize: "0.01" },
        { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "100", stepSize: "0.00001" },
        { filterType: "MIN_NOTIONAL", minNotional: "10" },
      ],
    },
  });
  client.request = async () => ({ price: "50000" });

  await assert.rejects(
    client.prepareOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.00001", price: "50000" }),
    (error) => error instanceof BinanceApiError && /最小值/.test(error.message)
  );
});

test("MARKET 委托不会发送页面残留的 price 和 stopPrice", async () => {
  const client = createClient();
  client.exchangeInfo = async () => ({
    symbol: { status: "TRADING", filters: [] },
  });

  const result = await client.prepareOrder({
    symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "0.01",
    price: "1", stopPrice: "2",
  });

  assert.equal(result.params.price, undefined);
  assert.equal(result.params.stopPrice, undefined);
});

test("现货 MARKET 按总价下单时直接发送 quoteOrderQty", async () => {
  const client = createClient();
  client.exchangeInfo = async () => ({
    symbol: {
      status: "TRADING",
      filters: [{ filterType: "MIN_NOTIONAL", minNotional: "5" }],
    },
  });

  const result = await client.prepareOrder({
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quoteOrderQty: "100",
    price: "50000",
  });

  assert.equal(result.params.quoteOrderQty, "100");
  assert.equal(result.params.quantity, undefined);
  assert.equal(result.params.price, undefined);
  assert.deepEqual(result.orderSizing, {
    mode: "quote-total",
    requestedQuoteOrderQty: "100",
    directQuoteOrderQty: true,
  });
  client.close();
});

test("现货 LIMIT 按总价下单时按对齐后的委托价换算数量", async () => {
  const client = createClient();
  client.exchangeInfo = async () => ({
    symbol: {
      status: "TRADING",
      filters: [
        { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "1000000", tickSize: "0.1" },
        { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
        { filterType: "MIN_NOTIONAL", minNotional: "5" },
      ],
    },
  });

  const result = await client.prepareOrder({
    symbol: "BTCUSDT",
    side: "BUY",
    type: "LIMIT",
    quoteOrderQty: "100",
    price: "333.39",
  });

  assert.equal(result.params.price, "333.3");
  assert.equal(result.params.quantity, "0.300");
  assert.equal(result.params.quoteOrderQty, undefined);
  assert.equal(result.orderSizing.referenceSource, "委托价");
  assert.equal(result.orderSizing.convertedQuantity, "0.300");
  assert.match(result.adjustments.join(";"), /总价模式/);
  client.close();
});

test("现货下单拒绝同时提供数量和总价", async () => {
  const client = createClient();
  client.exchangeInfo = async () => ({
    symbol: { status: "TRADING", filters: [] },
  });

  await assert.rejects(
    client.prepareOrder({
      symbol: "BTCUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: "0.01",
      quoteOrderQty: "100",
    }),
    (error) => error instanceof BinanceApiError && /只能选择一种/.test(error.message)
  );
  client.close();
});

test("现货按总价卖出启用余额预查时换算基础资产数量", async () => {
  const client = createClient();
  client.accountStatus = async () => ({
    balances: [{ asset: "BTC", free: "0.001" }],
  });
  client.lastTradePriceCache.set("BTCUSDT", {
    price: "50000",
    loadedAt: Date.now(),
  });

  await assert.rejects(
    client.validateAvailableBalance(
      {
        symbol: "BTCUSDT",
        side: "SELL",
        type: "MARKET",
        quoteOrderQty: "100",
      },
      { baseAsset: "BTC", quoteAsset: "USDT" }
    ),
    (error) => error instanceof BinanceApiError && /BTC 可用余额不足/.test(error.message)
  );
  client.close();
});

test("签名请求复用后台同步的服务器时间，不逐笔访问 /time", async () => {
  const client = createClient();
  client.serverTimeCache.set(client.tradingRestBase, {
    serverTime: Date.now(),
    localMidpoint: Date.now(),
    offsetMs: 8,
    baseUrl: client.tradingRestBase,
    synchronizedAt: Date.now(),
    reused: false,
  });
  client.request = async () => {
    throw new Error("不应重新请求服务器时间");
  };

  const result = await client.ensureTradingServerTime();
  assert.equal(result.reused, true);
  assert.equal(result.offsetMs, 8);
});

test("下单优先复用独立交易 WebSocket，且低延迟模式不做余额预查", async () => {
  const client = createClient();
  client.serverTimeCache.set(client.tradingRestBase, {
    serverTime: Date.now(),
    localMidpoint: Date.now(),
    offsetMs: 0,
    baseUrl: client.tradingRestBase,
    synchronizedAt: Date.now(),
  });
  client.prepareOrder = async () => ({
    params: {
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: "0.001",
      price: "50000",
      timeInForce: "GTC",
      newClientOrderId: "vc-test-order",
    },
    adjustments: [],
    symbolInfo: { baseAsset: "BTC", quoteAsset: "USDT" },
  });
  client.validateAvailableBalance = async () => {
    throw new Error("低延迟模式不应查询余额");
  };

  const socket = {
    readyState: 1,
    send(payload) {
      const request = JSON.parse(payload);
      assert.equal(request.method, "order.place");
      assert.equal(request.params.newClientOrderId, "vc-test-order");
      setImmediate(() => client.handleWsApiResponse({
        id: request.id,
        status: 200,
        result: {
          symbol: "BTCUSDT",
          orderId: 123,
          clientOrderId: "vc-test-order",
          status: "NEW",
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

  const result = await client.placeOrder({ symbol: "BTCUSDT" });
  assert.equal(result.orderId, 123);
  assert.equal(result.transport, "websocket");
  assert.equal(result.preflightBalanceCheck, false);
});

test("币安拒绝的现货订单会发布可持久化的 REJECTED 状态", async () => {
  const client = createClient();
  client.serverTimeCache.set(client.tradingRestBase, {
    offsetMs: 0,
    synchronizedAt: Date.now(),
  });
  client.prepareOrder = async () => ({
    params: {
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: "0.001",
      price: "50000",
      newClientOrderId: "rejected-client-order",
    },
    adjustments: [],
    symbolInfo: {},
  });
  const socket = {
    readyState: 1,
    send(payload) {
      const request = JSON.parse(payload);
      setImmediate(() => client.handleWsApiResponse({
        id: request.id,
        status: 400,
        error: { code: -2010, msg: "Order rejected" },
      }, socket));
    },
    close() {},
    terminate() {},
  };
  client.tradingWsApiSocket = socket;
  const attemptPromise = new Promise((resolve) => {
    client.once("order-state-update", resolve);
  });

  await assert.rejects(
    client.placeOrder({ symbol: "BTCUSDT" }),
    (error) => error.code === -2010
  );
  const attempt = await attemptPromise;
  assert.equal(attempt.marketType, "spot");
  assert.equal(attempt.status, "REJECTED");
  assert.equal(attempt.clientOrderId, undefined);
  assert.equal(attempt.newClientOrderId, "rejected-client-order");
  assert.equal(attempt.rejectReason, "Order rejected");
  client.tradingWsApiSocket = null;
  client.close();
});

test("交易 WebSocket 尚在连接时，报单等待其就绪而不是直接走 HTTP", async () => {
  const client = createClient();
  client.serverTimeCache.set(client.tradingRestBase, {
    serverTime: Date.now(),
    localMidpoint: Date.now(),
    offsetMs: 0,
    baseUrl: client.tradingRestBase,
    synchronizedAt: Date.now(),
  });
  client.prepareOrder = async () => ({
    params: {
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: "0.001",
      price: "50000",
      newOrderRespType: "ACK",
    },
    adjustments: [],
    symbolInfo: {},
  });
  let httpOrderCount = 0;
  client.request = async () => {
    httpOrderCount += 1;
    return {};
  };
  const socket = {
    readyState: 1,
    send(payload) {
      const request = JSON.parse(payload);
      setImmediate(() => client.handleWsApiResponse({
        id: request.id,
        status: 200,
        result: { symbol: "BTCUSDT", orderId: 456, clientOrderId: "ack-456" },
      }, socket));
    },
    close() {},
    terminate() {},
  };
  let connectCount = 0;
  client.connectTradingWebSocket = async () => {
    connectCount += 1;
    await new Promise((resolve) => setImmediate(resolve));
    client.tradingWsApiSocket = socket;
    return { connected: true };
  };

  const result = await client.placeOrder({ symbol: "BTCUSDT" });

  assert.equal(connectCount, 1);
  assert.equal(httpOrderCount, 0);
  assert.equal(result.orderId, 456);
  assert.equal(result.transport, "websocket");
  client.tradingWsApiSocket = null;
  client.close();
});

test("单笔撤单优先复用独立交易 WebSocket", async () => {
  const client = createClient();
  client.serverTimeCache.set(client.tradingRestBase, {
    serverTime: Date.now(),
    localMidpoint: Date.now(),
    offsetMs: 0,
    baseUrl: client.tradingRestBase,
    synchronizedAt: Date.now(),
  });

  const socket = {
    readyState: 1,
    send(payload) {
      const request = JSON.parse(payload);
      assert.equal(request.method, "order.cancel");
      assert.equal(request.params.symbol, "BTCUSDT");
      assert.equal(request.params.orderId, "123");
      setImmediate(() => client.handleWsApiResponse({
        id: request.id,
        status: 200,
        result: {
          symbol: "BTCUSDT",
          orderId: 123,
          clientOrderId: "vc-test-order",
          status: "CANCELED",
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

  const result = await client.cancelOrder({
    symbol: "BTCUSDT",
    orderId: 123,
  });
  assert.equal(result.status, "CANCELED");
  assert.equal(result.transport, "websocket");
});
