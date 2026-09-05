const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { app, BrowserWindow, ipcMain, net, Notification } = require("electron");
const dotenv = require("dotenv");
const { BinanceUnifiedClient } = require("./binance/binanceUnifiedClient");
const {
  createLatestUpdateCoalescer,
} = require("./latestUpdateCoalescer");
const {
  readShortcutConfig,
  writeShortcutConfig,
} = require("./shortcutConfigStore");
const {
  RecentOrderStore,
  recent24HourCutoff,
} = require("./recentOrderStore");
const {
  getAdditionalInstanceLaunch,
  getPackagedEnvironmentPath,
} = require("./platformSupport");
const {
  SharedRateLimitCoordinator,
} = require("./sharedRateLimitCoordinator");
const {
  TradingRoundStore,
  compareRoundsNewestFirst,
} = require("./tradingRoundStore");

function loadEnvironmentFile() {
  const packagedEnvironmentPath = getPackagedEnvironmentPath({
    isPackaged: app.isPackaged,
  });
  const candidates = [
    process.env.BINANCE_ENV_FILE,
    path.join(__dirname, "..", ".env"),
    packagedEnvironmentPath,
    path.join(app.getPath("appData"), "Binance统一交易台", ".env"),
  ].filter(Boolean);
  const envPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (envPath) dotenv.config({ path: envPath });
  return envPath || null;
}

const loadedEnvironmentPath = loadEnvironmentFile();
const instanceArgument = process.argv.find((argument) =>
  argument.startsWith("--binance-instance=")
);
const instanceId = instanceArgument
  ? instanceArgument.slice("--binance-instance=".length).replace(/[^a-zA-Z0-9_-]/g, "")
  : "";
if (instanceId) {
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), "Binance统一交易台", `instance-${instanceId}`)
  );
}

let mainWindow = null;
let latestBinanceLatency = null;
const defaultTestnet = process.env.BINANCE_TESTNET !== "false";
const shortcutConfigPath = path.join(
  app.getPath("appData"),
  "Binance统一交易台",
  "shortcut-settings.json"
);
const recentOrderStorePath = path.join(
  app.getPath("userData"),
  "recent-orders.json"
);
const recentOrderStore = new RecentOrderStore(recentOrderStorePath);
const tradingRoundStore = new TradingRoundStore(
  path.join(app.getPath("userData"), "trading-rounds.json")
);
const rateLimitCoordinator = new SharedRateLimitCoordinator(
  path.join(app.getPath("appData"), "Binance统一交易台", "rate-limits"),
  { instanceId: instanceId || `pid-${process.pid}` }
);
const unknownOrderReconciliationTimers = new Set();
let futuresDeadManState = null;

