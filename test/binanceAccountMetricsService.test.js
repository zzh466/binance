const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BinanceAccountMetricsService,
  HISTORY_RECONCILE_INTERVAL_MS,
  buildFuturesPositionRows,
  summarizeFuturesIncome,
} = require("../src/binanceAccountMetricsService");

function futuresAccount(overrides = {}) {
  return {
    totalWalletBalance: "10",
    totalMarginBalance: "12",
    availableBalance: "8",
    totalUnrealizedProfit: "2",
    totalInitialMargin: "4",
    positions: [],
    ...overrides,
  };
}

function futuresClient({ accountStatus, incomeHistory, positionRisk } = {}) {
  const futures = {
    apiKey: "futures-key",
    apiSecret: "futures-secret",
    accountStatus: accountStatus || (async () => futuresAccount()),
    incomeHistory: incomeHistory || (async () => []),
  };
  if (positionRisk) futures.positionRisk = positionRisk;
  return { futures };
}

test("U 本位持仓快照过滤零仓位并保留方向和保证金字段", () => {
  const rows = buildFuturesPositionRows({
    positions: [
      {
        symbol: "BTCUSDT",
        positionAmt: "-0.02",
        entryPrice: "60000",
        notional: "-1220",
        unrealizedProfit: "-20",
        positionInitialMargin: "122",
        leverage: "10",
        isolated: false,
        updateTime: 1200,
      },
      { symbol: "ETHUSDT", positionAmt: "0" },
    ],
  }, 1234);

  assert.deepEqual(rows, [{
    marketType: "futures",
    symbol: "BTCUSDT",
    asset: "BTCUSDT",
    side: "SHORT",
    positionSide: "BOTH",
    positionAmount: "0.02",
    availableAmount: null,
    lockedAmount: "122",
    entryPrice: "60000",
    markPrice: "61000",
    notionalUsdt: "1220",
    unrealizedPnl: "-20",
    leverage: "10",
    marginMode: "全仓",
    updateTime: 1200,
  }]);
});

test("持仓响应缺失或 positionAmt 非法时必须失败而不能视为空仓", () => {
  assert.throws(
    () => buildFuturesPositionRows({}),
    /缺少有效的 positions 数组/
  );
  assert.throws(
    () => buildFuturesPositionRows({
      positions: [{ symbol: "BTCUSDT", positionAmt: "not-a-number" }],
    }),
    /positionAmt 不是有效的十进制数/
  );
  assert.throws(
    () => buildFuturesPositionRows({
      positions: [{ symbol: "", positionAmt: "1" }],
    }),
    /缺少 symbol/
  );
});

test("U 本位 24 小时收益区分平仓盈亏、手续费和资金费", () => {
  const summary = summarizeFuturesIncome([
    { incomeType: "REALIZED_PNL", income: "3", asset: "USDT" },
    { incomeType: "COMMISSION", income: "-0.2", asset: "USDT" },
    { incomeType: "FUNDING_FEE", income: "-0.1", asset: "USDT" },
  ]);

  assert.equal(summary.realizedPnl24h, "3");
  assert.equal(summary.commission24h, "0.2");
  assert.equal(summary.fundingFee24h, "-0.1");
  assert.equal(summary.actualPnl24h, "2.7");
});

