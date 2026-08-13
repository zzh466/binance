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
