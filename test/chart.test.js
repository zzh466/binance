const test = require("node:test");
const assert = require("node:assert/strict");
const { Chart } = require("../src/chart");

function createChartContext() {
  return {
    globalAlpha: 1,
    fillRects: [],
    beginPath() {},
    clearRect() {},
    fillRect(...args) {
      this.fillRects.push({
        alpha: this.globalAlpha,
        fillStyle: this.fillStyle,
        args,
      });
    },
    fillText() {},
    lineTo() {},
    moveTo() {},
    restore() {},
    save() {},
    setLineDash() {},
    stroke() {},
  };
}

function createChart(config = {}) {
  const ctx = createChartContext();
  const chart = new Chart(
    { getContext: () => ctx },
    410,
    300,
    1,
    {
      barToBorder: 2,
      barWidth: 13,
      volumeScaleCount: 3,
      volumeScaleHeight: 25,
      volumeScaleTick: 10,
      volumeScaleType: 2,
      ...config,
    }
  );
  return { chart, ctx };
}

function createDepthSnapshot(bids, asks) {
  const depthLevels = Math.max(bids.length, asks.length, 1);
  const snapshot = {
    LastPrice: 100,
    DepthLevels: depthLevels,
    LowerLimitPrice: 90,
    UpperLimitPrice: 110,
  };
  bids.forEach((level, index) => {
    if (!level) return;
    snapshot[`BidPrice${index + 1}`] = level[0];
    snapshot[`BidVolume${index + 1}`] = level[1];
  });
  asks.forEach((level, index) => {
    if (!level) return;
    snapshot[`AskPrice${index + 1}`] = level[0];
    snapshot[`AskVolume${index + 1}`] = level[1];
  });
  return snapshot;
}

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

test("深度保留默认使用快照模式且历史配置会被安全归一化", () => {
  const { chart: snapshotChart } = createChart();
  const { chart: historyChart } = createChart({
    depthRetentionMode: "history",
    historicalDepthOpacity: 2,
    maxHistoricalDepthEntries: 3.8,
  });

  assert.equal(snapshotChart.depthRetentionMode, "snapshot");
  assert.equal(snapshotChart.historicalDepthOpacity, 0.5);
  assert.equal(snapshotChart.maxHistoricalDepthEntries, 10000);
  assert.equal(historyChart.depthRetentionMode, "history");
  assert.equal(historyChart.historicalDepthOpacity, 1);
  assert.equal(historyChart.maxHistoricalDepthEntries, 3);
});

test("历史模式按买卖方向清理当前覆盖区间并保留区间外深度", () => {
  const { chart, ctx } = createChart({
    depthRetentionMode: "history",
    historicalDepthOpacity: 0.25,
  });
  chart.render(createDepthSnapshot(
    [[100, "10"], [99, "9"], [98, "8"], [97, "7"]],
    [[101, "11"], [102, "12"], [103, "13"], [104, "14"]]
  ));
  chart.render(createDepthSnapshot(
    [[100, "20"], null, [98, "18"]],
    [[101, "21"], null, [103, "23"]]
  ));

  assert.deepEqual(
    Array.from(chart.buyDepthHistory.keys()).map(Number).sort((a, b) => a - b),
    [97, 98, 100]
  );
  assert.deepEqual(
    Array.from(chart.askDepthHistory.keys()).map(Number).sort((a, b) => a - b),
    [101, 103, 104]
  );
  assert.equal(chart.buyDepthHistory.has("99"), false);
  assert.equal(chart.askDepthHistory.has("102"), false);

  ctx.fillRects.length = 0;
  ctx.globalAlpha = 0.8;
  chart.renderVolume();

  assert.equal(ctx.fillRects.length, 6);
  assert.equal(ctx.fillRects.filter((rect) => rect.alpha === 0.2).length, 2);
  assert.equal(ctx.fillRects.filter((rect) => rect.alpha === 0.8).length, 4);
  assert.equal(ctx.globalAlpha, 0.8);

  const retainedEntryCount =
    chart.buyDepthHistory.size + chart.askDepthHistory.size;
  chart.render(chart.args);
  assert.equal(
    chart.buyDepthHistory.size + chart.askDepthHistory.size,
    retainedEntryCount
  );
});

test("历史模式不会绘制已经越过当前盘口的旧方向深度", () => {
  const { chart, ctx } = createChart({ depthRetentionMode: "history" });
  chart.initData(100);
  chart.buyIndex = chart.getindex(100, true);
  chart.askIndex = chart.getindex(101, true);
  chart.depthRenderId = 2;
  chart.buyDepthHistory.set("102", {
    volume: "5",
    renderId: 1,
    sequence: 1,
  });
  chart.askDepthHistory.set("99", {
    volume: "6",
    renderId: 1,
    sequence: 2,
  });

  ctx.fillRects.length = 0;
  chart.renderVolume();

  assert.deepEqual(ctx.fillRects, []);
});

test("历史深度缓存按买卖合计限制容量且更新同价位不扩容", () => {
  const { chart } = createChart({
    depthRetentionMode: "history",
    maxHistoricalDepthEntries: 3,
  });
  chart.syncDepthHistory("buy", [
    { price: "98", volume: "1" },
    { price: "99", volume: "2" },
  ], 1);
  chart.syncDepthHistory("ask", [
    { price: "101", volume: "3" },
    { price: "102", volume: "4" },
  ], 1);
  chart.trimDepthHistory();

  assert.equal(chart.buyDepthHistory.size + chart.askDepthHistory.size, 3);
  assert.equal(chart.buyDepthHistory.has("98"), false);

  chart.syncDepthHistory("ask", [
    { price: "102", volume: "40" },
  ], 2);
  chart.trimDepthHistory();
  assert.equal(chart.buyDepthHistory.size + chart.askDepthHistory.size, 3);
  assert.equal(chart.askDepthHistory.get("102").volume, "40");
});

test("显式重置深度历史不改变价格坐标或现有 overlay", () => {
  const { chart } = createChart({ depthRetentionMode: "history" });
  chart.render(createDepthSnapshot(
    [[100, "10"], [99, "9"]],
    [[101, "11"], [102, "12"]]
  ));
  chart.placeOrder = [{ price: "100", side: "BUY" }];
  chart.traded = { price: "100", direction: "0", amount: "1" };
  const prices = chart.data.map((item) => item.price);

  chart.resetDepthHistory();

  assert.equal(chart.buyDepthHistory.size, 0);
  assert.equal(chart.askDepthHistory.size, 0);
  assert.equal(chart.depthRenderId, 0);
  assert.deepEqual(chart.data.map((item) => item.price), prices);
  assert.deepEqual(chart.placeOrder, [{ price: "100", side: "BUY" }]);
  assert.deepEqual(chart.traded, {
    price: "100",
    direction: "0",
    amount: "1",
  });
  assert.equal(
    chart.data.some((item) =>
      Object.hasOwn(item, "buyDepthVolume") ||
      Object.hasOwn(item, "askDepthVolume")
    ),
    false
  );

  chart.syncDepthHistory("buy", [{ price: "100", volume: "3" }], 1);
  chart.reset();
  assert.equal(chart.buyDepthHistory.size, 0);
  assert.equal(chart.askDepthHistory.size, 0);

  chart.syncDepthHistory("ask", [{ price: "101", volume: "4" }], 1);
  chart.setStep(0.5);
  assert.equal(chart.buyDepthHistory.size, 0);
  assert.equal(chart.askDepthHistory.size, 0);
});