test("账户指标只由 U 本位账户资金、持仓和收益组成", async () => {
  const now = 100_000_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const metrics = await service.refresh({
    client: futuresClient({
      accountStatus: async () => futuresAccount({
        positions: [
          {
            symbol: "BTCUSDT",
            positionAmt: "0.01",
            entryPrice: "49000",
            markPrice: "50000",
            notional: "500",
            unrealizedProfit: "2",
            leverage: "20",
          },
          { symbol: "ETHUSDT", positionAmt: "0" },
        ],
      }),
      incomeHistory: async () => [
        { incomeType: "REALIZED_PNL", income: "3", asset: "USDT" },
        { incomeType: "COMMISSION", income: "-1", asset: "USDT" },
        { incomeType: "FUNDING_FEE", income: "0.5", asset: "USDT" },
      ],
    }),
    environment: "production",
    accountFingerprint: "fingerprint",
    openOrderCount: 3,
  });

  assert.equal(metrics.staticBalance, "10");
  assert.equal(metrics.balance, "12");
  assert.equal(metrics.available, "8");
  assert.equal(metrics.margin, "4");
  assert.equal(metrics.closeProfit, "3");
  assert.equal(metrics.commission, "1");
  assert.equal(metrics.realProfit, "2.5");
  assert.equal(metrics.positionProfit, "2");
  assert.equal(metrics.openVolume, 1);
  assert.equal(metrics.orderVolume, 3);
  assert.equal(metrics.positions.length, 1);
  assert.equal(metrics.positions[0].marketType, "futures");
  assert.equal(metrics.positionsComplete, true);
  assert.equal(metrics.accountComplete, true);
  assert.equal(metrics.incomeComplete, true);
  assert.deepEqual(Object.keys(metrics.positionSources), ["futures"]);
  assert.equal(metrics.complete, true);
  assert.equal(metrics.historyReconciled, true);
  assert.deepEqual(metrics.warnings, []);
});

test("收益历史在五分钟内复用缓存，过期后才重新对账", async () => {
  let now = 200_000_000;
  let incomeRequestCount = 0;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const client = futuresClient({
    incomeHistory: async () => {
      incomeRequestCount += 1;
      return [{
        incomeType: "REALIZED_PNL",
        income: String(incomeRequestCount),
        asset: "USDT",
      }];
    },
  });

  const initial = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });
  now += HISTORY_RECONCILE_INTERVAL_MS - 1;
  const cached = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });
  now += 1;
  const reconciled = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });

  assert.equal(initial.realProfit, "1");
  assert.equal(cached.realProfit, "1");
  assert.equal(cached.historyReconciled, false);
  assert.equal(reconciled.realProfit, "2");
  assert.equal(reconciled.historyReconciled, true);
  assert.equal(incomeRequestCount, 2);
});

test("轻量刷新复用收益缓存并由 WebSocket 增量更新成交和资金费", async () => {
  let now = 300_000_000;
  let incomeRequestCount = 0;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const client = futuresClient({
    incomeHistory: async () => {
      incomeRequestCount += 1;
      return [
        { incomeType: "REALIZED_PNL", income: "2", asset: "USDT" },
        { incomeType: "COMMISSION", income: "-0.1", asset: "USDT" },
      ];
    },
  });
  await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });

  now += 1_000;
  const tradeEvent = {
    e: "executionReport",
    x: "TRADE",
    s: "BTCUSDT",
    i: 123,
    t: 456,
    T: now,
    rp: "3",
    n: "0.2",
    N: "USDT",
    ma: "USDT",
  };
  const afterTrade = service.ingestFuturesExecution({
    environment: "production",
    accountFingerprint: "account",
    event: tradeEvent,
  });
  const duplicateTrade = service.ingestFuturesExecution({
    environment: "production",
    accountFingerprint: "account",
    event: tradeEvent,
  });

  now += 1_000;
  const fundingEvent = {
    e: "ACCOUNT_UPDATE",
    E: now,
    T: now,
    a: {
      m: "FUNDING_FEE",
      B: [{ a: "USDT", bc: "-0.25" }],
    },
  };
  const afterFunding = service.ingestFuturesAccountUpdate({
    environment: "production",
    accountFingerprint: "account",
    event: fundingEvent,
  });
  const duplicateFunding = service.ingestFuturesAccountUpdate({
    environment: "production",
    accountFingerprint: "account",
    event: fundingEvent,
  });

  const light = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
    reconcileHistory: false,
  });

  assert.equal(afterTrade.realizedPnl24h, "5");
  assert.equal(afterTrade.commission24h, "0.3");
  assert.equal(afterTrade.actualPnl24h, "4.7");
  assert.equal(duplicateTrade, null);
  assert.equal(afterFunding.fundingFee24h, "-0.25");
  assert.equal(afterFunding.actualPnl24h, "4.45");
  assert.equal(duplicateFunding, null);
  assert.equal(light.realProfit, "4.45");
  assert.equal(light.commission, "0.3");
  assert.equal(light.historyReconciled, false);
  assert.equal(incomeRequestCount, 1);
});

