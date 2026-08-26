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

test("深度快照按 lastUpdateId + 1 衔接首条增量", async () => {
  const client = createClient(false);
  const socket = {};
  client.marketSocket = socket;
  client.marketSymbol = "BTCUSDT";
  client.marketManualClose = false;
  client.depthEventBuffer = [
    {
      U: 90,
      u: 99,
      b: [],
      a: [],
    },
    {
      U: 101,
      u: 102,
      b: [["50000", "1"]],
      a: [["50001", "2"]],
    },
  ];
  client.request = async () => ({
    lastUpdateId: 100,
    bids: [["49999", "3"]],
    asks: [["50002", "4"]],
  });

  await client.synchronizeDepthSnapshot(socket, "BTCUSDT");

  assert.equal(client.depthReady, true);
  assert.equal(client.orderBook.lastUpdateId, 102);
  assert.deepEqual(client.orderBook.getTopLevels(1), {
    bids: [{ price: "50000", quantity: "1" }],
    asks: [{ price: "50001", quantity: "2" }],
  });
  client.marketSocket = null;
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
  assert.equal(result.adjustments.length, 2);
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
