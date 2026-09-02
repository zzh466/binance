const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  RecentOrderStore,
  recent24HourCutoff,
} = require("../src/recentOrderStore");

function createTemporaryStore(t, now) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-orders-"));
  const filePath = path.join(directory, "recent-orders.json");
  const store = new RecentOrderStore(filePath, {
    now: () => now,
    saveDelayMs: 60_000,
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, filePath };
}

test("现货和 U 本位订单使用同一个最近 24 小时状态库并按市场隔离", (t) => {
  const now = new Date(2026, 8, 2, 12, 0, 0).getTime();
  const { store } = createTemporaryStore(t, now);
  const common = {
    environment: "production",
    accountFingerprint: "account-1",
  };

  store.upsert({
    symbol: "BTCUSDT",
    orderId: 7,
    status: "FILLED",
    updateTime: now,
  }, { ...common, marketType: "spot", source: "user-data-stream" });
  store.upsert({
    s: "BTCUSDT",
    i: 7,
    X: "CANCELED",
    E: now,
  }, { ...common, marketType: "futures", source: "user-data-stream" });

  const orders = store.list({
    environment: "production",
    accountFingerprints: ["account-1"],
  });
  assert.equal(orders.length, 2);
  assert.deepEqual(
    orders.map((order) => [order.marketType, order.status, order.terminal]).sort(),
    [
      ["futures", "CANCELED", true],
      ["spot", "FILLED", true],
    ]
  );
});

test("订单状态按时间合并且 ACK 不会覆盖已经收到的最终状态", (t) => {
  const now = new Date(2026, 8, 2, 12, 0, 0).getTime();
  const { store } = createTemporaryStore(t, now);
  const context = {
    environment: "testnet",
    accountFingerprint: "account-2",
    marketType: "spot",
  };

  store.upsert({
    symbol: "ETHUSDT",
    orderId: 9,
    clientOrderId: "client-9",
    status: "FILLED",
    updateTime: now,
  }, context);
  store.upsert({
    symbol: "ETHUSDT",
    orderId: 9,
    clientOrderId: "client-9",
    transactTime: now,
  }, { ...context, defaultStatus: "ACKNOWLEDGED" });

  const [order] = store.list();
  assert.equal(order.status, "FILLED");
  assert.equal(order.terminal, true);
  assert.deepEqual(order.statusHistory.map(({ status }) => status), ["FILLED"]);
});

test("状态库只保留滚动的最近 24 小时并可以重新加载", (t) => {
  const now = new Date(2026, 8, 2, 12, 0, 0).getTime();
  const cutoff = recent24HourCutoff(now);
  const withinWindow = cutoff + 1;
  const older = cutoff - 1;
  const { store, filePath } = createTemporaryStore(t, now);
  const context = {
    environment: "production",
    accountFingerprint: "account-3",
    marketType: "futures",
  };

  assert.equal(store.upsert({
    symbol: "BNBUSDT",
    orderId: 1,
    status: "FILLED",
    updateTime: older,
  }, context), null);
  store.upsert({
    symbol: "BNBUSDT",
    orderId: 2,
    status: "CANCELED",
    updateTime: withinWindow,
  }, context);
  store.upsert({
    symbol: "BNBUSDT",
    orderId: 3,
    status: "REJECTED",
    updateTime: now,
  }, context);
  store.flush();

  const reloaded = new RecentOrderStore(filePath, {
    now: () => now,
    saveDelayMs: 60_000,
  });
  assert.deepEqual(
    reloaded.list().map(({ orderId }) => orderId),
    [3, 2]
  );
  reloaded.close();
});
