const assert = require("node:assert/strict");
const test = require("node:test");
const {
  openOrderKey,
  updateOpenOrderMap,
} = require("../src/openOrderState");

function order(overrides = {}) {
  return {
    marketType: "futures",
    symbol: "BTCUSDT",
    orderId: 987654,
    side: "BUY",
    type: "LIMIT",
    status: "NEW",
    price: "50000",
    origQty: "0.01",
    executedQty: "0",
    ...overrides,
  };
}

test("未成交订单 key 使用市场类型、交易对和订单 ID", () => {
  assert.equal(
    openOrderKey(order()),
    "futures:BTCUSDT:987654"
  );
});

test("新建和部分成交订单写入 Map，最终状态删除同一 key", () => {
  const orders = new Map();
  const created = updateOpenOrderMap(orders, order(), 100);
  assert.equal(created.updated, true);
  assert.equal(orders.size, 1);

  updateOpenOrderMap(orders, order({
    status: "PARTIALLY_FILLED",
    executedQty: "0.004",
  }), 200);
  assert.equal(orders.get(created.key).executedQty, "0.004");

  updateOpenOrderMap(orders, order({
    status: "FILLED",
    executedQty: "0.01",
  }), 300);
  assert.equal(orders.has(created.key), false);
});

test("相同订单 ID 在现货和 U 本位使用不同 key", () => {
  const orders = new Map();
  updateOpenOrderMap(orders, order({ marketType: "spot" }), 100);
  updateOpenOrderMap(orders, order({ marketType: "futures" }), 100);
  assert.deepEqual([...orders.keys()].sort(), [
    "futures:BTCUSDT:987654",
    "spot:BTCUSDT:987654",
  ]);
});

test("较旧的账户事件不会覆盖已经收到的新状态", () => {
  const orders = new Map();
  updateOpenOrderMap(orders, order({ status: "PARTIALLY_FILLED" }), 200);
  const stale = updateOpenOrderMap(orders, order({ status: "NEW" }), 100);
  assert.equal(stale.updated, false);
  assert.equal(stale.reason, "stale-update");
  assert.equal(
    orders.get("futures:BTCUSDT:987654").status,
    "PARTIALLY_FILLED"
  );
});
