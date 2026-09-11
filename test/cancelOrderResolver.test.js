const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resolveCancelOrderRequest,
} = require("../src/cancelOrderResolver");

test("撤单按订单 ID 恢复真实合约和市场，不依赖页面当前合约", () => {
  const resolved = resolveCancelOrderRequest({
    symbol: "MUUSDT",
    orderId: "7832106256",
  }, [{
    symbol: "SNDKUSDT",
    marketType: "futures",
    orderId: 7832106256,
    status: "NEW",
    algoOrder: false,
  }]);

  assert.deepEqual(resolved, {
    symbol: "SNDKUSDT",
    orderId: "7832106256",
    marketType: "futures",
    algoOrder: false,
  });
});

test("ACK 已返回但 NEW 事件尚未到达时允许立即撤单", () => {
  const resolved = resolveCancelOrderRequest({
    symbol: "MUUSDT",
    orderId: "11",
  }, [{
    symbol: "MUUSDT",
    marketType: "futures",
    orderId: 11,
    status: "ACKNOWLEDGED",
    algoOrder: false,
  }]);

  assert.equal(resolved.symbol, "MUUSDT");
  assert.equal(resolved.marketType, "futures");
  assert.equal(resolved.algoOrder, false);
});

test("已经结束的已知订单会在本地阻止重复撤单", () => {
  assert.throws(
    () => resolveCancelOrderRequest({
      symbol: "BTCUSDT",
      orderId: "8",
    }, [{
      symbol: "BTCUSDT",
      marketType: "futures",
      orderId: 8,
      status: "FILLED",
    }]),
    /当前状态为 FILLED，已不是可撤销挂单/
  );
});

test("订单 ID 在多个合约都有未成交订单时拒绝猜测", () => {
  const orders = ["BTCUSDT", "ETHUSDT"].map((symbol) => ({
    symbol,
    marketType: "futures",
    orderId: 9,
    status: "NEW",
  }));
  assert.throws(
    () => resolveCancelOrderRequest({ symbol: "BNBUSDT", orderId: "9" }, orders),
    /匹配到多个未成交订单/
  );
});

test("本地没有记录的手工撤单仍沿用用户输入", () => {
  assert.deepEqual(
    resolveCancelOrderRequest({ symbol: "btcusdt", orderId: "10" }, []),
    { symbol: "BTCUSDT", orderId: "10", marketType: "futures" }
  );
});
