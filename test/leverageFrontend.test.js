const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ELEMENT_SELECTORS } = require("../src/rendererElements");

const ROOT = path.join(__dirname, "..");
const rendererSource = fs.readFileSync(
  path.join(ROOT, "src", "renderer.js"),
  "utf8"
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createRendererLeverageHarness(binanceOverrides = {}) {
  const boundary = rendererSource.indexOf("function normalizeDepthLevels");
  assert.notEqual(boundary, -1, "找不到杠杆逻辑测试边界");

  const elements = {
    chartSymbolInput: { value: "" },
    leverageSelect: {
      disabled: true,
      value: "",
      options: [],
      replaceChildren(fragment) {
        this.options = [...(fragment.children || [])];
      },
    },
    leverageStatus: {
      textContent: "",
      dataset: {},
      title: "",
    },
    requestDuration: { textContent: "" },
    output: { textContent: "" },
    signTradFiAgreementButton: { disabled: false },
    tradFiAgreementStatus: { textContent: "" },
  };
  const document = {
    createDocumentFragment() {
      return {
        children: [],
        append(child) {
          this.children.push(child);
        },
      };
    },
    createElement() {
      return { value: "", textContent: "" };
    },
    querySelector() {
      return null;
    },
  };
  const calls = { placeOrder: [], testOrder: [] };
  const binance = {
    leverageCache: async ({ symbol }) => ({
      ok: true,
      data: { symbol, cached: null },
    }),
    leverageConfig: async ({ symbol }) => ({
      ok: true,
      data: { symbol, currentLeverage: 20, maxLeverage: 125 },
    }),
    setLeverage: async ({ symbol, leverage }) => ({
      ok: true,
      data: { symbol, leverage, applied: true },
    }),
    async placeOrder(order) {
      calls.placeOrder.push(order);
      return { ok: true, data: {} };
    },
    async testOrder(order) {
      calls.testOrder.push(order);
      return { ok: true, data: {} };
    },
    ...binanceOverrides,
  };
  const context = {
    console,
    document,
    Date,
    Map,
    Set,
    Promise,
  };
  context.globalThis = context;
  context.window = context;
  context.RendererElements = { collect: () => elements };
  context.PositionSafety = {
    POSITION_SNAPSHOT_STALE_MS: 1,
    REQUIRED_FLAT_CONFIRMATIONS: 1,
    evaluatePositionSafety() {},
    mergePositionSnapshots() {},
  };
  context.binance = binance;
  vm.createContext(context);
  vm.runInContext(
    `${rendererSource.slice(0, boundary)}\n` +
      `globalThis.__leverageTestApi = {\n` +
      `  loadLeverageForSymbol, submitOrderWithTradFiAgreement,\n` +
      `  setPending(value) { leverageChangePending = value; },\n` +
      `  getPending() { return leverageChangePending; },\n` +
      `  getActiveConfig() { return activeLeverageConfig; },\n` +
      `};`,
    context
  );

  return {
    api: context.__leverageTestApi,
    binance,
    calls,
    elements,
  };
}

test("杠杆控件紧跟全局合约和切换行情按钮，并集中注册", () => {
  const html = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8");
  const toolbar = html.match(
    /<div class="chart-symbol-toolbar">([\s\S]*?)<\/div>/
  )?.[1] || "";
  const orderedIds = [
    "chartSymbolInput",
    "switchChartSymbolButton",
    "leverageSelect",
    "leverageStatus",
    "chartSymbolSwitchStatus",
  ];
  const positions = orderedIds.map((id) => toolbar.indexOf(`id="${id}"`));

  assert.equal(positions.every((position) => position >= 0), true);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.equal(ELEMENT_SELECTORS.leverageSelect, "#leverageSelect");
  assert.equal(ELEMENT_SELECTORS.leverageStatus, "#leverageStatus");
  assert.match(toolbar, /<label for="leverageSelect">杠杆倍率<\/label>/);
  assert.match(toolbar, /id="leverageStatus"[^>]*role="status"[^>]*aria-live="polite"/);
});

test("预加载层只暴露约定的杠杆缓存、校准和设置 IPC", () => {
  const preload = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");

  assert.match(
    preload,
    /leverageCache:\s*\(options\)\s*=>\s*\n?\s*ipcRenderer\.invoke\("binance:leverage-cache", options \|\| \{\}\)/
  );
  assert.match(
    preload,
    /leverageConfig:\s*\(options\)\s*=>\s*\n?\s*ipcRenderer\.invoke\("binance:leverage-config", options \|\| \{\}\)/
  );
  assert.match(
    preload,
    /setLeverage:\s*\(options\)\s*=>\s*\n?\s*ipcRenderer\.invoke\("binance:set-leverage", options \|\| \{\}\)/
  );
});

test("先快速回显本地倍率，再用 Binance 值校准并生成连续选项", async () => {
  const cache = deferred();
  const remote = deferred();
  const { api, elements } = createRendererLeverageHarness({
    leverageCache: () => cache.promise,
    leverageConfig: () => remote.promise,
  });
  elements.chartSymbolInput.value = "BTCUSDT";

  const loading = api.loadLeverageForSymbol("BTCUSDT");
  cache.resolve({
    ok: true,
    data: { symbol: "BTCUSDT", cached: { leverage: 10 } },
  });
  await nextTurn();

  assert.equal(elements.leverageSelect.value, "10");
  assert.match(elements.leverageStatus.textContent, /本地：10x.*校验中/);
  assert.equal(elements.leverageSelect.disabled, true);

  remote.resolve({
    ok: true,
    data: { symbol: "BTCUSDT", currentLeverage: 20, maxLeverage: 50 },
  });
  await loading;

  assert.equal(elements.leverageSelect.value, "20");
  assert.equal(elements.leverageSelect.disabled, false);
  assert.equal(elements.leverageStatus.dataset.state, "ready");
  assert.deepEqual(
    elements.leverageSelect.options.map(({ value }) => Number(value)),
    Array.from({ length: 50 }, (_item, index) => index + 1)
  );
});

test("Binance 校准成功但本地写回失败时保留可用倍率并明确警告", async () => {
  const { api, elements } = createRendererLeverageHarness({
    leverageConfig: async ({ symbol }) => ({
      ok: true,
      data: {
        symbol,
        currentLeverage: 25,
        maxLeverage: 100,
        persistence: {
          ok: false,
          saved: false,
          error: { message: "磁盘只读" },
        },
      },
    }),
  });
  elements.chartSymbolInput.value = "BTCUSDT";

  await api.loadLeverageForSymbol("BTCUSDT");

  assert.equal(elements.leverageSelect.value, "25");
  assert.equal(elements.leverageSelect.disabled, false);
  assert.match(elements.leverageStatus.textContent, /本地保存失败/);
  assert.match(elements.leverageStatus.title, /磁盘只读/);
});

test("较早合约的缓存和 Binance 迟到响应不会覆盖当前合约", async () => {
  const requests = new Map();
  function requestFor(type, symbol) {
    const request = deferred();
    requests.set(`${type}:${symbol}`, request);
    return request.promise;
  }
  const { api, elements } = createRendererLeverageHarness({
    leverageCache: ({ symbol }) => requestFor("cache", symbol),
    leverageConfig: ({ symbol }) => requestFor("remote", symbol),
  });

  elements.chartSymbolInput.value = "BTCUSDT";
  const bitcoinLoad = api.loadLeverageForSymbol("BTCUSDT");
  elements.chartSymbolInput.value = "ETHUSDT";
  const etherLoad = api.loadLeverageForSymbol("ETHUSDT");

  requests.get("cache:ETHUSDT").resolve({
    ok: true,
    data: { symbol: "ETHUSDT", cached: { leverage: 8 } },
  });
  requests.get("remote:ETHUSDT").resolve({
    ok: true,
    data: { symbol: "ETHUSDT", currentLeverage: 12, maxLeverage: 75 },
  });
  await etherLoad;
  assert.equal(elements.leverageSelect.value, "12");

  requests.get("cache:BTCUSDT").resolve({
    ok: true,
    data: { symbol: "BTCUSDT", cached: { leverage: 30 } },
  });
  requests.get("remote:BTCUSDT").resolve({
    ok: true,
    data: { symbol: "BTCUSDT", currentLeverage: 40, maxLeverage: 125 },
  });
  await bitcoinLoad;

  assert.equal(elements.leverageSelect.value, "12");
  assert.match(elements.leverageStatus.textContent, /12x/);
  assert.equal(api.getActiveConfig().symbol, "ETHUSDT");
});

test("较早的行情验证和连接响应不会抢回最后选择的合约", () => {
  const start = rendererSource.indexOf("async function connectMarketSymbol");
  const end = rendererSource.indexOf(
    'elements.leverageSelect.addEventListener("change"',
    start
  );
  const connector = rendererSource.slice(start, end);
  const revisionStart = connector.indexOf("++marketSwitchRevision");
  const validation = connector.indexOf("await window.binance.exchangeInfo");
  const afterValidation = connector.indexOf(
    "switchRevision !== marketSwitchRevision",
    validation
  );
  const connection = connector.indexOf("await window.binance.connectDepth");
  const afterConnection = connector.indexOf(
    "switchRevision !== marketSwitchRevision",
    afterValidation + 1
  );

  assert.ok(revisionStart >= 0, "每次行情切换应领取独立序号");
  assert.ok(afterValidation > validation, "行情验证后应丢弃过期切换");
  assert.ok(afterConnection > connection, "行情连接后应丢弃过期切换");
});

test("设置期间只阻止同合约的表单、画布和快捷键共用下单通道", async () => {
  const { api, calls } = createRendererLeverageHarness();
  api.setPending({ symbol: "BTCUSDT", requestedLeverage: 30 });

  const blocked = await api.submitOrderWithTradFiAgreement({
    symbol: "btcusdt",
  });
  const otherSymbol = await api.submitOrderWithTradFiAgreement({
    symbol: "ETHUSDT",
  });

  assert.equal(blocked.ok, false);
  assert.match(blocked.error.message, /BTCUSDT.*设置杠杆倍率/);
  assert.equal(otherSymbol.ok, true);
  assert.equal(calls.placeOrder.length, 1);
  assert.equal(calls.placeOrder[0].symbol, "ETHUSDT");

  assert.equal((rendererSource.match(/window\.binance\.placeOrder\(/g) || []).length, 1);
  assert.equal((rendererSource.match(/window\.binance\.testOrder\(/g) || []).length, 1);
  assert.match(
    rendererSource,
    /chartDom\.addEventListener\(['"]dblclick['"][\s\S]*?submitOrderWithTradFiAgreement\(order\)/
  );
  assert.match(
    rendererSource,
    /async function placeOrderFromNumpad[\s\S]*?submitOrderWithTradFiAgreement\(order\)/
  );
});

test("撤单重报在查询后再次执行同合约杠杆门禁", () => {
  const start = rendererSource.indexOf(
    'document.querySelector("#cancelReplaceButton")'
  );
  const end = rendererSource.indexOf(
    "function synchronizeSymbolInput",
    start
  );
  const handler = rendererSource.slice(start, end);
  const queryIndex = handler.indexOf("await window.binance.queryOrder");
  const gateIndex = handler.lastIndexOf("getLeverageOrderBlock");
  const replaceIndex = handler.indexOf("await window.binance.cancelReplace");

  assert.ok(queryIndex >= 0, "撤单重报应先查询原订单");
  assert.ok(gateIndex > queryIndex, "应覆盖查询期间开始设置杠杆的竞态");
  assert.ok(gateIndex < replaceIndex, "门禁必须发生在重报新订单之前");
});

test("同合约设置期间不会启动可能覆盖设置结果的杠杆查询", () => {
  const start = rendererSource.indexOf("async function loadLeverageForSymbol");
  const end = rendererSource.indexOf("function requiresTradFiPerpsAgreement", start);
  const loader = rendererSource.slice(start, end);
  const pendingCheck = loader.indexOf("leverageChangePending");
  const remoteCall = loader.indexOf("window.binance.leverageConfig");

  assert.ok(pendingCheck >= 0, "查询入口应检查正在设置的合约");
  assert.ok(pendingCheck < remoteCall, "同合约设置门禁必须先于 Binance 查询");
});

test("账户配置事件只校准当前且未处于设置中的合约", () => {
  const eventStart = rendererSource.indexOf(
    'if (payload.event?.e === "ACCOUNT_CONFIG_UPDATE")'
  );
  const eventEnd = rendererSource.indexOf(
    'if (payload.event?.e === "executionReport")',
    eventStart
  );
  const handler = rendererSource.slice(eventStart, eventEnd);

  assert.match(handler, /symbol === getInputSymbol\(\)/);
  assert.match(handler, /leverageChangePending\?\.symbol !== symbol/);
  assert.match(handler, /clearTimeout\(leverageConfigRefreshTimer\)/);
  assert.match(handler, /loadLeverageForSymbol\(symbol\)/);
});