test("慢账户刷新不会把等待期间收到的实时实际盈亏覆盖回旧值", async () => {
  let now = 325_000_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  await service.refresh({
    client: futuresClient({ incomeHistory: async () => [] }),
    environment: "production",
    accountFingerprint: "account",
  });

  let releaseAccount;
  const delayedAccount = new Promise((resolve) => {
    releaseAccount = resolve;
  });
  const refreshPromise = service.refresh({
    client: futuresClient({
      accountStatus: () => delayedAccount,
      incomeHistory: async () => {
        throw new Error("轻量刷新不应查询收益历史");
      },
    }),
    environment: "production",
    accountFingerprint: "account",
    reconcileHistory: false,
  });

  now += 1_000;
  const realtime = service.ingestFuturesExecution({
    environment: "production",
    accountFingerprint: "account",
    event: {
      e: "executionReport",
      x: "TRADE",
      s: "BTCUSDT",
      i: 321,
      t: 654,
      T: now,
      rp: "3",
      n: "0.2",
      N: "USDT",
      ma: "USDT",
    },
  });
  releaseAccount(futuresAccount());
  const refreshed = await refreshPromise;

  assert.equal(realtime.actualPnl24h, "2.8");
  assert.equal(refreshed.closeProfit, "3");
  assert.equal(refreshed.commission, "0.2");
  assert.equal(refreshed.realProfit, "2.8");
});

test("收益对账进行中到达的 WebSocket 增量不会被历史结果覆盖", async () => {
  const now = 350_000_000;
  let resolveIncomeHistory;
  const incomeHistoryResult = new Promise((resolve) => {
    resolveIncomeHistory = resolve;
  });
  const service = new BinanceAccountMetricsService({ now: () => now });
  const refreshPromise = service.refresh({
    client: futuresClient({
      incomeHistory: () => incomeHistoryResult,
    }),
    environment: "production",
    accountFingerprint: "account",
  });

  const realtime = service.ingestFuturesExecution({
    environment: "production",
    accountFingerprint: "account",
    event: {
      e: "executionReport",
      x: "TRADE",
      s: "BTCUSDT",
      i: 10,
      t: 20,
      T: now,
      rp: "3",
      n: "0.2",
      N: "USDT",
      ma: "USDT",
    },
  });
  resolveIncomeHistory([
    { incomeType: "REALIZED_PNL", income: "2", asset: "USDT" },
  ]);
  const metrics = await refreshPromise;

  assert.equal(realtime.actualPnl24h, "2.8");
  assert.equal(metrics.closeProfit, "5");
  assert.equal(metrics.commission, "0.2");
  assert.equal(metrics.realProfit, "4.8");
});

test("账户接口短暂失败时保留最后一次有效资金和持仓", async () => {
  let now = 400_000_000;
  let accountShouldFail = false;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const client = futuresClient({
    accountStatus: async () => {
      if (accountShouldFail) throw new Error("temporary account failure");
      return futuresAccount({
        positions: [{
          symbol: "BTCUSDT",
          positionAmt: "0.01",
          entryPrice: "50000",
          notional: "500",
          unrealizedProfit: "2",
        }],
      });
    },
    incomeHistory: async () => [
      { incomeType: "REALIZED_PNL", income: "3", asset: "USDT" },
    ],
  });
  await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });

  now += 2_000;
  accountShouldFail = true;
  const degraded = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
    reconcileHistory: false,
  });

  assert.equal(degraded.staticBalance, "10");
  assert.equal(degraded.positionProfit, "2");
  assert.equal(degraded.positions.length, 1);
  assert.equal(degraded.realProfit, "3");
  assert.equal(degraded.complete, false);
  assert.equal(degraded.positionsComplete, false);
  assert.equal(degraded.positionSources.futures.ok, false);
  assert.match(
    degraded.positionSources.futures.error.message,
    /temporary account failure/
  );
});

