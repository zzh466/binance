const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BinanceAccountMetricsService,
  SpotPnlStore,
  buildTickerPriceMap,
  convertAssetToUsdt,
  normalizeSpotFill,
  valueSpotBalances,
} = require("../src/binanceAccountMetricsService");

test("现货资产可按直接、反向和 BTC 中间价折算为 USDT", () => {
  const prices = buildTickerPriceMap([
    { symbol: "BTCUSDT", price: "50000" },
    { symbol: "ETHBTC", price: "0.05" },
    { symbol: "USDTTRY", price: "35" },
  ]);
  assert.equal(convertAssetToUsdt("BTC", "0.1", prices), "5000");
  assert.equal(convertAssetToUsdt("ETH", "2", prices), "5000");
  assert.equal(convertAssetToUsdt("TRY", "350", prices), "10");
  assert.equal(convertAssetToUsdt("UNKNOWN", "1", prices), null);
});

test("现货账本只按成交计算平均成本已实现盈亏并去重", () => {
  let now = 2_000_000;
  const store = new SpotPnlStore(null, { now: () => now });
  const prices = buildTickerPriceMap([
    { symbol: "BTCUSDT", price: "120" },
  ]);
  const buy = normalizeSpotFill({
    symbol: "BTCUSDT",
    id: 1,
    isBuyer: true,
    qty: "1",
    quoteQty: "100",
    price: "100",
    commission: "1",
    commissionAsset: "USDT",
    time: now - 1_000,
  }, { baseAsset: "BTC", quoteAsset: "USDT" });
  const sell = normalizeSpotFill({
    symbol: "BTCUSDT",
    id: 2,
    isBuyer: false,
    qty: "0.4",
    quoteQty: "48",
    price: "120",
    commission: "0.5",
    commissionAsset: "USDT",
    time: now,
  }, { baseAsset: "BTC", quoteAsset: "USDT" });

  store.recordFill("production:account", buy, prices);
  store.recordFill("production:account", sell, prices);
  store.recordFill("production:account", sell, prices);

  assert.equal(store.getRollingRealizedPnl("production:account"), "7.1");
  assert.equal(
    store.getScope("production:account").positions.BTC.quantity,
    "0.6"
  );
  assert.equal(
    store.getScope("production:account").positions.BTC.costUsdt,
    "60.6"
  );
  assert.equal(store.getStatus("production:account").realizedTradeCount, 1);
});

test("账户指标合并现货 USDT 估值与 U 本位账户数据", async () => {
  const now = 10_000_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const client = {
    spot: {
      apiKey: "spot-key",
      apiSecret: "spot-secret",
      accountStatus: async () => ({
        balances: [
          { asset: "USDT", free: "100", locked: "0" },
          { asset: "BTC", free: "1", locked: "0" },
        ],
      }),
      tickerPrices: async () => [
        { symbol: "BTCUSDT", price: "50" },
      ],
    },
    futures: {
      apiKey: "futures-key",
      apiSecret: "futures-secret",
      accountStatus: async () => ({
        totalWalletBalance: "10",
        totalMarginBalance: "12",
        availableBalance: "8",
        totalUnrealizedProfit: "2",
      }),
      incomeHistory: async () => [
        { income: "3", asset: "USDT" },
        { income: "-1", asset: "USDT" },
      ],
    },
  };

  const metrics = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "fingerprint",
  });

  assert.equal(metrics.staticBalance, "160");
  assert.equal(metrics.balance, "162");
  assert.equal(metrics.available, "158");
  assert.equal(metrics.realProfit, "2");
  assert.equal(metrics.positionProfit, "2");
  assert.equal(metrics.spot.realizedPnl24h, "0");
  assert.deepEqual(metrics.warnings, []);
  assert.deepEqual(valueSpotBalances([
    { asset: "USDT", free: "1", locked: "2" },
  ], new Map()), {
    totalBalanceUsdt: "3",
    availableUsdt: "1",
    unpricedAssets: [],
  });
});

test("现货 executionReport 成交可以即时写入已初始化账本", async () => {
  const now = 20_000_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const client = {
    spot: {
      apiKey: "spot-key",
      apiSecret: "spot-secret",
      accountStatus: async () => ({
        balances: [{ asset: "USDT", free: "100", locked: "0" }],
      }),
      tickerPrices: async () => [{ symbol: "BTCUSDT", price: "100" }],
    },
    futures: {
      apiKey: "",
      apiSecret: "",
    },
  };
  await service.refresh({
    client,
    environment: "testnet",
    accountFingerprint: "account",
  });

  service.ingestSpotExecution({
    environment: "testnet",
    accountFingerprint: "account",
    event: {
      e: "executionReport",
      x: "TRADE",
      s: "BTCUSDT",
      S: "BUY",
      t: 10,
      l: "1",
      L: "100",
      Y: "100",
      n: "0",
      N: "USDT",
      T: now - 1,
    },
  });
  const result = service.ingestSpotExecution({
    environment: "testnet",
    accountFingerprint: "account",
    event: {
      e: "executionReport",
      x: "TRADE",
      s: "BTCUSDT",
      S: "SELL",
      t: 11,
      l: "0.5",
      L: "110",
      Y: "55",
      n: "1",
      N: "USDT",
      T: now,
    },
  });

  assert.equal(result.realizedPnl24h, "4");
  assert.equal(result.ledger.realizedTradeCount, 1);
});
