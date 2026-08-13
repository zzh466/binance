const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { app, BrowserWindow, ipcMain, Notification } = require("electron");
const dotenv = require("dotenv");
const { BinanceSpotClient } = require("./binance/binanceSpotClient");

dotenv.config({
  path: path.join(__dirname, "..", ".env"),
});

let mainWindow = null;

const client = new BinanceSpotClient({
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  testnet: process.env.BINANCE_TESTNET !== "false",
  depthSpeed: process.env.BINANCE_DEPTH_SPEED || "100ms",
  depthSnapshotLimit: process.env.BINANCE_DEPTH_SNAPSHOT_LIMIT || 1000,
  depthDisplayLevels: process.env.BINANCE_DEPTH_DISPLAY_LEVELS || 5,
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 900,
    minHeight: 680,
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
  mainWindow.webContents.once("did-finish-load", () => {
    connectUserDataInBackground();
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

function connectUserDataInBackground() {
  client.connectUserData().catch((error) => {
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

function registerIpcHandlers() {
  ipcMain.handle("binance:get-status", async () => {
    return safeCall(async () => ({
      testnet: client.testnet,
      restBase: client.restBase,
      tradingRestBase: client.tradingRestBase,
      wsBase: client.wsBase,
      wsApiBase: client.wsApiBase,
      tradingWsApiBase: client.tradingWsApiBase,
      hasApiKey: Boolean(client.apiKey),
      hasApiSecret: Boolean(client.apiSecret),
      serverTimeOffsetMs: client.serverTimeOffsetMs,
      tradingServerTimeOffsetMs: client.tradingServerTimeOffsetMs,
      depthSpeed: client.depthSpeed,
      depthSnapshotLimit: client.depthSnapshotLimit,
      depthDisplayLevels: client.depthDisplayLevels,
    }));
  });

  ipcMain.handle("binance:sync-time", async () => {
    return safeCall(() => client.syncServerTime());
  });

  ipcMain.handle("binance:ping", async () => {
    return safeCall(() => client.ping());
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

  ipcMain.handle("binance:account-rate-limits", async () => {
    return safeCall(() => client.accountRateLimits());
  });

  ipcMain.handle("binance:account-commission", async (_event, payload) => {
    return safeCall(() => client.accountCommission(payload || {}));
  });

  ipcMain.handle("binance:query-order-list", async (_event, payload) => {
    return safeCall(() => client.queryOrderList(payload || {}));
  });

  ipcMain.handle("binance:open-order-lists", async () => {
    return safeCall(() => client.openOrderLists());
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

  ipcMain.handle("binance:connect-user-data", async () => {
    return safeCall(() => client.connectUserData());
  });

  ipcMain.handle("binance:disconnect-user-data", async () => {
    return safeCall(async () => client.disconnectUserData());
  });
}

client.on("depth-update", (data) => {
  sendToRenderer("binance:depth-update", data);
});

client.on("trade-update", (data) => {
  sendToRenderer("binance:trade-update", data);
});

client.on("market-status", (data) => {
  sendToRenderer("binance:market-status", data);
});

client.on("market-error", (data) => {
  sendToRenderer("binance:market-error", data);
});

client.on("user-data-event", (data) => {
  sendToRenderer("binance:user-data-event", data);
  showUserDataNotification(data);
});

client.on("user-data-status", (data) => {
  sendToRenderer("binance:user-data-status", data);
});

client.on("user-data-error", (data) => {
  sendToRenderer("binance:user-data-error", data);
});

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