test("收益接口短暂失败时保留最后一次有效的 24 小时收益", async () => {
  let now = 500_000_000;
  let incomeShouldFail = false;
  const account = futuresAccount();
  const service = new BinanceAccountMetricsService({ now: () => now });
  const client = futuresClient({
    accountStatus: async () => account,
    incomeHistory: async () => {
      if (incomeShouldFail) throw new Error("temporary income failure");
      return [{ incomeType: "REALIZED_PNL", income: "3", asset: "USDT" }];
    },
  });
  await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });

  now += HISTORY_RECONCILE_INTERVAL_MS;
  account.totalWalletBalance = "11";
  incomeShouldFail = true;
  const degraded = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });

  assert.equal(degraded.staticBalance, "11");
  assert.equal(degraded.realProfit, "3");
  assert.equal(degraded.futures.realizedPnl24h, "3");
  assert.equal(degraded.historyReconciled, false);
  assert.equal(degraded.complete, false);
  assert.equal(degraded.positionsComplete, true);
  assert.match(degraded.warnings[0].message, /temporary income failure/);
});

test("账户返回 200 但缺少 positions 时保留旧仓并标记持仓不完整", async () => {
  let now = 600_000_000;
  let malformed = false;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const client = futuresClient({
    accountStatus: async () => malformed
      ? futuresAccount({ positions: undefined })
      : futuresAccount({
          positions: [{
            symbol: "BTCUSDT",
            positionAmt: "0.01",
            entryPrice: "50000",
            notional: "500",
            unrealizedProfit: "1",
          }],
        }),
  });
  const initial = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });
  const initialPositionsUpdatedAt = initial.positionsUpdatedAt;

  now += 2_000;
  malformed = true;
  const degraded = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
    reconcileHistory: false,
  });

  assert.equal(degraded.positions.length, 1);
  assert.equal(degraded.positions[0].symbol, "BTCUSDT");
  assert.equal(degraded.positionsComplete, false);
  assert.equal(degraded.positionSources.futures.ok, false);
  assert.equal(degraded.positionsUpdatedAt, initialPositionsUpdatedAt);
  assert.match(
    degraded.positionSources.futures.error.message,
    /positions 数组/
  );
});

test("独立 positionRisk 优先于 account.status 的持仓数组", async () => {
  let positionRiskCalls = 0;
  const service = new BinanceAccountMetricsService({ now: () => 700_000_000 });
  const metrics = await service.refresh({
    client: futuresClient({
      accountStatus: async () => futuresAccount({ positions: undefined }),
      positionRisk: async () => {
        positionRiskCalls += 1;
        return [{
          symbol: "ETHUSDT",
          positionSide: "BOTH",
          positionAmt: "-2",
          entryPrice: "2500",
          markPrice: "2490",
          notional: "-4980",
          unRealizedProfit: "20",
        }];
      },
    }),
    environment: "production",
    accountFingerprint: "account",
  });

  assert.equal(positionRiskCalls, 1);
  assert.equal(metrics.positionsComplete, true);
  assert.equal(metrics.positionSources.futures.operation, "positionRisk");
  assert.equal(metrics.positions.length, 1);
  assert.equal(metrics.positions[0].symbol, "ETHUSDT");
  assert.equal(metrics.positions[0].side, "SHORT");
});

