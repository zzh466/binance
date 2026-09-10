const assert = require("node:assert/strict");
const test = require("node:test");
const {
  collectCancelAllOrderTargets,
  orderMatchesTarget,
} = require("../src/cancelAllOrderTargets");

test("远端挂单查询为空时使用刚返回 ACK 的本地订单确定撤单目标", () => {
  const now = 1_000_000;
  const result = collectCancelAllOrderTargets({
    remoteOrders: [],
    recentOrders: [{
      marketType: "futures",
      symbol: "MUUSDT",
      orderId: 123,
      status: "ACKNOWLEDGED",
      observedAt: now - 100,
    }],
    now,
  });

  assert.deepEqual(result.targets, [{
    marketType: "futures",
    symbol: "MUUSDT",
  }]);
  assert.equal(result.orders.length, 1);
});

test("过期 ACK 和最终状态不会产生撤单目标", () => {
  const now = 1_000_000;
  const result = collectCancelAllOrderTargets({
    recentOrders: [
      { symbol: "BTCUSDT", status: "ACKNOWLEDGED", observedAt: 1 },
      { symbol: "ETHUSDT", status: "FILLED", observedAt: now },
      { symbol: "BNBUSDT", status: "CANCELED", observedAt: now },
    ],
    now,
    ackMaxAgeMs: 1_000,
  });

  assert.deepEqual(result.targets, []);
});

test("远端、本地实时和最近订单按市场与交易对合并去重", () => {
  const shared = {
    marketType: "spot",
    symbol: "BTCUSDT",
    orderId: 8,
    status: "NEW",
  };
  const result = collectCancelAllOrderTargets({
    remoteOrders: [shared],
    trackedOrders: [shared],
    recentOrders: [shared, {
      marketType: "futures",
      symbol: "BTCUSDT",
      orderId: 9,
      status: "PARTIALLY_FILLED",
    }],
  });

  assert.deepEqual(result.targets, [
    { marketType: "spot", symbol: "BTCUSDT" },
    { marketType: "futures", symbol: "BTCUSDT" },
  ]);
  assert.equal(result.orders.length, 2);
  assert.equal(orderMatchesTarget(result.orders[0], result.targets[0]), true);
  assert.equal(orderMatchesTarget(result.orders[0], result.targets[1]), false);
});
