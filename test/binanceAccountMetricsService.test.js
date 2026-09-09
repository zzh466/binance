const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BinanceAccountMetricsService,
  SpotPnlStore,
  buildTickerPriceMap,
  convertAssetToUsdt,
  normalizeSpotFill,
  summarizeSpotTradeHistory,
  summarizeFuturesIncome,
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
  assert.equal(store.getRollingCommission("production:account"), "1.5");
  assert.equal(store.getUnrealizedPnl("production:account", prices), "11.4");
  assert.equal(store.getOpenPositionCount("production:account"), 1);
});

test("U 本位收益流水区分平仓盈亏、手续费和资金费", () => {
  const summary = summarizeFuturesIncome([
    { incomeType: "REALIZED_PNL", income: "3", asset: "USDT" },
    { incomeType: "COMMISSION", income: "-0.2", asset: "USDT" },
    { incomeType: "FUNDING_FEE", income: "-0.1", asset: "USDT" },
  ], new Map());
  assert.equal(summary.realizedPnl24h, "3");
  assert.equal(summary.commission24h, "0.2");
  assert.equal(summary.fundingFee24h, "-0.1");
  assert.equal(summary.actualPnl24h, "2.7");
});

test("现货最近 24 小时成交可以重建程序启动前的闭合盈亏", async () => {
  const now = 5_000_000;
  const prices = buildTickerPriceMap([
    { symbol: "BTCUSDT", price: "110" },
  ]);
  const fills = [
    normalizeSpotFill({
      symbol: "BTCUSDT",
      id: 1,
      isBuyer: true,
      qty: "1",
      quoteQty: "100",
      price: "100",
      commission: "0.1",
      commissionAsset: "USDT",
      time: now - 10_000,
    }, { baseAsset: "BTC", quoteAsset: "USDT" }),
    normalizeSpotFill({
      symbol: "BTCUSDT",
      id: 2,
      isBuyer: false,
      qty: "1",
      quoteQty: "110",
      price: "110",
      commission: "0.2",
      commissionAsset: "USDT",
      time: now - 5_000,
    }, { baseAsset: "BTC", quoteAsset: "USDT" }),
  ];
  const summary = summarizeSpotTradeHistory(fills, prices, now);
  assert.equal(summary.realizedPnl24h, "9.7");
  assert.equal(summary.commission24h, "0.3");
  assert.equal(summary.incompleteSellCount, 0);

  const service = new BinanceAccountMetricsService({ now: () => now });
  const metrics = await service.refresh({
    client: {
      spot: {
        apiKey: "spot-key",
        apiSecret: "spot-secret",
        accountStatus: async () => ({
          balances: [{ asset: "USDT", free: "109.7", locked: "0" }],
        }),
        tickerPrices: async () => [{ symbol: "BTCUSDT", price: "110" }],
        exchangeInfo: async () => ({
          symbol: { baseAsset: "BTC", quoteAsset: "USDT" },
        }),
        myTrades: async () => fills.map((fill) => ({
          symbol: fill.symbol,
          id: fill.tradeId,
          isBuyer: fill.side === "BUY",
          qty: fill.quantity,
          quoteQty: fill.quoteQuantity,
          price: fill.price,
          commission: fill.commission,
          commissionAsset: fill.commissionAsset,
          time: fill.time,
        })),
      },
      futures: { apiKey: "", apiSecret: "" },
    },
    environment: "testnet",
    accountFingerprint: "account",
    knownSpotSymbols: ["BTCUSDT"],
  });
  assert.equal(metrics.realProfit, "9.7");
  assert.equal(metrics.closeProfit, "9.7");
  assert.equal(metrics.commission, "0.3");
  assert.equal(metrics.complete, true);
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
        totalInitialMargin: "4",
        positions: [
          { symbol: "BTCUSDT", positionAmt: "0.01" },
          { symbol: "ETHUSDT", positionAmt: "0" },
        ],
      }),
      incomeHistory: async () => [
        { incomeType: "REALIZED_PNL", income: "3", asset: "USDT" },
        { incomeType: "COMMISSION", income: "-1", asset: "USDT" },
        { incomeType: "FUNDING_FEE", income: "0.5", asset: "USDT" },
      ],
    },
  };

  const metrics = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "fingerprint",
    openOrderCount: 3,
  });

  assert.equal(metrics.staticBalance, "160");
  assert.equal(metrics.balance, "162");
  assert.equal(metrics.available, "158");
  assert.equal(metrics.margin, "4");
  assert.equal(metrics.closeProfit, "3");
  assert.equal(metrics.commission, "1");
  assert.equal(metrics.realProfit, "2.5");
  assert.equal(metrics.positionProfit, "2");
  assert.equal(metrics.openVolume, 2);
  assert.equal(metrics.orderVolume, 3);
  assert.equal(metrics.spot.realizedPnl24h, "0");
  assert.deepEqual(metrics.warnings, []);
  assert.deepEqual(valueSpotBalances([
    { asset: "USDT", free: "1", locked: "2" },
  ], new Map()), {
    totalBalanceUsdt: "3",
    availableUsdt: "1",
    lockedUsdt: "2",
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
  assert.equal(result.commission24h, "1");
  assert.equal(result.unrealizedProfit, "0");
  assert.equal(result.ledger.realizedTradeCount, 1);
});

test("两秒轻量刷新复用历史盈亏且不重复查询收益历史", async () => {
  let now = 30_000_000;
  let incomeRequestCount = 0;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const spotAccount = {
    balances: [{ asset: "USDT", free: "100", locked: "0" }],
  };
  const futuresAccount = {
    totalWalletBalance: "10",
    totalMarginBalance: "11",
    availableBalance: "8",
    totalUnrealizedProfit: "1",
  };
  const client = {
    spot: {
      apiKey: "spot-key",
      apiSecret: "spot-secret",
      accountStatus: async () => spotAccount,
      tickerPrices: async () => [],
    },
    futures: {
      apiKey: "futures-key",
      apiSecret: "futures-secret",
      accountStatus: async () => futuresAccount,
      incomeHistory: async () => {
        incomeRequestCount += 1;
        return [{ incomeType: "REALIZED_PNL", income: "2.5", asset: "USDT" }];
      },
    },
  };

  const full = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });
  now += 2_000;
  spotAccount.balances[0].free = "120";
  futuresAccount.totalWalletBalance = "12";
  const light = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
    reconcileHistory: false,
  });

  assert.equal(full.realProfit, "2.5");
  assert.equal(light.realProfit, "2.5");
  assert.equal(light.staticBalance, "132");
  assert.equal(light.historyReconciled, false);
  assert.equal(incomeRequestCount, 1);
});