test("refreshPositions 可独立返回持仓，不等待账户资金和收益请求", async () => {
  const service = new BinanceAccountMetricsService({ now: () => 710_000_000 });
  const never = new Promise(() => {});
  const client = futuresClient({
    accountStatus: () => never,
    incomeHistory: () => never,
    positionRisk: async () => [{
      symbol: "BTCUSDT",
      positionAmt: "0.02",
      positionSide: "BOTH",
      entryPrice: "50000",
    }],
  });

  const result = await service.refreshPositions({
    client,
    environment: "production",
    accountFingerprint: "account",
  });
  assert.equal(result.positionsComplete, true);
  assert.equal(result.positions[0].positionAmount, "0.02");
});

test("较早发出的持仓查询晚返回时不能覆盖较新的持仓快照", async () => {
  const service = new BinanceAccountMetricsService({ now: () => 715_000_000 });
  let resolveOlder;
  let resolveNewer;
  const responses = [
    new Promise((resolve) => { resolveOlder = resolve; }),
    new Promise((resolve) => { resolveNewer = resolve; }),
  ];
  const client = futuresClient({ positionRisk: () => responses.shift() });
  const older = service.refreshPositions({
    client,
    environment: "production",
    accountFingerprint: "account",
  });
  const newer = service.refreshPositions({
    client,
    environment: "production",
    accountFingerprint: "account",
  });

  resolveNewer([{
    symbol: "ETHUSDT",
    positionSide: "BOTH",
    positionAmt: "1",
    entryPrice: "2500",
  }]);
  const newerResult = await newer;
  resolveOlder([]);
  const olderResult = await older;

  assert.equal(newerResult.positions[0].symbol, "ETHUSDT");
  assert.equal(olderResult.positions[0].symbol, "ETHUSDT");
  assert.equal(
    service.getFuturesPositionSnapshot("production:account").positions[0].symbol,
    "ETHUSDT"
  );
});

test("全量复核等待账户响应时不会丢失刚收到的持仓增量", async () => {
  let now = 717_000_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  let releaseAccount;
  const accountResponse = new Promise((resolve) => {
    releaseAccount = resolve;
  });
  const refresh = service.refresh({
    client: futuresClient({
      positionRisk: async () => [],
      accountStatus: () => accountResponse,
      incomeHistory: async () => [],
    }),
    environment: "production",
    accountFingerprint: "account",
  });

  await new Promise((resolve) => setImmediate(resolve));
  now += 1;
  service.ingestFuturesAccountUpdate({
    environment: "production",
    accountFingerprint: "account",
    event: {
      e: "ACCOUNT_UPDATE",
      T: now,
      a: {
        m: "ORDER",
        P: [{ s: "BTCUSDT", ps: "BOTH", pa: "0.01", ep: "50000" }],
      },
    },
  });
  releaseAccount(futuresAccount({
    positions: [{
      symbol: "ETHUSDT",
      positionSide: "BOTH",
      positionAmt: "1",
      entryPrice: "2500",
    }],
  }));
  const result = await refresh;

  assert.deepEqual(
    result.positions.map((position) => position.symbol),
    ["BTCUSDT", "ETHUSDT"]
  );
  assert.equal(result.positionsComplete, false);
});

