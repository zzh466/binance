const assert = require("node:assert/strict");
const test = require("node:test");
const { BinanceApiError } = require("../src/binance/binanceSpotClient");
const { BinanceUsdMClient } = require("../src/binance/binanceUsdMClient");
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

test("永续下单复用统一表单并映射 Spot 风格止损限价类型", async () => {
  const client = new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
  });
  client.exchangeInfo = async () => ({ symbol: futuresSymbol() });
  let submitted;
  client.signedRest = async (method, path, params) => {
    submitted = { method, path, params };
    return { symbol: params.symbol, orderId: 7, status: "NEW" };
  };

  const result = await client.placeOrder({
    symbol: "SKHYUSDT",
    side: "SELL",
    type: "STOP_LOSS_LIMIT",
    quantity: "0.0319",
    price: "200.19",
    stopPrice: "199.99",
    timeInForce: "GTC",
  });

  assert.equal(submitted.path, "/fapi/v1/order");
  assert.equal(submitted.params.type, "STOP");
  assert.equal(submitted.params.quantity, "0.031");
  assert.equal(submitted.params.price, "200.1");
  assert.equal(result.marketType, MARKET_FUTURES);
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

test("永续深度使用 pu 衔接，不要求 U 数值连续", () => {
  const client = new BinanceUsdMClient();
  client.orderBook.loadSnapshot({
    symbol: "BTCUSDT",
    lastUpdateId: 100,
    bids: [["50000", "1"]],
    asks: [["50001", "1"]],
  });

  const result = client.applyDepthEventToOrderBook({
    U: 105,
    u: 110,
    pu: 100,
    b: [["50000", "2"]],
    a: [],
  });

  assert.equal(result.applied, true);
  assert.equal(client.orderBook.lastUpdateId, 110);
  assert.equal(client.orderBook.getTopLevels(1).bids[0].quantity, "2");
  client.close();
});
