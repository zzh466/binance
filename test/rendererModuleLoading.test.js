const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("主页面先加载独立模块，最后加载渲染入口", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "index.html"),
    "utf8"
  );
  const expectedOrder = [
    "./chart.js",
    "./rendererElements.js",
    "./tablePagination.js",
    "./positionSafety.js",
    "./shortcutSettings.js",
    "./openOrderState.js",
    "./cancelAllOrderTargets.js",
    "./chartOrderSelection.js",
    "./depthAggregation.js",
    "./renderer.js",
  ];
  const positions = expectedOrder.map((source) => html.indexOf(`src="${source}"`));

  assert.equal(positions.every((position) => position >= 0), true);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test("行情价格标记条不拦截画布双击下单事件", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "index.html"),
    "utf8"
  );
  const priceTickRule = html.match(/\.price-tick\s*\{([^}]+)\}/)?.[1] || "";

  assert.match(priceTickRule, /pointer-events\s*:\s*none/);
});

test("主页只展示 U 本位永续功能", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "index.html"),
    "utf8"
  );

  assert.match(html, /Binance U 本位永续交易测试台/);
  assert.match(html, /value="STOP_MARKET"/);
  assert.match(html, /value="TAKE_PROFIT_MARKET"/);
  assert.match(html, /value="TRAILING_STOP_MARKET"/);
  assert.match(html, /id="activationPrice"/);
  assert.match(html, /id="callbackRate"/);
  assert.doesNotMatch(html, /Spot|现货|OCO|OTOCO|\bOTO\b/);
  assert.doesNotMatch(
    html,
    /LIMIT_MAKER|STOP_LOSS|TAKE_PROFIT_LIMIT|trailingDelta|icebergQty/
  );
});

test("渲染层不再暴露或调用现货组合订单", () => {
  const sources = ["preload.js", "renderer.js", "rendererElements.js"]
    .map((fileName) => fs.readFileSync(
      path.join(__dirname, "..", "src", fileName),
      "utf8"
    ))
    .join("\n");

  assert.doesNotMatch(sources, /Spot|现货|OCO|OTOCO|\bOTO\b/);
  assert.doesNotMatch(
    sources,
    /allOrderLists|queryOrderList|openOrderLists|placeOco|placeOto|placeOtoco|cancelOrderList/
  );
  assert.doesNotMatch(
    sources,
    /trailingDelta|icebergQty|LIMIT_MAKER|STOP_LOSS|TAKE_PROFIT_LIMIT/
  );
});

test("缩放行情只聚合已收到的深度快照且保持画布只读", () => {
  const renderer = fs.readFileSync(
    path.join(__dirname, "..", "src", "renderer.js"),
    "utf8"
  );

  assert.match(renderer, /depthAggregationApi\.aggregateDepth\(\{/);
  assert.match(renderer, /bids:\s*depth\.bids\s*\|\|\s*\[\]/);
  assert.match(renderer, /asks:\s*depth\.asks\s*\|\|\s*\[\]/);
  assert.doesNotMatch(
    renderer,
    /zoomChartDom\.addEventListener\(['"]dblclick['"]/
  );
});
