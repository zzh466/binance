const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildPositionSnapshot,
  evaluatePositionSafety,
  mergePositionSnapshots,
} = require("../src/positionSafety");

function completeFlatSnapshot(updatedAt) {
  return {
    positions: [],
    complete: true,
    updatedAt,
    sources: {
      spot: { configured: true, ok: true, updatedAt },
      futures: { configured: true, ok: true, updatedAt },
    },
  };
}

test("没有账户指标时绝不把空列表标记成已确认空仓", () => {
  const snapshot = buildPositionSnapshot(null, { environment: "testnet" });
  const safety = evaluatePositionSafety(snapshot, { now: 10_000 });

  assert.equal(snapshot.complete, false);
  assert.equal(safety.level, "unknown");
  assert.equal(safety.flatConfirmed, false);
  assert.match(safety.emptyMessage, /不能据此判断空仓/);
});

test("现货和 U 本位连续两份不同的完整快照才确认空仓", () => {
  const first = evaluatePositionSafety(completeFlatSnapshot(10_000), {
    now: 10_100,
  });
  assert.equal(first.level, "checking");
  assert.equal(first.flatConfirmations, 1);

  const duplicate = evaluatePositionSafety(completeFlatSnapshot(10_000), {
    now: 10_200,
    previousFlatConfirmations: first.flatConfirmations,
    previousConfirmedAt: first.confirmedAt,
  });
  assert.equal(duplicate.level, "checking");
  assert.equal(duplicate.flatConfirmations, 1);

  const second = evaluatePositionSafety(completeFlatSnapshot(12_000), {
    now: 12_100,
    previousFlatConfirmations: duplicate.flatConfirmations,
    previousConfirmedAt: duplicate.confirmedAt,
  });
  assert.equal(second.level, "safe");
  assert.equal(second.flatConfirmed, true);
  assert.equal(second.flatConfirmations, 2);
});

test("任一市场查询失败或未配置时不能确认空仓", () => {
  const partial = completeFlatSnapshot(10_000);
  partial.complete = false;
  partial.sources.futures = {
    configured: true,
    ok: false,
    error: { message: "timeout" },
  };
  const failed = evaluatePositionSafety(partial, { now: 10_100 });
  assert.equal(failed.level, "unknown");
  assert.match(failed.message, /U 本位查询失败/);

  const unconfigured = completeFlatSnapshot(10_000);
  unconfigured.complete = false;
  unconfigured.sources.spot = { configured: false, ok: false };
  const missing = evaluatePositionSafety(unconfigured, { now: 10_100 });
  assert.equal(missing.level, "unknown");
  assert.match(missing.message, /现货凭证未配置/);
});

test("过期快照不能继续显示已确认空仓", () => {
  const safety = evaluatePositionSafety(completeFlatSnapshot(1_000), {
    now: 10_000,
    staleMs: 8_000,
    previousFlatConfirmations: 2,
    previousConfirmedAt: 1_000,
  });
  assert.equal(safety.level, "unknown");
  assert.equal(safety.flatConfirmed, false);
  assert.match(safety.message, /超过 8 秒未更新/);
});

test("仍有已知未成交订单时不能把零持仓显示成休息前安全状态", () => {
  const snapshot = {
    ...completeFlatSnapshot(10_000),
    knownOpenOrderCount: 3,
  };
  const safety = evaluatePositionSafety(snapshot, { now: 10_100 });
  assert.equal(safety.level, "danger");
  assert.equal(safety.flatConfirmed, false);
  assert.match(safety.message, /3 笔未成交订单/);
});

test("已查到持仓时即使另一个市场失败也优先显示危险状态", () => {
  const snapshot = {
    positions: [{ marketType: "futures", symbol: "BTCUSDT" }],
    complete: false,
    updatedAt: 10_000,
    sources: {
      spot: { configured: true, ok: false },
      futures: { configured: true, ok: true },
    },
  };
  const safety = evaluatePositionSafety(snapshot, { now: 10_100 });
  assert.equal(safety.level, "danger");
  assert.equal(safety.futuresCount, 1);
  assert.match(safety.message, /列表可能还不完整/);
});

test("部分市场失败时保留该市场上次成功查到的持仓", () => {
  const previous = {
    environment: "production",
    accountName: "account-a",
    positions: [
      { marketType: "spot", symbol: "ETHUSDT" },
      { marketType: "futures", symbol: "BTCUSDT" },
    ],
    complete: true,
    sources: {
      spot: { configured: true, ok: true },
      futures: { configured: true, ok: true },
    },
  };
  const partial = {
    environment: "production",
    accountName: "account-a",
    positions: [{ marketType: "spot", symbol: "BNBUSDT" }],
    complete: false,
    sources: {
      spot: { configured: true, ok: true },
      futures: { configured: true, ok: false },
    },
  };
  const merged = mergePositionSnapshots(previous, partial);

  assert.deepEqual(merged.positions.map((row) => [
    row.marketType,
    row.symbol,
    row._positionSnapshotStale,
  ]), [
    ["futures", "BTCUSDT", true],
    ["spot", "BNBUSDT", false],
  ]);
});

test("环境或账号切换后绝不沿用旧账户的持仓", () => {
  const previous = {
    environment: "production",
    accountName: "account-a",
    positions: [{ marketType: "futures", symbol: "BTCUSDT" }],
  };
  const next = {
    environment: "testnet",
    accountName: "account-a",
    positions: [],
    complete: false,
  };
  assert.equal(mergePositionSnapshots(previous, next), next);
});