function fingerprintApiKey(apiKey) {
  const value = String(apiKey || "");
  if (!value) return "";
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function getOrderStoreContext(
  targetClient,
  marketType,
  { defaultStatus, source } = {}
) {
  const marketClient = targetClient.getClient(marketType);
  return {
    environment: targetClient.testnet ? "testnet" : "production",
    accountFingerprint: fingerprintApiKey(marketClient.apiKey),
    marketType,
    defaultStatus,
    source,
  };
}

function collectOrderCandidates(payload, target = []) {
  if (Array.isArray(payload)) {
    for (const item of payload) collectOrderCandidates(item, target);
    return target;
  }
  if (!payload || typeof payload !== "object") return target;

  const hasOrderIdentity =
    (payload.orderId !== undefined || payload.i !== undefined ||
      payload.clientOrderId || payload.c) &&
    (payload.symbol || payload.s);
  if (hasOrderIdentity) target.push(payload);

  for (const field of [
    "orders",
    "orderReports",
    "cancelResult",
    "newOrderResult",
  ]) {
    if (payload[field]) collectOrderCandidates(payload[field], target);
  }
  return target;
}

function trackOrderPayload(
  payload,
  { targetClient = client, marketType, defaultStatus, source } = {}
) {
  const saved = [];
  const affectedRoundIds = new Set();
  const rootMarketType = payload?.marketType || marketType;
  for (const order of collectOrderCandidates(payload)) {
    const resolvedMarketType = order.marketType || rootMarketType;
    if (!resolvedMarketType) continue;
    const storeContext = getOrderStoreContext(
      targetClient,
      resolvedMarketType,
      { defaultStatus, source }
    );
    const result = recentOrderStore.upsert(
      order,
      storeContext
    );
    if (result) {
      saved.push(result);
      const roundContext = {
        ...storeContext,
        updatedAt: result.updatedAt,
      };
      const roundUpdate =
        tradingRoundStore.recordOrderExecution(order, roundContext) ||
        tradingRoundStore.recordOrderExecution(result, roundContext);
      for (const roundId of roundUpdate?.affectedRoundIds || []) {
        affectedRoundIds.add(roundId);
      }
    }
  }
  if (affectedRoundIds.size && targetClient === client) {
    const rounds = listTradingRounds({}, targetClient).filter((round) =>
      affectedRoundIds.has(round.id)
    );
    sendToRenderer("binance:trading-rounds-update", {
      rounds,
      partial: true,
      time: Date.now(),
    });
  }
  return saved;
}

async function trackOrderCall(action, options = {}) {
  try {
    const data = await action();
    trackOrderPayload(data, options);
    return data;
  } catch (error) {
    trackOrderPayload(error?.data, {
      ...options,
      source: `${options.source || "order-call"}-partial-result`,
    });
    if (error?.data?.orderAttempt) {
      trackOrderPayload(error.data.orderAttempt, {
        ...options,
        defaultStatus: error.data.orderAttempt.status || "REJECTED",
        source: "place-order-rejected",
      });
      scheduleUnknownOrderReconciliation(
        error.data.orderAttempt,
        options.targetClient || client
      );
    }
    throw error;
  }
}

function scheduleUnknownOrderReconciliation(orderAttempt, targetClient = client) {
  if (orderAttempt?.status !== "UNKNOWN") return;
  const symbol = orderAttempt.symbol || orderAttempt.s;
  const origClientOrderId =
    orderAttempt.clientOrderId ||
    orderAttempt.newClientOrderId ||
    orderAttempt.clientAlgoId ||
    orderAttempt.c;
  if (!symbol || !origClientOrderId) return;

  const delays = [150, 500, 1_500, 3_000, 8_000];
  const tryQuery = (index) => {
    if (index >= delays.length || targetClient !== client) return;
    const timer = setTimeout(async () => {
      unknownOrderReconciliationTimers.delete(timer);
      if (targetClient !== client) return;
      try {
        const order = await targetClient.queryOrder({
          symbol,
          origClientOrderId,
          marketType: orderAttempt.marketType,
        });
        trackOrderPayload(order, {
          targetClient,
          marketType: orderAttempt.marketType,
          source: "unknown-order-reconciliation",
        });
        sendToRenderer("binance:recent-orders-synced", {
          reason: "unknown-order-reconciled",
          orders: listRecentOrders({}, targetClient),
        });
      } catch {
        tryQuery(index + 1);
      }
    }, delays[index]);
    timer.unref?.();
    unknownOrderReconciliationTimers.add(timer);
  };
  tryQuery(0);
}

function clearFuturesDeadManTimer() {
  if (futuresDeadManState?.timer) {
    clearInterval(futuresDeadManState.timer);
  }
  futuresDeadManState = null;
}

async function configureFuturesDeadMan(payload = {}, targetClient = client) {
  const enabled = Boolean(payload.enabled);
  const previousState = futuresDeadManState;
  const symbol = targetClient.validateSymbol(
    enabled ? payload.symbol : previousState?.symbol || payload.symbol
  );
  if (!enabled) {
    const result = await targetClient.setFuturesCountdownCancelAll({
      symbol,
      countdownTime: 0,
    });
    clearFuturesDeadManTimer();
    const status = { enabled: false, symbol, result, time: Date.now() };
    if (targetClient === client) {
      sendToRenderer("binance:futures-dead-man-status", status);
    }
    return status;
  }

  const countdownTime = Math.min(
    600_000,
    Math.max(5_000, Math.floor(Number(payload.countdownTime) || 120_000))
  );
  const heartbeatMs = Math.min(
    Math.floor(countdownTime / 2),
    Math.max(1_000, Math.floor(Number(payload.heartbeatMs) || 30_000))
  );
  if (previousState?.symbol && previousState.symbol !== symbol) {
    await targetClient.setFuturesCountdownCancelAll({
      symbol: previousState.symbol,
      countdownTime: 0,
    });
  }
  const initialResult = await targetClient.setFuturesCountdownCancelAll({
    symbol,
    countdownTime,
  });
  clearFuturesDeadManTimer();
  let heartbeatInFlight = false;
  const heartbeat = async () => {
    if (targetClient !== client) {
      clearFuturesDeadManTimer();
      return;
    }
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const result = await targetClient.setFuturesCountdownCancelAll({
        symbol,
        countdownTime,
      });
      sendToRenderer("binance:futures-dead-man-status", {
        enabled: true,
        symbol,
        countdownTime,
        heartbeatMs,
        result,
        time: Date.now(),
      });
    } catch (error) {
      sendToRenderer("binance:futures-dead-man-status", {
        enabled: true,
        symbol,
        countdownTime,
        heartbeatMs,
        error: serializeError(error),
        time: Date.now(),
      });
    } finally {
      heartbeatInFlight = false;
    }
  };
  const timer = setInterval(heartbeat, heartbeatMs);
  timer.unref?.();
  futuresDeadManState = {
    enabled: true,
    symbol,
    countdownTime,
    heartbeatMs,
    timer,
  };
  const status = {
    ...futuresDeadManState,
    timer: undefined,
    result: initialResult,
    time: Date.now(),
  };
  if (targetClient === client) {
    sendToRenderer("binance:futures-dead-man-status", status);
  }
  return status;
}

