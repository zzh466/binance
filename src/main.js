const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
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
  socks5Proxy: process.env.BINANCE_SOCKS5_PROXY,
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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.openDevTools()
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
  try {
    return {
      ok: true,
      data: await action(),
    };
  } catch (error) {
    return {
      ok: false,
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
      socks5Proxy: client.socks5Proxy,
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

  ipcMain.handle("binance:cancel-order", async (_event, payload) => {
    return safeCall(() => client.cancelOrder(payload || {}));
  });
}

client.on("depth-update", (data) => {
  sendToRenderer("binance:depth-update", data);
});

client.on("market-status", (data) => {
  sendToRenderer("binance:market-status", data);
});

client.on("market-error", (data) => {
  sendToRenderer("binance:market-error", data);
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
