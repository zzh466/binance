const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BinanceAccountMetricsService,
  buildFuturesPositionRows,
} = require("../src/binanceAccountMetricsService");
const { BinanceUsdMClient } = require("../src/binance/binanceUsdMClient");
const {
  buildPositionSnapshot,
  evaluatePositionSafety,
} = require("../src/positionSafety");

function account(overrides = {}) {
  return {
    totalWalletBalance: "100",
    totalMarginBalance: "101",
    availableBalance: "80",
    totalUnrealizedProfit: "1",
    totalInitialMargin: "20",
    positions: [],
    ...overrides,
  };
}

function client({ accountStatus, positionRisk, incomeHistory } = {}) {
  const futures = {
    apiKey: "futures-key",
    apiSecret: "futures-secret",
    accountStatus: accountStatus || (async () => account()),
    incomeHistory: incomeHistory || (async () => []),
  };
  if (positionRisk) futures.positionRisk = positionRisk;
  return { futures };
}

test("连续收到缺失、非数组或非法持仓数据时绝不能确认空仓", async () => {
  const malformedResponses = [
    {},
    { positions: {} },
    [{ symbol: "BTCUSDT", positionAmt: "invalid" }],
  ];

  for (const response of malformedResponses) {
    let now = 10_000;
    const service = new BinanceAccountMetricsService({ now: () => now });
    const targetClient = Array.isArray(response)
      ? client({ positionRisk: async () => response })
      : client({ accountStatus: async () => response });
    let confirmations = 0;
    let confirmedAt = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const metrics = await service.refreshPositions({
        client: targetClient,
        environment: "production",
        accountFingerprint: "account-a",
      });
      assert.equal(metrics.positionsComplete, false);
      assert.equal(metrics.positionSources.futures.ok, false);

      const safety = evaluatePositionSafety(buildPositionSnapshot(metrics), {
        now,
        previousFlatConfirmations: confirmations,
        previousConfirmedAt: confirmedAt,
      });
      assert.equal(safety.flatConfirmed, false);
      assert.equal(safety.level, "unknown");
      confirmations = safety.flatConfirmations;
      confirmedAt = safety.confirmedAt;
      now += 2_000;
    }
  }
});

test("positionRisk 的 unRealizedProfit 和 marginType 格式能映射到持仓行", async () => {
  const futures = new BinanceUsdMClient({
    apiKey: "futures-key",
    apiSecret: "futures-secret",
  });
  futures.signedWsOrRest = async () => [{
    symbol: "MUUSDT",
    positionSide: "SHORT",
    positionAmt: "-3.5",
    entryPrice: "12.34",
    markPrice: "12.30",
    unRealizedProfit: "1.25",
    marginType: "isolated",
    initialMargin: "4.305",
    updateTime: 20_000,
  }];

  const rows = buildFuturesPositionRows(
    await futures.positionRisk(),
    21_000
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "MUUSDT");
  assert.equal(rows[0].side, "SHORT");
  assert.equal(rows[0].positionAmount, "3.5");
  assert.equal(rows[0].unrealizedPnl, "1.25");
  assert.equal(rows[0].marginMode, "逐仓");
  assert.equal(rows[0].lockedAmount, "4.305");
  futures.close();
});

test("ACCOUNT_UPDATE 能即时完成开仓、增仓、减仓和归零", async () => {
  let now = 30_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  await service.refreshPositions({
    client: client({ positionRisk: async () => [] }),
    environment: "production",
    accountFingerprint: "account-a",
  });

  const updatePosition = (amount) => {
    now += 1_000;
    return service.ingestFuturesAccountUpdate({
      environment: "production",
      accountFingerprint: "account-a",
      event: {
        e: "ACCOUNT_UPDATE",
        E: now,
        T: now,
        a: {
          m: "ORDER",
          P: [{
            s: "BTCUSDT",
            ps: "BOTH",
            pa: amount,
            ep: amount === "0" ? "0" : "50000",
            up: "0.5",
            mt: "cross",
          }],
        },
      },
    });
  };

  const opened = updatePosition("0.01");
  assert.equal(opened.positions[0].positionAmount, "0.01");
  const openedAt = opened.positionsUpdatedAt;

  const increased = updatePosition("0.03");
  assert.equal(increased.positions[0].positionAmount, "0.03");
  assert.ok(increased.positionsUpdatedAt > openedAt);

  const reduced = updatePosition("0.005");
  assert.equal(reduced.positions[0].positionAmount, "0.005");

  const closed = updatePosition("0");
  assert.deepEqual(closed.positions, []);
  assert.equal(closed.positionsComplete, true);
});

test("成交收益和资金费即时更新，但不得刷新持仓快照时间", async () => {
  let now = 50_000;
  const service = new BinanceAccountMetricsService({ now: () => now });
  await service.refresh({
    client: client({
      positionRisk: async () => [{
        symbol: "ETHUSDT",
        positionSide: "BOTH",
        positionAmt: "0.1",
      }],
    }),
    environment: "production",
    accountFingerprint: "account-a",
  });
  const scopeKey = "production:account-a";
  const initialPositionTime = service.getFuturesPositionSnapshot(
    scopeKey
  ).positionsUpdatedAt;

  now += 1_000;
  const tradeIncome = service.ingestFuturesExecution({
    environment: "production",
    accountFingerprint: "account-a",
    event: {
      e: "executionReport",
      x: "TRADE",
      s: "ETHUSDT",
      i: 7,
      t: 8,
      T: now,
      rp: "2",
      n: "0.2",
      N: "USDT",
      ma: "USDT",
    },
  });
  assert.equal(tradeIncome.actualPnl24h, "1.8");
  assert.equal(
    service.getFuturesPositionSnapshot(scopeKey).positionsUpdatedAt,
    initialPositionTime
  );

  now += 1_000;
  const fundingIncome = service.ingestFuturesAccountUpdate({
    environment: "production",
    accountFingerprint: "account-a",
    event: {
      e: "ACCOUNT_UPDATE",
      E: now,
      T: now,
      a: {
        m: "FUNDING_FEE",
        B: [{ a: "USDT", bc: "-0.3" }],
      },
    },
  });
  assert.equal(fundingIncome.actualPnl24h, "1.5");
  assert.equal(
    service.getFuturesPositionSnapshot(scopeKey).positionsUpdatedAt,
    initialPositionTime
  );
});

test("完整指标刷新被慢收益历史阻塞时，持仓查询仍可独立完成", async () => {
  let resolveIncomeHistory;
  const slowIncomeHistory = new Promise((resolve) => {
    resolveIncomeHistory = resolve;
  });
  let positionCalls = 0;
  const targetClient = client({
    incomeHistory: () => slowIncomeHistory,
    positionRisk: async () => {
      positionCalls += 1;
      return [{
        symbol: "BTCUSDT",
        positionSide: "BOTH",
        positionAmt: "0.02",
      }];
    },
  });
  const service = new BinanceAccountMetricsService({ now: () => 70_000 });
  const fullRefresh = service.refresh({
    client: targetClient,
    environment: "production",
    accountFingerprint: "account-a",
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    const positions = await service.refreshPositions({
      client: targetClient,
      environment: "production",
      accountFingerprint: "account-a",
    });

    assert.equal(positions.positionsComplete, true);
    assert.equal(positions.positions[0].symbol, "BTCUSDT");
    assert.ok(positionCalls >= 2);
  } finally {
    resolveIncomeHistory([]);
  }
  await fullRefresh;
});
