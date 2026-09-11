const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ELEMENT_SELECTORS,
  collect,
} = require("../src/rendererElements");

test("页面元素选择器集中注册并保持关键控件名称", () => {
  assert.equal(ELEMENT_SELECTORS.environmentSwitch, "#environmentSwitch");
  assert.equal(ELEMENT_SELECTORS.depthLevelSelect, "#depthLevelSelect");
  assert.equal(
    ELEMENT_SELECTORS.depthLevelSwitchStatus,
    "#depthLevelSwitchStatus"
  );
  assert.equal(ELEMENT_SELECTORS.chartSymbolInput, "#chartSymbolInput");
  assert.equal(ELEMENT_SELECTORS.zoomDepthScale, "#zoomDepthScale");
  assert.equal(ELEMENT_SELECTORS.zoomChartStatus, "#zoomChartStatus");
  assert.equal(
    ELEMENT_SELECTORS.zoomChartLatestTradePrice,
    "#zoomChartLatestTradePrice"
  );
  assert.equal(ELEMENT_SELECTORS.zoomChartCanvas, "#zoomChartCanvas");
  assert.equal(ELEMENT_SELECTORS.zoomMousebar, "#zoomMousebar");
  assert.equal(ELEMENT_SELECTORS.quantity, "#quantity");
  assert.equal(ELEMENT_SELECTORS.activationPrice, "#activationPrice");
  assert.equal(ELEMENT_SELECTORS.callbackRate, "#callbackRate");
  assert.equal(ELEMENT_SELECTORS.output, "#output");
  assert.equal("ocoSide" in ELEMENT_SELECTORS, false);
  assert.equal("orderListsBody" in ELEMENT_SELECTORS, false);
  assert.equal("trailingDelta" in ELEMENT_SELECTORS, false);
  assert.equal("icebergQty" in ELEMENT_SELECTORS, false);
  assert.ok(Object.keys(ELEMENT_SELECTORS).length > 100);
});

test("顶部行情档位选择提供五、十、二十档并默认二十档", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "index.html"),
    "utf8"
  );
  const select = html.match(
    /<select[^>]+id=["']depthLevelSelect["'][^>]*>([\s\S]*?)<\/select>/
  )?.[1] || "";

  assert.match(select, /<option value="5">5档<\/option>/);
  assert.match(select, /<option value="10">10档<\/option>/);
  assert.match(select, /<option value="20" selected>20档<\/option>/);
});

test("缩放行情提供一、五、十级聚合并默认一级", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "index.html"),
    "utf8"
  );
  const select = html.match(
    /<select[^>]+id=["']zoomDepthScale["'][^>]*>([\s\S]*?)<\/select>/
  )?.[1] || "";

  assert.match(select, /<option value="1" selected>1级<\/option>/);
  assert.match(select, /<option value="5">5级<\/option>/);
  assert.match(select, /<option value="10">10级<\/option>/);
  assert.match(
    html,
    /<canvas[^>]*id="zoomChartCanvas"[^>]*width="980"[^>]*height="300"/
  );
  assert.match(html, /id="zoomChartReadonlyNote"[^>]*>[\s\S]*?不支持鼠标下单/);
  assert.ok(
    html.indexOf('class="zoom-chart-panel"') < html.indexOf('class="grid"'),
    "缩放行情区域应位于主网格之前"
  );
});

test("页面包含渲染入口注册的每个必要控件", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "index.html"),
    "utf8"
  );

  for (const [name, selector] of Object.entries(ELEMENT_SELECTORS)) {
    assert.match(
      html,
      new RegExp(`id=["']${selector.slice(1)}["']`),
      `${name} 缺少对应页面控件`
    );
  }
});

test("页面元素注册表一次性收集全部控件", () => {
  const calls = [];
  const fakeDocument = {
    querySelector(selector) {
      calls.push(selector);
      return { selector };
    },
  };

  const elements = collect(fakeDocument);
  assert.equal(calls.length, Object.keys(ELEMENT_SELECTORS).length);
  assert.deepEqual(elements.orderId, { selector: "#orderId" });
});

test("页面缺少必要控件时立即给出明确错误", () => {
  assert.throws(
    () => collect({ querySelector: () => null }),
    /页面缺少必要控件：.*environmentSwitch/
  );
});