function listRecentOrders(payload = {}, targetClient = client) {
  const marketTypes = payload.marketType
    ? [payload.marketType]
    : ["spot", "futures"];
  return marketTypes.flatMap((marketType) => {
    const accountFingerprint = fingerprintApiKey(
      targetClient.getClient(marketType).apiKey
    );
    if (!accountFingerprint) return [];
    return recentOrderStore.list({
      environment: targetClient.testnet ? "testnet" : "production",
      accountFingerprints: [accountFingerprint],
      marketType,
      symbol: payload.symbol,
    });
  }).sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
}

function listTradingRounds(payload = {}, targetClient = client) {
  const marketTypes = payload.marketType
    ? [payload.marketType]
    : ["spot", "futures"];
  return marketTypes.flatMap((marketType) => {
    const accountFingerprint = fingerprintApiKey(
      targetClient.getClient(marketType).apiKey
    );
    if (!accountFingerprint) return [];
    return tradingRoundStore.list({
      environment: targetClient.testnet ? "testnet" : "production",
      accountFingerprints: [accountFingerprint],
      marketType,
      symbol: payload.symbol,
    });
  }).sort(compareRoundsNewestFirst);
}

function listKnownOrderSymbols(marketType, targetClient = client) {
  const marketClient = targetClient.getClient(marketType);
  const accountFingerprint = fingerprintApiKey(marketClient.apiKey);
  if (!accountFingerprint) return [];
  return [...new Set(recentOrderStore.list({
    environment: targetClient.testnet ? "testnet" : "production",
    accountFingerprints: [accountFingerprint],
    marketType,
  }).map((order) => order.symbol).filter(Boolean))];
}

