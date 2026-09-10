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