test("ACCOUNT_UPDATE 增量按 symbol 和 positionSide 开仓、增减并归零", async () => {
  let now = 800_000_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  await service.refresh({
    client: futuresClient(),
    environment: "production",
    accountFingerprint: "account",
  });
  const incomeUpdatedAt = service.getFuturesIncomeSnapshot(
    "production:account"
  ).updatedAt;

  now += 1_000;
  const opened = service.ingestFuturesAccountUpdate({
    environment: "production",
    accountFingerprint: "account",
    event: {
      e: "ACCOUNT_UPDATE",
      T: now,
      a: {
        m: "ORDER",
        P: [
          { s: "BTCUSDT", ps: "LONG", pa: "0.02", ep: "50000", up: "2", mt: "cross" },
          { s: "BTCUSDT", ps: "SHORT", pa: "-0.01", ep: "50100", up: "1", mt: "isolated" },
        ],
      },
    },
  });
  assert.equal(opened.positionsUpdated, true);
  assert.equal(opened.positionsComplete, true);
  assert.equal(opened.positions.length, 2);
  assert.deepEqual(opened.positions.map((row) => row.side), ["LONG", "SHORT"]);
  assert.equal(opened.updatedAt, incomeUpdatedAt);

  now += 1_000;
  const reduced = service.ingestFuturesAccountUpdate({
    environment: "production",
    accountFingerprint: "account",
    event: {
      e: "ACCOUNT_UPDATE",
      T: now,
      a: {
        m: "ORDER",
        P: [{ s: "BTCUSDT", ps: "LONG", pa: "0.005", ep: "50000", up: "0.5" }],
      },
    },
  });
  assert.equal(
    reduced.positions.find((row) => row.positionSide === "LONG").positionAmount,
    "0.005"
  );

  now += 1_000;
  const closed = service.ingestFuturesAccountUpdate({
    environment: "production",
    accountFingerprint: "account",
    event: {
      e: "ACCOUNT_UPDATE",
      T: now,
      a: {
        m: "ORDER",
        P: [{ s: "BTCUSDT", ps: "LONG", pa: "0", ep: "0", up: "0" }],
      },
    },
  });
  assert.equal(closed.positions.length, 1);
  assert.equal(closed.positions[0].positionSide, "SHORT");
});

test("资金费收益更新不会冒充新的持仓快照时间", async () => {
  let now = 900_000_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const initial = await service.refresh({
    client: futuresClient(),
    environment: "production",
    accountFingerprint: "account",
  });
  const positionsUpdatedAt = initial.positionsUpdatedAt;

  now += 5_000;
  const update = service.ingestFuturesAccountUpdate({
    environment: "production",
    accountFingerprint: "account",
    event: {
      e: "ACCOUNT_UPDATE",
      T: now,
      a: {
        m: "FUNDING_FEE",
        B: [{ a: "USDT", bc: "-0.1" }],
      },
    },
  });

  assert.equal(update.fundingFee24h, "-0.1");
  assert.equal(update.positionsUpdatedAt, positionsUpdatedAt);
  assert.equal(
    service.getFuturesPositionSnapshot("production:account").positionsUpdatedAt,
    positionsUpdatedAt
  );
});

test("无效 ACCOUNT_UPDATE 持仓不清空旧仓且将完整性降级", async () => {
  let now = 1_000_000_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  await service.refresh({
    client: futuresClient({
      accountStatus: async () => futuresAccount({
        positions: [{ symbol: "BTCUSDT", positionAmt: "1" }],
      }),
    }),
    environment: "production",
    accountFingerprint: "account",
  });
  now += 1_000;
  const result = service.ingestFuturesAccountUpdate({
    environment: "production",
    accountFingerprint: "account",
    event: {
      e: "ACCOUNT_UPDATE",
      T: now,
      a: { m: "ORDER", P: [{ s: "BTCUSDT", pa: "bad" }] },
    },
  });

  assert.equal(result.positions.length, 1);
  assert.equal(result.positionsComplete, false);
  assert.match(result.positionError.message, /positionAmt/);
});

test("收益历史已含查询期间成交时不会与 WebSocket 增量重复计算", async () => {
  const now = 1_100_000_000;
  let resolveIncomeHistory;
  const history = new Promise((resolve) => {
    resolveIncomeHistory = resolve;
  });
  const service = new BinanceAccountMetricsService({ now: () => now });
  const refresh = service.refresh({
    client: futuresClient({ incomeHistory: () => history }),
    environment: "production",
    accountFingerprint: "account",
  });
  service.ingestFuturesExecution({
    environment: "production",
    accountFingerprint: "account",
    event: {
      e: "executionReport",
      x: "TRADE",
      s: "BTCUSDT",
      i: 1,
      t: 99,
      T: now,
      rp: "3",
      n: "0.2",
      N: "USDT",
      ma: "USDT",
    },
  });
  resolveIncomeHistory([
    { incomeType: "REALIZED_PNL", income: "3", asset: "USDT", symbol: "BTCUSDT", tradeId: 99, time: now },
    { incomeType: "COMMISSION", income: "-0.2", asset: "USDT", symbol: "BTCUSDT", tradeId: 99, time: now },
  ]);
  const result = await refresh;

  assert.equal(result.closeProfit, "3");
  assert.equal(result.commission, "0.2");
  assert.equal(result.realProfit, "2.8");
});