async function syncRecentAccountOrders(payload = {}, targetClient = client) {
  const endTime = Date.now();
  const startTime = recent24HourCutoff(endTime);
  const knownSpotSymbols = listKnownOrderSymbols("spot", targetClient);
  const knownFuturesSymbols = listKnownOrderSymbols("futures", targetClient);
  if (payload.marketType === "spot" && payload.symbol) {
    knownSpotSymbols.push(payload.symbol);
  }
  if (payload.marketType === "futures" && payload.symbol) {
    knownFuturesSymbols.push(payload.symbol);
  }
  if (!payload.marketType && payload.symbol) {
    try {
      const resolution = await targetClient.resolveMarket(payload.symbol);
      if (resolution.marketType === "spot") {
        knownSpotSymbols.push(resolution.symbol);
      } else if (resolution.marketType === "futures") {
        knownFuturesSymbols.push(resolution.symbol);
      }
    } catch {
      // 当前输入框的合约无效时，仍继续同步账户中已经发现的其他合约。
    }
  }

  const result = await targetClient.recentAccountOrders({
    startTime,
    endTime,
    limit: 1_000,
    knownSpotSymbols,
    knownFuturesSymbols,
  });
  const chronologicalOrders = [...result.orders].sort((left, right) => {
    const leftTime = Number(
      left.time ?? left.updateTime ?? left.transactTime ?? left.T ?? left.E ?? 0
    );
    const rightTime = Number(
      right.time ?? right.updateTime ?? right.transactTime ?? right.T ?? right.E ?? 0
    );
    return leftTime - rightTime;
  });
  trackOrderPayload(chronologicalOrders, {
    targetClient,
    source: "recent-account-orders",
  });
  return {
    ...result,
    orders: listRecentOrders({}, targetClient),
  };
}

function getEnvironmentCredentials(testnet) {
  const prefix = testnet ? "BINANCE_TESTNET" : "BINANCE_PRODUCTION";
  const apiKey = process.env[`${prefix}_API_KEY`] || "";
  const apiSecret = process.env[`${prefix}_API_SECRET`] || "";

  if (apiKey && apiSecret) {
    return { apiKey, apiSecret, source: prefix };
  }

  // 兼容原有配置：通用 Key 只用于 .env 中指定的默认环境，防止把
  // Testnet Key 误发到正式环境（或反之）。
  if (testnet === defaultTestnet) {
    return {
      apiKey: process.env.BINANCE_API_KEY || "",
      apiSecret: process.env.BINANCE_API_SECRET || "",
      source: "BINANCE_API",
    };
  }

  return { apiKey: "", apiSecret: "", source: prefix };
}

function getFuturesCredentials(testnet) {
  const prefix = testnet ? "BINANCE_TESTNET" : "BINANCE_PRODUCTION";
  const apiKey = process.env[`${prefix}_FUTURES_API_KEY`] || "";
  const apiSecret = process.env[`${prefix}_FUTURES_API_SECRET`] || "";
  if (apiKey && apiSecret) {
    return { apiKey, apiSecret, source: `${prefix}_FUTURES` };
  }

  const shared = getEnvironmentCredentials(testnet);
  return {
    ...shared,
    source: shared.apiKey && shared.apiSecret
      ? `${shared.source}（与现货共用）`
      : `${prefix}_FUTURES`,
  };
}

function createBinanceClient(testnet) {
  const spotCredentials = getEnvironmentCredentials(testnet);
  const futuresCredentials = getFuturesCredentials(testnet);
  return new BinanceUnifiedClient({
    spotCredentials,
    futuresCredentials,
    testnet,
    depthSpeed: process.env.BINANCE_DEPTH_SPEED || "100ms",
    spotBrokerLinkId: process.env.BINANCE_SPOT_LINK_ID || "",
    futuresBrokerLinkId: process.env.BINANCE_FUTURES_LINK_ID || "",
    expectedSpotTradeGroupId:
      process.env.BINANCE_SPOT_EXPECTED_TRADE_GROUP_ID || "",
    expectedFuturesTradeGroupId:
      process.env.BINANCE_FUTURES_EXPECTED_TRADE_GROUP_ID || "",
    rateLimitCoordinator,
    publicMarketFetch: (url, options) => net.fetch(url, options),
    preflightBalanceCheck:
      process.env.BINANCE_PREFLIGHT_BALANCE_CHECK === "true",
  });
}

let client = createBinanceClient(defaultTestnet);

