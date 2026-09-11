const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  VALID_SCALES,
  aggregateDepth,
  bucketPrice,
} = require("../src/depthAggregation");

test("单个价格映射沿用左开右闭边界", () => {
  assert.equal(bucketPrice("100.05", { scale: 5 }), "100.05");
  assert.equal(
    bucketPrice("100.050000000000000001", { scale: 5 }),
    "100.10"
  );
  assert.equal(bucketPrice("100.00", { scale: 5 }), "100.00");
});

test("单个价格可以精确映射到 0.05 桶宽", () => {
  assert.equal(bucketPrice("0.0001", { scale: 5 }), "0.05");
  assert.equal(bucketPrice("0.05", { scale: 5 }), "0.05");
  assert.equal(bucketPrice("0.0501", { scale: 5 }), "0.10");
});

test("五级缩放按左开右闭区间精确聚合", () => {
  const result = aggregateDepth({
    baseStep: "0.01",
    scale: 5,
    bids: [
      { price: "100.000000000000000001", quantity: "0.1" },
      { price: "100.049999999999999999", quantity: "0.2" },
      { price: "100.05", quantity: "0.4" },
      { price: "100.050000000000000001", quantity: "0.8" },
    ],
    asks: [],
  });

  assert.equal(result.bucketStep, "0.05");
  assert.deepEqual(result.bids, [
    { price: "100.10", quantity: "0.8" },
    { price: "100.05", quantity: "0.7" },
  ]);
});

test("买卖盘分别聚合，并保持买盘降序、卖盘升序", () => {
  const result = aggregateDepth({
    scale: 10,
    bids: [
      { price: "100.01", quantity: "1.25" },
      { price: "100.19", quantity: "3" },
      { price: "100.02", quantity: "2.75" },
    ],
    asks: [
      { price: "100.19", quantity: "0.1" },
      { price: "100.01", quantity: "0.2" },
      { price: "100.02", quantity: "0.3" },
    ],
  });

  assert.deepEqual(result.bids, [
    { price: "100.20", quantity: "3" },
    { price: "100.10", quantity: "4" },
  ]);
  assert.deepEqual(result.asks, [
    { price: "100.10", quantity: "0.5" },
    { price: "100.20", quantity: "0.1" },
  ]);
});

test("默认使用 0.01 基础步长和一级缩放", () => {
  const result = aggregateDepth({
    bids: [{ price: "100.101", quantity: "10" }],
    asks: [{ price: "100.109", quantity: "20" }],
  });

  assert.equal(result.baseStep, "0.01");
  assert.equal(result.scale, 1);
  assert.equal(result.bucketStep, "0.01");
  assert.deepEqual(result.bids, [{ price: "100.11", quantity: "10" }]);
  assert.deepEqual(result.asks, [{ price: "100.11", quantity: "20" }]);
});

test("十进制手数求和不产生 IEEE-754 浮点误差", () => {
  const result = aggregateDepth({
    bids: [
      { price: "1.001", quantity: "0.1" },
      { price: "1.002", quantity: "0.2" },
      { price: "1.003", quantity: "0.000000000000000001" },
    ],
  });

  assert.deepEqual(result.bids, [{
    price: "1.01",
    quantity: "0.300000000000000001",
  }]);
});

test("基础步长支持不同价格精度并保留其展示位数", () => {
  const result = aggregateDepth({
    baseStep: "0.001",
    scale: 5,
    asks: [
      { price: "0.010", quantity: "1" },
      { price: "0.0101", quantity: "2" },
    ],
  });

  assert.equal(result.bucketStep, "0.005");
  assert.deepEqual(result.asks, [
    { price: "0.010", quantity: "1" },
    { price: "0.015", quantity: "2" },
  ]);
});

test("仅接受 1、5、10 三级缩放并校验行情数据", () => {
  assert.deepEqual(VALID_SCALES, [1, 5, 10]);
  assert.throws(() => aggregateDepth({ scale: 2 }), /只能是 1、5 或 10/);
  assert.throws(() => aggregateDepth({ baseStep: "0" }), /必须大于 0/);
  assert.throws(
    () => aggregateDepth({ bids: [{ price: "100", quantity: "-1" }] }),
    /不能小于 0/
  );
});

test("模块可在无 CommonJS 的浏览器环境暴露纯函数 API", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "depthAggregation.js"),
    "utf8"
  );
  const browserWindow = {};
  const context = vm.createContext({ window: browserWindow });
  vm.runInContext(source, context);

  assert.equal(typeof browserWindow.DepthAggregation.aggregateDepth, "function");
  const result = browserWindow.DepthAggregation.aggregateDepth({
    scale: "5",
    asks: [
      { price: "100.01", quantity: "0.1" },
      { price: "100.02", quantity: "0.2" },
    ],
  });
  assert.equal(JSON.stringify(result.asks), JSON.stringify([
    { price: "100.05", quantity: "0.3" },
  ]));
});
