const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createLatestUpdateCoalescer,
} = require("../src/latestUpdateCoalescer");

test("高频成交更新在一个 IPC 周期内只发送最新一笔", () => {
  const callbacks = [];
  const sent = [];
  const coalescer = createLatestUpdateCoalescer({
    intervalMs: 32,
    send: (value) => sent.push(value),
    schedule: (callback) => {
      callbacks.push(callback);
      return { unref() {} };
    },
    cancel() {},
  });

  coalescer.push({ tradeId: 1, price: "100" });
  coalescer.push({ tradeId: 2, price: "101" });
  coalescer.push({ tradeId: 3, price: "102" });

  assert.equal(callbacks.length, 1);
  assert.deepEqual(sent, []);
  callbacks[0]();
  assert.deepEqual(sent, [{ tradeId: 3, price: "102" }]);
  coalescer.close();
});
