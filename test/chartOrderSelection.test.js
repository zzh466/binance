const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveChartOrderSelection,
} = require("../src/chartOrderSelection");

function selection(overrides = {}) {
  return resolveChartOrderSelection({
    clientX: 205,
    clientY: 140,
    bounds: { left: 100, top: 50, width: 980, height: 300 },
    canvasWidth: 980,
    canvasHeight: 300,
    plotLeft: 100,
    plotTop: 80,
    plotBottom: 290,
    barWidth: 13,
    count: 4,
    start: 10,
    buyIndex: 11,
    askIndex: 13,
    data: Array.from({ length: 20 }, (_, index) => ({ price: String(index) })),
    ...overrides,
  });
}

test("行情双击仅解析画布有效买卖档位", () => {
  assert.deepEqual(selection(), {
    side: "BUY",
    price: "10",
    dataIndex: 10,
    canvasX: 105,
    canvasY: 90,
    cssLeft: 100,
    cssBarWidth: 13,
  });
  assert.equal(selection({ clientX: 230 }), null, "买卖价差区域不应下单");
  assert.equal(selection({ clientX: 243 })?.side, "SELL");
});

test("行情双击拒绝画布外、价格柱区域外和无行情数据的坐标", () => {
  assert.equal(selection({ clientX: 99 }), null);
  assert.equal(selection({ clientY: 100 }), null);
  assert.equal(selection({ clientY: 350 }), null);
  assert.equal(selection({ clientX: 400 }), null);
  assert.equal(selection({ data: [] }), null);
});

test("行情坐标按画布缩放比例换算，兼容不同窗口宽度", () => {
  const result = selection({
    clientX: 152.5,
    clientY: 95,
    bounds: { left: 100, top: 50, width: 490, height: 150 },
  });

  assert.equal(result?.dataIndex, 10);
  assert.equal(result?.cssLeft, 50);
  assert.equal(result?.cssBarWidth, 6.5);
});
