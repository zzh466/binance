const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { app, BrowserWindow, ipcMain, net, Notification } = require("electron");
const dotenv = require("dotenv");
const { BinanceUnifiedClient } = require("./binance/binanceUnifiedClient");
const {
  readShortcutConfig,
  writeShortcutConfig,
} = require("./shortcutConfigStore");
const {
  getAdditionalInstanceLaunch,
  getPackagedEnvironmentPath,
} = require("./platformSupport");

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
const defaultTestnet = process.env.BINANCE_TESTNET !== "false";
const shortcutConfigPath = path.join(
  app.getPath("appData"),
  "Binance统一交易台",
  "shortcut-settings.json"
);

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
    depthSnapshotLimit: process.env.BINANCE_DEPTH_SNAPSHOT_LIMIT || 1000,
    depthDisplayLevels: process.env.BINANCE_DEPTH_DISPLAY_LEVELS || 5,
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
    const activeClient = client;
    if (activeClient.apiKey && activeClient.apiSecret) {
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
    depthSnapshotLimit: client.depthSnapshotLimit,
    depthDisplayLevels: client.depthDisplayLevels,
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
  const nextClient = createBinanceClient(testnet);
  bindClientEvents(nextClient);
  client = nextClient;
  previousClient.close();

  let initializationWarning = null;
  try {
    await nextClient.initialize();
  } catch (error) {
    initializationWarning = serializeError(error);
  }
  if (nextClient.apiKey && nextClient.apiSecret) {
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
    return safeCall(() => client.placeOrder(payload || {}));
  });

  ipcMain.handle("binance:test-order", async (_event, payload) => {
    return safeCall(() => client.placeOrder(payload || {}, { testOnly: true }));
  });

  ipcMain.handle("binance:cancel-order", async (_event, payload) => {
    return safeCall(() => client.cancelOrder(payload || {}));
  });

  ipcMain.handle("binance:query-order", async (_event, payload) => {
    return safeCall(() => client.queryOrder(payload || {}));
  });

  ipcMain.handle("binance:open-orders", async (_event, payload) => {
    return safeCall(() => client.openOrders(payload || {}));
  });

  ipcMain.handle("binance:cancel-all-open-orders", async (_event, payload) => {
    return safeCall(() => client.cancelAllOpenOrders(payload || {}));
  });

  ipcMain.handle("binance:amend-order", async (_event, payload) => {
    return safeCall(() => client.amendOrder(payload || {}));
  });

  ipcMain.handle("binance:cancel-replace", async (_event, payload) => {
    return safeCall(() => client.cancelReplace(payload || {}));
  });

  ipcMain.handle("binance:all-order-lists", async (_event, payload) => {
    return safeCall(() => client.allOrderLists(payload || {}));
  });

  ipcMain.handle("binance:all-orders", async (_event, payload) => {
    return safeCall(() => client.allOrders(payload || {}));
  });

  ipcMain.handle("binance:my-trades", async (_event, payload) => {
    return safeCall(() => client.myTrades(payload || {}));
  });

  ipcMain.handle("binance:account-status", async (_event, payload) => {
    return safeCall(() => client.accountStatus(payload || {}));
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

  ipcMain.handle("binance:query-order-list", async (_event, payload) => {
    return safeCall(() => client.queryOrderList(payload || {}));
  });

  ipcMain.handle("binance:open-order-lists", async (_event, payload) => {
    return safeCall(() => client.openOrderLists(payload || {}));
  });

  ipcMain.handle("binance:place-oco", async (_event, payload) => {
    return safeCall(() => client.placeOco(payload || {}));
  });

  ipcMain.handle("binance:place-oto", async (_event, payload) => {
    return safeCall(() => client.placeOto(payload || {}));
  });

  ipcMain.handle("binance:place-otoco", async (_event, payload) => {
    return safeCall(() => client.placeOtoco(payload || {}));
  });

  ipcMain.handle("binance:cancel-order-list", async (_event, payload) => {
    return safeCall(() => client.cancelOrderList(payload || {}));
  });

  ipcMain.handle("binance:connect-user-data", async (_event, payload) => {
    return safeCall(() => client.connectUserData(payload || {}));
  });

  ipcMain.handle("binance:disconnect-user-data", async () => {
    return safeCall(async () => client.disconnectUserData());
  });
}

function bindClientEvents(targetClient) {
  targetClient.on("depth-update", (data) => {
    if (targetClient === client) sendToRenderer("binance:depth-update", data);
  });

  targetClient.on("trade-update", (data) => {
    if (targetClient === client) sendToRenderer("binance:trade-update", data);
  });

  targetClient.on("market-status", (data) => {
    if (targetClient === client) sendToRenderer("binance:market-status", data);
  });

  targetClient.on("market-error", (data) => {
    if (targetClient === client) sendToRenderer("binance:market-error", data);
  });

  targetClient.on("user-data-event", (data) => {
    if (targetClient !== client) return;
    sendToRenderer("binance:user-data-event", data);
    showUserDataNotification(data);
  });

  targetClient.on("user-data-status", (data) => {
    if (targetClient === client) sendToRenderer("binance:user-data-status", data);
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
  client.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
