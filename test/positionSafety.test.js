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

test("U 本位连续两份不同的完整快照才确认空仓", () => {
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
  assert.match(second.message, /U 本位永续无持仓/);
});

test("U 本位查询失败或未配置时不能确认空仓", () => {
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
  unconfigured.sources.futures = { configured: false, ok: false };
  const missing = evaluatePositionSafety(unconfigured, { now: 10_100 });
  assert.equal(missing.level, "unknown");
  assert.match(missing.message, /U 本位凭证未配置/);
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

test("已查到 U 本位持仓时即使本次查询失败也优先显示危险状态", () => {
  const snapshot = {
    positions: [{ marketType: "futures", symbol: "BTCUSDT" }],
    complete: false,
    updatedAt: 10_000,
    sources: {
      futures: { configured: true, ok: false },
    },
  };
  const safety = evaluatePositionSafety(snapshot, { now: 10_100 });
  assert.equal(safety.level, "danger");
  assert.equal(safety.positions.length, 1);
  assert.match(safety.message, /列表可能还不完整/);
});

test("U 本位查询失败时保留上次成功查到的持仓", () => {
  const previous = {
    environment: "production",
    accountName: "account-a",
    positions: [{ marketType: "futures", symbol: "BTCUSDT" }],
    complete: true,
    sources: {
      futures: { configured: true, ok: true },
    },
  };
  const partial = {
    environment: "production",
    accountName: "account-a",
    positions: [],
    complete: false,
    sources: {
      futures: { configured: true, ok: false },
    },
  };
  const merged = mergePositionSnapshots(previous, partial);

  assert.deepEqual(merged.positions, [{
    marketType: "futures",
    symbol: "BTCUSDT",
    _positionSnapshotStale: true,
  }]);
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

test("同名账号但 API Key 指纹不同，不沿用旧账号持仓", () => {
  const previous = {
    environment: "production",
    accountName: "duplicate-name",
    accountFingerprint: "fingerprint-a",
    positions: [{ marketType: "futures", symbol: "BTCUSDT" }],
  };
  const next = {
    environment: "production",
    accountName: "duplicate-name",
    accountFingerprint: "fingerprint-b",
    positions: [],
    complete: false,
  };

  assert.equal(mergePositionSnapshots(previous, next), next);
});

test("构建安全快照优先使用独立的持仓更新时间", () => {
  const snapshot = buildPositionSnapshot({
    environment: "production",
    accountFingerprint: "fingerprint-a",
    updatedAt: 20_000,
    positionsUpdatedAt: 10_000,
    positionsComplete: true,
    positions: [],
    positionSources: {
      futures: { configured: true, ok: true, updatedAt: 10_000 },
    },
  });

  assert.equal(snapshot.updatedAt, 10_000);
  assert.equal(snapshot.positionsUpdatedAt, 10_000);
  assert.equal(snapshot.accountFingerprint, "fingerprint-a");
});

test("构建安全快照时只接收 U 本位持仓和数据源", () => {
  const metrics = {
    environment: "production",
    updatedAt: 10_000,
    positionsComplete: true,
    positions: [
      { marketType: "futures", symbol: "BTCUSDT" },
      { marketType: "legacy", symbol: "IGNORED" },
    ],
    positionSources: {
      futures: { configured: true, ok: true, updatedAt: 10_000 },
      legacy: { configured: true, ok: true, updatedAt: 10_000 },
    },
  };
  const snapshot = buildPositionSnapshot(metrics);

  assert.deepEqual(snapshot.positions, [
    { marketType: "futures", symbol: "BTCUSDT" },
  ]);
  assert.deepEqual(Object.keys(snapshot.sources), ["futures"]);
});