function openAdditionalInstances(count = 2) {
  const normalizedCount = Math.min(2, Math.max(1, Number(count) || 2));
  const launchGroup = `${Date.now()}-${process.pid}`;
  const launched = [];

  for (let index = 1; index <= normalizedCount; index += 1) {
    const childInstanceId = `${launchGroup}-${index}`;
    const { command, args } = getAdditionalInstanceLaunch({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      appBundlePath: path.resolve(path.dirname(process.execPath), "../.."),
      instanceId: childInstanceId,
    });

    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        ...(loadedEnvironmentPath
          ? { BINANCE_ENV_FILE: loadedEnvironmentPath }
          : {}),
      },
    });
    child.unref();
    launched.push(childInstanceId);
  }

  return { launchedCount: launched.length, instances: launched };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 820,
    resizable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("did-finish-load", () => {
    if (latestBinanceLatency) {
      sendToRenderer("binance:latency-update", latestBinanceLatency);
    }
    const activeClient = client;
    if (hasAnyTradingCredentials(activeClient)) {
      connectUserDataInBackground(activeClient);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function getUserDataEventStatus(event = {}) {
  if (event.e === "executionReport") {
    return event.X || event.x || "订单状态已更新";
  }
  if (event.e === "listStatus") {
    return event.L || event.l || "组合订单状态已更新";
  }
  if (event.e === "outboundAccountPosition") {
    return "账户余额已更新";
  }
  if (event.e === "balanceUpdate") {
    return "余额已变动";
  }
  if (event.e === "eventStreamTerminated") {
    return "账户事件流已终止";
  }
  return event.X || event.x || event.L || event.l || "已收到";
}

function showUserDataNotification(payload = {}) {
  if (!Notification.isSupported()) {
    return;
  }

  const event = payload.event || {};
  const timestamp = Number(event.E ?? event.T ?? payload.receivedAt ?? Date.now());
  const time = Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString("zh-CN", { hour12: false })
    : String(timestamp);
  const type = event.e || "未知事件";
  const status = getUserDataEventStatus(event);
  const notification = new Notification({
    title: "Binance 账户事件",
    body: `时间：${time}\n事件类型：${type}\n状态：${status}`,
    silent: false,
  });

  notification.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notification.show();
}

function connectUserDataInBackground(targetClient = client) {
  targetClient.connectUserData().catch((error) => {
    if (targetClient !== client) return;
    sendToRenderer("binance:user-data-error", {
      ...serializeError(error),
      time: Date.now(),
    });
  });
}

function hasAnyTradingCredentials(targetClient = client) {
  return [targetClient.spot, targetClient.futures].some(
    (marketClient) => marketClient.apiKey && marketClient.apiSecret
  );
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || "未知错误",
    status: error?.status,
    code: error?.code,
    data: error?.data,
  };
}

async function safeCall(action) {
  const startedAt = performance.now();

  try {
    const data = await action();

    return {
      ok: true,
      elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      data,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      error: serializeError(error),
    };
  }
}

function getClientStatus() {
  return {
    testnet: client.testnet,
    restBase: client.restBase,
    tradingRestBase: client.tradingRestBase,
    wsBase: client.wsBase,
    wsApiBase: client.wsApiBase,
    tradingWsApiBase: client.tradingWsApiBase,
    hasApiKey: Boolean(client.apiKey),
    hasApiSecret: Boolean(client.apiSecret),
    credentialsSource: client.credentialsSource,
    serverTimeOffsetMs: client.serverTimeOffsetMs,
    tradingServerTimeOffsetMs: client.tradingServerTimeOffsetMs,
    preflightBalanceCheck: client.preflightBalanceCheck,
    depthSpeed: client.depthSpeed,
    depthMode: client.depthMode,
    depthStreamLevels: client.depthStreamLevels,
    depthDisplayLevels: client.depthDisplayLevels,
    rateLimits: rateLimitCoordinator.snapshot(),
    futuresDeadMan: futuresDeadManState
      ? {
          enabled: true,
          symbol: futuresDeadManState.symbol,
          countdownTime: futuresDeadManState.countdownTime,
          heartbeatMs: futuresDeadManState.heartbeatMs,
        }
      : { enabled: false },
    activeMarketType: client.activeMarketType,
    activeSymbol: client.activeSymbol,
    markets: {
      spot: {
        restBase: client.spot.restBase,
        wsBase: client.spot.wsBase,
        wsApiBase: client.spot.wsApiBase,
        tradingWebSocket: client.spot.getTradingWebSocketStatus(),
        hasApiKey: Boolean(client.spot.apiKey),
        hasApiSecret: Boolean(client.spot.apiSecret),
        credentialsSource: client.spot.credentialsSource,
        serverTimeOffsetMs: client.spot.serverTimeOffsetMs,
      },
      futures: {
        restBase: client.futures.restBase,
        wsBase: client.futures.wsBase,
        wsApiBase: client.futures.wsApiBase,
        tradingWebSocket: client.futures.getTradingWebSocketStatus(),
        publicMarketTransport: client.futures.publicMarketTransport,
        hasApiKey: Boolean(client.futures.apiKey),
        hasApiSecret: Boolean(client.futures.apiSecret),
        credentialsSource: client.futures.credentialsSource,
        serverTimeOffsetMs: client.futures.serverTimeOffsetMs,
      },
    },
  };
}

async function switchClientEnvironment(testnet) {
  if (client.testnet === testnet) {
    return { ...getClientStatus(), switched: false, reused: true };
  }

  const previousClient = client;
  clearFuturesDeadManTimer();
  const nextClient = createBinanceClient(testnet);
  bindClientEvents(nextClient);
  client = nextClient;
  latestBinanceLatency = null;
  sendToRenderer("binance:latency-update", null);
  previousClient.close();

  let initializationWarning = null;
  try {
    await nextClient.initialize();
  } catch (error) {
    initializationWarning = serializeError(error);
  }
  if (hasAnyTradingCredentials(nextClient)) {
    connectUserDataInBackground(nextClient);
  }

  return {
    ...getClientStatus(),
    switched: true,
    reused: false,
    initializationWarning,
  };
}

function registerIpcHandlers() {
  ipcMain.handle("app:load-shortcut-settings", async (_event, payload) => {
    return safeCall(async () => ({
      settings: readShortcutConfig(shortcutConfigPath, {
        fallbackSettings: payload?.fallbackSettings,
      }),
      configPath: shortcutConfigPath,
    }));
  });

  ipcMain.handle("app:save-shortcut-settings", async (_event, payload) => {
    return safeCall(async () => ({
      settings: writeShortcutConfig(shortcutConfigPath, payload?.settings),
      configPath: shortcutConfigPath,
    }));
  });

  ipcMain.handle("binance:get-status", async () => {
    return safeCall(async () => getClientStatus());
  });

  ipcMain.handle("app:open-additional-instances", async (_event, payload) => {
    return safeCall(async () => openAdditionalInstances(payload?.count));
  });

  ipcMain.handle("binance:switch-environment", async (_event, payload) => {
    return safeCall(async () => {
      if (typeof payload?.testnet !== "boolean") {
        throw new TypeError("切换环境必须明确提供 testnet 布尔值。");
      }
      return switchClientEnvironment(payload.testnet);
    });
  });

  ipcMain.handle("binance:sync-time", async (_event, payload) => {
    return safeCall(() => client.syncServerTime(payload?.symbol));
  });

  ipcMain.handle("binance:ping", async (_event, payload) => {
    return safeCall(() => client.ping(payload?.symbol));
  });

  ipcMain.handle("binance:exchange-info", async (_event, payload) => {
    return safeCall(() => client.exchangeInfo(payload?.symbol, {
      forceRefresh: Boolean(payload?.forceRefresh),
    }));
  });

  ipcMain.handle("binance:market-overview", async (_event, payload) => {
    return safeCall(() => client.marketOverview(payload?.symbol, payload || {}));
  });

  ipcMain.handle("binance:connect-depth", async (_event, payload) => {
    return safeCall(async () => client.connectDepth(payload?.symbol));
  });

  ipcMain.handle("binance:disconnect-market", async () => {
    return safeCall(async () => {
      client.disconnectMarket();
      return { disconnected: true };
    });
  });

  ipcMain.handle("binance:place-order", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.placeOrder(payload || {}),
      { defaultStatus: "ACKNOWLEDGED", source: "place-order" }
    ));
  });

  ipcMain.handle("binance:test-order", async (_event, payload) => {
    return safeCall(() => client.placeOrder(payload || {}, { testOnly: true }));
  });

  ipcMain.handle("binance:cancel-order", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.cancelOrder(payload || {}),
      { defaultStatus: "CANCELED", source: "cancel-order" }
    ));
  });

  ipcMain.handle("binance:query-order", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.queryOrder(payload || {}),
      { source: "query-order" }
    ));
  });

  ipcMain.handle("binance:open-orders", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.openOrders(payload || {}),
      { defaultStatus: "NEW", source: "open-orders" }
    ));
  });

  ipcMain.handle("binance:cancel-all-open-orders", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.cancelAllOpenOrders(payload || {}),
      { defaultStatus: "CANCELED", source: "cancel-all-open-orders" }
    ));
  });

  ipcMain.handle("binance:amend-order", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.amendOrder(payload || {}),
      { source: "amend-order" }
    ));
  });

  ipcMain.handle("binance:cancel-replace", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.cancelReplace(payload || {}),
      { source: "cancel-replace" }
    ));
  });

  ipcMain.handle("binance:all-order-lists", async (_event, payload) => {
    return safeCall(() => client.allOrderLists(payload || {}));
  });

  ipcMain.handle("binance:all-orders", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.allOrders(payload || {}),
      { source: "all-orders" }
    ));
  });

  ipcMain.handle("binance:recent-orders", async (_event, payload) => {
    return safeCall(async () => listRecentOrders(payload || {}));
  });

  ipcMain.handle("binance:trading-rounds", async (_event, payload) => {
    return safeCall(async () => listTradingRounds(payload || {}));
  });

  ipcMain.handle("binance:sync-recent-orders", async (_event, payload) => {
    return safeCall(() => syncRecentAccountOrders(payload || {}));
  });

  ipcMain.handle("binance:my-trades", async (_event, payload) => {
    return safeCall(() => client.myTrades(payload || {}));
  });

  ipcMain.handle("binance:account-status", async (_event, payload) => {
    return safeCall(() => client.accountStatus(payload || {}));
  });

  ipcMain.handle("binance:trading-safety-status", async () => {
    return safeCall(() => client.tradingSafetyStatus());
  });

  ipcMain.handle("binance:account-rate-limits", async (_event, payload) => {
    return safeCall(() => client.accountRateLimits(payload || {}));
  });

  ipcMain.handle("binance:account-commission", async (_event, payload) => {
    return safeCall(() => client.accountCommission(payload || {}));
  });

  ipcMain.handle("binance:sign-tradfi-perps-agreement", async () => {
    return safeCall(() => client.signTradFiPerpsAgreement());
  });

  ipcMain.handle("binance:set-futures-dead-man", async (_event, payload) => {
    return safeCall(() => configureFuturesDeadMan(payload || {}));
  });

  ipcMain.handle("binance:query-order-list", async (_event, payload) => {
    return safeCall(() => client.queryOrderList(payload || {}));
  });

  ipcMain.handle("binance:open-order-lists", async (_event, payload) => {
    return safeCall(() => client.openOrderLists(payload || {}));
  });

  ipcMain.handle("binance:place-oco", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.placeOco(payload || {}),
      { defaultStatus: "ACKNOWLEDGED", source: "place-oco" }
    ));
  });

  ipcMain.handle("binance:place-oto", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.placeOto(payload || {}),
      { defaultStatus: "ACKNOWLEDGED", source: "place-oto" }
    ));
  });

  ipcMain.handle("binance:place-otoco", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.placeOtoco(payload || {}),
      { defaultStatus: "ACKNOWLEDGED", source: "place-otoco" }
    ));
  });

  ipcMain.handle("binance:cancel-order-list", async (_event, payload) => {
    return safeCall(() => trackOrderCall(
      () => client.cancelOrderList(payload || {}),
      { defaultStatus: "CANCELED", source: "cancel-order-list" }
    ));
  });

  ipcMain.handle("binance:connect-user-data", async (_event, payload) => {
    return safeCall(() => client.connectUserData(payload || {}));
  });

  ipcMain.handle("binance:disconnect-user-data", async () => {
    return safeCall(async () => client.disconnectUserData());
  });
}