test("收益历史暂未出现查询前已收到的成交时保留 WebSocket 增量", async () => {
  let now = 1_200_000_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  service.ingestFuturesExecution({
    environment: "production",
    accountFingerprint: "account",
    event: {
      e: "executionReport",
      x: "TRADE",
      s: "BTCUSDT",
      i: 2,
      t: 100,
      T: now,
      rp: "4",
      n: "0.25",
      N: "USDT",
      ma: "USDT",
    },
  });
  now += 100;
  const result = await service.refresh({
    client: futuresClient({ incomeHistory: async () => [] }),
    environment: "production",
    accountFingerprint: "account",
  });

  assert.equal(result.closeProfit, "4");
  assert.equal(result.commission, "0.25");
  assert.equal(result.realProfit, "3.75");
});

test("收益历史失败使用退避而不是每两秒重复请求", async () => {
  let now = 1_300_000_000;
  let calls = 0;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const client = futuresClient({
    incomeHistory: async () => {
      calls += 1;
      throw new Error("income unavailable");
    },
  });
  const first = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });
  now += 2_000;
  const second = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });

  assert.equal(calls, 1);
  assert.equal(first.complete, false);
  assert.equal(second.complete, false);
  assert.match(second.warnings[0].message, /income unavailable/);
});

test("已有成功收益快照过期后查询失败也会进入退避", async () => {
  let now = 1_350_000_000;
  let calls = 0;
  let shouldFail = false;
  const service = new BinanceAccountMetricsService({ now: () => now });
  const client = futuresClient({
    incomeHistory: async () => {
      calls += 1;
      if (shouldFail) throw new Error("income temporarily unavailable");
      return [{ incomeType: "REALIZED_PNL", income: "4", asset: "USDT" }];
    },
  });
  await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });

  now += HISTORY_RECONCILE_INTERVAL_MS;
  shouldFail = true;
  const failed = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });
  now += 2_000;
  const backedOff = await service.refresh({
    client,
    environment: "production",
    accountFingerprint: "account",
  });

  assert.equal(calls, 2);
  assert.equal(failed.realProfit, "4");
  assert.equal(backedOff.realProfit, "4");
  assert.equal(failed.complete, false);
  assert.equal(backedOff.complete, false);
});

test("非 USDT 收益会明确标记指标不完整", async () => {
  const service = new BinanceAccountMetricsService({ now: () => 1_400_000_000 });
  const result = await service.refresh({
    client: futuresClient({
      incomeHistory: async () => [{
        incomeType: "COMMISSION",
        income: "-0.001",
        asset: "BNB",
      }],
    }),
    environment: "production",
    accountFingerprint: "account",
  });
  assert.equal(result.complete, false);
  assert.equal(result.realProfit, "0");
  assert.equal(result.warnings.some((warning) => /BNB/.test(warning.message)), true);
});

test("SPECIAL_FUNDING_FEE 纳入资金费和实际盈亏", () => {
  const summary = summarizeFuturesIncome([{
    incomeType: "SPECIAL_FUNDING_FEE",
    income: "-0.3",
    asset: "USDT",
  }]);
  assert.equal(summary.fundingFee24h, "-0.3");
  assert.equal(summary.actualPnl24h, "-0.3");
});

test("缺少 U 本位凭证时拒绝生成账户指标", async () => {
  const service = new BinanceAccountMetricsService();
  await assert.rejects(service.refresh({
    client: { futures: { apiKey: "", apiSecret: "" } },
    environment: "production",
    accountFingerprint: "account",
  }), /未配置 U 本位凭证/);
});
