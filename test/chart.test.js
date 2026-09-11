const test = require("node:test");
const assert = require("node:assert/strict");
const { Chart } = require("../src/chart");

test("行情图模块导出稳定的绘图区边界", () => {
  assert.equal(Chart.PLOT_LEFT, 100);
  assert.equal(Chart.PLOT_TOP, 80);
  assert.equal(Chart.PLOT_BOTTOM_PADDING, 10);
});

test("行情图成交量高度计算保持原有分段规则", () => {
  assert.equal(Chart.getHeight([10, 20, 30], 0, 25), 0);
  assert.equal(Chart.getHeight([10, 20, 30], 5, 25), 12.5);
  assert.equal(Chart.getHeight([10, 20, 30], 20, 25), 50.5);
  assert.equal(Chart.getHeight([10, 20, 30], 31, 25), 105);
});

test("行情图可以切换缩放步长并重置旧坐标数据", () => {
  const chart = Object.create(Chart.prototype);
  let resetCount = 0;
  chart.step = 0.01;
  chart.decimal = 2;
  chart.reset = () => {
    resetCount += 1;
  };

  assert.equal(chart.setStep("0.05"), 0.05);
  assert.equal(chart.step, 0.05);
  assert.equal(chart.decimal, 2);
  assert.equal(resetCount, 1);
  assert.throws(() => chart.setStep(0), /必须是大于 0 的数字/);
  assert.equal(resetCount, 1);
});

test("聚合后买卖盘落在同一价格桶时两侧手数都能绘制", () => {
  const fillRects = [];
  const chart = Object.create(Chart.prototype);
  chart.ctx = {
    beginPath() {},
    fillRect(...args) {
      fillRects.push(args);
    },
    fillText() {},
    restore() {},
    save() {},
    stroke() {},
  };
  chart.start = 0;
  chart.count = 0;
  chart.buyIndex = 0;
  chart.askIndex = 0;
  chart.barWidth = 13;
  chart.depthRenderId = 7;
  chart.data = [{
    price: "100.05",
    volum: "3",
    type: "ask",
    buyDepthVolume: "2",
    buyDepthRenderId: 7,
    askDepthVolume: "3",
    askDepthRenderId: 7,
  }];
  chart.range = [10, 20, 30];
  chart.volumeScaleHeight = 25;
  chart.volumeXOffset = 2;
  chart.volumeYOffset = 0;
  chart.setColor(false);

  chart.renderVolume();

  assert.equal(fillRects.length, 2);
  assert.equal(fillRects[0][2] + fillRects[1][2], 12);
  assert.equal(fillRects[1][0], fillRects[0][0] + fillRects[0][2]);
});

test("下一帧聚合档位减少后不会继续绘制上一帧深度", () => {
  const fillRects = [];
  const chart = Object.create(Chart.prototype);
  chart.ctx = {
    beginPath() {},
    fillRect(...args) {
      fillRects.push(args);
    },
    fillText() {},
    restore() {},
    save() {},
    stroke() {},
  };
  chart.start = 0;
  chart.count = 0;
  chart.buyIndex = 0;
  chart.askIndex = 1;
  chart.barWidth = 13;
  chart.depthRenderId = 8;
  chart.data = [{
    price: "100.00",
    volum: "2",
    type: "buy",
    buyDepthVolume: "2",
    buyDepthRenderId: 7,
  }];
  chart.range = [10, 20, 30];
  chart.volumeScaleHeight = 25;
  chart.volumeXOffset = 2;
  chart.volumeYOffset = 0;
  chart.setColor(false);

  chart.renderVolume();

  assert.deepEqual(fillRects, []);
});

test("同一聚合桶内的双向自有挂单不会互相覆盖", () => {
  const fillRects = [];
  const chart = Object.create(Chart.prototype);
  chart.ctx = {
    fillRect(...args) {
      fillRects.push(args);
    },
    restore() {},
    save() {},
  };
  chart.data = [{ price: "100.05" }];
  chart.start = 0;
  chart.count = 0;
  chart.step = 0.05;
  chart.barWidth = 13;
  chart.range = [10, 20, 30];
  chart.volumeScaleHeight = 25;
  chart.placeOrder = [
    {
      price: "100.05",
      origQty: "2",
      executedQty: "0",
      status: "NEW",
      side: "BUY",
    },
    {
      price: "100.05",
      origQty: "3",
      executedQty: "0",
      status: "NEW",
      side: "SELL",
    },
  ];
  chart.setColor(false);

  chart.renderPlaceOrder();

  assert.equal(fillRects.length, 2);
  assert.equal(fillRects[0][2] + fillRects[1][2], 12);
  assert.equal(chart.visiblePlaceOrderCount, 1);
  assert.equal(chart.totalPlaceOrderCount, 1);
  assert.deepEqual(chart.holdVolume, [2, 3]);
});