function bindClientEvents(targetClient) {
  let accountReconciliationTimer = null;
  const tradeUpdateCoalescer = createLatestUpdateCoalescer({
    intervalMs: 32,
    send: (data) => {
      if (targetClient === client) {
        sendToRenderer("binance:trade-update", data);
      }
    },
  });
  const latencyUpdateCoalescer = createLatestUpdateCoalescer({
    intervalMs: 32,
    send: (data) => {
      if (targetClient === client) {
        sendToRenderer("binance:latency-update", data);
      }
    },
  });

  targetClient.on("depth-update", (data) => {
    if (targetClient === client) sendToRenderer("binance:depth-update", data);
  });

  targetClient.on("trade-update", (data) => {
    if (targetClient === client) tradeUpdateCoalescer.push(data);
  });

  targetClient.on("market-status", (data) => {
    if (targetClient === client) sendToRenderer("binance:market-status", data);
  });

  targetClient.on("market-error", (data) => {
    if (targetClient === client) sendToRenderer("binance:market-error", data);
  });

  targetClient.on("latency-update", (data) => {
    if (targetClient !== client) return;
    latestBinanceLatency = data;
    latencyUpdateCoalescer.push(data);
  });

  targetClient.on("rate-limit-update", (data) => {
    if (targetClient === client) {
      sendToRenderer("binance:rate-limit-update", data);
    }
  });

  targetClient.on("order-state-update", (data) => {
    if (targetClient !== client) return;
    trackOrderPayload(data, {
      targetClient,
      marketType: data.marketType,
      source: "order-attempt",
    });
  });

  targetClient.on("user-data-event", (data) => {
    if (targetClient !== client) return;
    if (data.event?.e === "executionReport") {
      trackOrderPayload(data.event, {
        targetClient,
        marketType: data.marketType,
        source: "user-data-stream",
      });
    }
    sendToRenderer("binance:user-data-event", data);
    showUserDataNotification(data);
  });

  targetClient.on("user-data-status", (data) => {
    if (targetClient !== client) return;
    sendToRenderer("binance:user-data-status", data);
    if (data.status === "connected") {
      clearTimeout(accountReconciliationTimer);
      accountReconciliationTimer = setTimeout(() => {
        if (targetClient !== client) return;
        syncRecentAccountOrders({}, targetClient).then((result) => {
          if (targetClient === client) {
            sendToRenderer("binance:recent-orders-synced", {
              reason: "user-data-connected",
              ...result,
            });
          }
        }).catch((error) => {
          if (targetClient === client) {
            sendToRenderer("binance:user-data-error", {
              ...serializeError(error),
              message: `账户事件重连后的订单对账失败：${error.message}`,
              time: Date.now(),
            });
          }
        });
      }, 750);
      accountReconciliationTimer.unref?.();
    }
  });

  targetClient.on("user-data-error", (data) => {
    if (targetClient === client) sendToRenderer("binance:user-data-error", data);
  });
}

bindClientEvents(client);

registerIpcHandlers();

app.whenReady().then(async () => {
  try {
    await client.initialize();
  } catch (error) {
    console.error("Binance server time synchronization failed:", error);
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  clearFuturesDeadManTimer();
  for (const timer of unknownOrderReconciliationTimers) clearTimeout(timer);
  unknownOrderReconciliationTimers.clear();
  recentOrderStore.close();
  tradingRoundStore.close();
  rateLimitCoordinator.close();
  client.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
