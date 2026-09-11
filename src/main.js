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
  shouldShowWindowImmediately,
} = require("./platformSupport");
const {
  SharedRateLimitCoordinator,
} = require("./sharedRateLimitCoordinator");
const {
  TradingRoundStore,
  compareRoundsNewestFirst,
} = require("./tradingRoundStore");
const {
  CLIENT_VERSION,
  ManagerClientService,
  getAccountChoices,
  getAccountApiKey,
  mergeManagerAccountInfo,
  resolveSelectedAccount,
  sanitizeManagerUserInfo,
} = require("./managerClientService");
const { buildAccountOverview } = require("./accountOverview");
const {
  isDevelopmentMode,
  openDevelopmentTools,
  startDevelopmentRendererHotReload,
} = require("./developmentHotReload");
const {
  BinanceAccountMetricsService,
} = require("./binanceAccountMetricsService");
const {
  registerWindowLoadFallbacks,
  revealBrowserWindow,
} = require("./windowLifecycle");
const {
  buildPositionSnapshot,
  invalidatePositionSnapshot,
  mergePositionSnapshots,
} = require("./positionSafety");
const { resolveCancelOrderRequest } = require("./cancelOrderResolver");
const { resolveDefaultTestnet } = require("./environmentSelection");

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
let loginWindow = null;
let latestBinanceLatency = null;
let runtimeAccountCredentials = null;
let runtimeBrokerLinkIds = null;
let authenticatedManagerSession = null;
let authenticatedManagerUserInfo = null;
let authenticatedManagerLoginResponse = null;
let pendingManagerLogin = null;
let latestBinanceAccountMetrics = null;
let latestBinancePositionSnapshot = null;
let positionInvalidationVersion = 0;
let criticalPositionRefreshTimer = null;
let criticalPositionRefreshPromise = null;
let criticalPositionRefreshClient = null;
let criticalPositionRefreshRequestedVersion = 0;
let accountMetricsRefreshPromise = null;
let accountMetricsRefreshClient = null;
let accountMetricsRefreshMode = null;
let accountMetricsRefreshTimer = null;
let accountMetricsInterval = null;
let accountMetricsScheduledReconcileHistory = false;
let incomeReconciliationPromise = null;
let incomeReconciliationClient = null;
let lastAccountMetricsHistoryRefreshAt = 0;
let managerTradingInfoSyncPromise = null;
let managerTradingInfoSyncTimer = null;
let managerTradingInfoSyncInterval = null;
let tradingRoundPriceBackfillPromise = null;
let tradingRoundPriceBackfillClient = null;
let stopDevelopmentHotReload = () => {};
const defaultTestnet = resolveDefaultTestnet(process.env);
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
const accountMetricsService = new BinanceAccountMetricsService();
const rateLimitCoordinator = new SharedRateLimitCoordinator(
  path.join(app.getPath("appData"), "Binance统一交易台", "rate-limits"),
  { instanceId: instanceId || `pid-${process.pid}` }
);
const unknownOrderReconciliationTimers = new Set();
const ACCOUNT_METRICS_REFRESH_MS = 2_000;
// 成交事件由 WebSocket 增量维护；完整 24 小时历史只用于定期对账。
const ACCOUNT_METRICS_HISTORY_REFRESH_MS = 5 * 60_000;
const MANAGER_TRADING_INFO_SYNC_MS = 2_000;
const MAX_ROUND_PRICE_BACKFILL_ORDERS_PER_RUN = 200;
const FUTURES_MARKET_TYPE = "futures";
const CONFIRMED_OPEN_ORDER_STATUSES = new Set([
  "NEW",
  "PARTIALLY_FILLED",
  "PENDING_CANCEL",
]);
let futuresDeadManState = null;
const managerClientService = new ManagerClientService({
  fetchImpl: (url, options) => net.fetch(url, options),
});

function fingerprintApiKey(apiKey) {
  const value = String(apiKey || "");
  if (!value) return "";
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function getOrderStoreContext(
  targetClient,
  { defaultStatus, submissionSource, source } = {}
) {
  const marketClient = targetClient.getClient();
  return {
    environment: targetClient.testnet ? "testnet" : "production",
    accountFingerprint: fingerprintApiKey(marketClient.apiKey),
    marketType: FUTURES_MARKET_TYPE,
    defaultStatus,
    submissionSource,
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
    "cancelResult",
    "newOrderResult",
  ]) {
    if (payload[field]) collectOrderCandidates(payload[field], target);
  }
  return target;
}

function trackOrderPayload(
  payload,
  {
    targetClient = client,
    defaultStatus,
    submissionSource,
    source,
  } = {}
) {
  const saved = [];
  const affectedRoundIds = new Set();
  for (const order of collectOrderCandidates(payload)) {
    const storeContext = getOrderStoreContext(
      targetClient,
      { defaultStatus, submissionSource, source }
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
  if (saved.length && targetClient === client && latestBinanceAccountMetrics) {
    latestBinanceAccountMetrics = {
      ...latestBinanceAccountMetrics,
      orderVolume: countConfirmedOpenOrders(targetClient),
    };
    publishPositionMetrics(latestBinanceAccountMetrics, {
      targetClient,
      positionEvidenceVersion:
        latestBinancePositionSnapshot?.positionEvidenceVersion || 0,
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
        });
        trackOrderPayload(order, {
          targetClient,
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
  const accountFingerprint = fingerprintApiKey(targetClient.getClient().apiKey);
  if (!accountFingerprint) return [];
  return recentOrderStore.list({
    environment: targetClient.testnet ? "testnet" : "production",
    accountFingerprints: [accountFingerprint],
    marketType: FUTURES_MARKET_TYPE,
    symbol: payload.symbol,
  }).sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
}

function listTradingRounds(payload = {}, targetClient = client) {
  const accountFingerprint = fingerprintApiKey(targetClient.getClient().apiKey);
  if (!accountFingerprint) return [];
  return tradingRoundStore.list({
    environment: targetClient.testnet ? "testnet" : "production",
    accountFingerprints: [accountFingerprint],
    marketType: FUTURES_MARKET_TYPE,
    symbol: payload.symbol,
  }).sort(compareRoundsNewestFirst);
}

function listKnownOrderSymbols(targetClient = client) {
  const marketClient = targetClient.getClient();
  const accountFingerprint = fingerprintApiKey(marketClient.apiKey);
  if (!accountFingerprint) return [];
  return [...new Set(recentOrderStore.list({
    environment: targetClient.testnet ? "testnet" : "production",
    accountFingerprints: [accountFingerprint],
    marketType: FUTURES_MARKET_TYPE,
  }).map((order) => order.symbol).filter(Boolean))];
}

function countConfirmedOpenOrders(targetClient = client) {
  return listRecentOrders({}, targetClient).filter((order) =>
    CONFIRMED_OPEN_ORDER_STATUSES.has(String(order?.status || "").toUpperCase())
  ).length;
}

async function backfillTradingRoundPrices(
  knownOrders = [],
  targetClient = client
) {
  if (tradingRoundPriceBackfillPromise) {
    if (tradingRoundPriceBackfillClient === targetClient) {
      return tradingRoundPriceBackfillPromise;
    }
    try {
      await tradingRoundPriceBackfillPromise;
    } catch {
      // 环境或账户切换时，旧客户端的回填结果不应阻止新客户端继续。
    }
  }

  const backfillPromise = (async () => {
    const environment = targetClient.testnet ? "testnet" : "production";
    const affectedRoundIds = new Set();
    const accountFingerprint = fingerprintApiKey(targetClient.getClient().apiKey);
    if (!accountFingerprint) {
      return {
        affectedRoundIds: [],
        queriedOrderCount: 0,
        fetchedOrderCount: 0,
        failedCount: 0,
        remainingReferenceCount: 0,
      };
    }
    const context = {
      environment,
      accountFingerprint,
      marketType: FUTURES_MARKET_TYPE,
    };
    const knownResult = tradingRoundStore.backfillExecutionPricing(
      knownOrders,
      context
    );
    for (const roundId of knownResult.affectedRoundIds) {
      affectedRoundIds.add(roundId);
    }

    const references = tradingRoundStore.listMissingPricingOrderReferences({
      environment,
      accountFingerprints: [accountFingerprint],
      marketType: FUTURES_MARKET_TYPE,
    });
    const selectedReferences = references.slice(
      0,
      MAX_ROUND_PRICE_BACKFILL_ORDERS_PER_RUN
    );
    const fetchedOrders = [];
    let failedCount = 0;
    for (let index = 0; index < selectedReferences.length; index += 4) {
      const batch = selectedReferences.slice(index, index + 4);
      const results = await Promise.allSettled(batch.map(async (reference) => {
        const order = await targetClient.queryOrder({
          symbol: reference.symbol,
          orderId: reference.orderId,
          origClientOrderId: reference.origClientOrderId,
        });
        const normalizedOrder = {
          ...order,
          marketType: FUTURES_MARKET_TYPE,
        };
        if (reference.roundIds.length <= 1) return [normalizedOrder];
        try {
          const trades = await targetClient.myTrades({
            symbol: reference.symbol,
            orderId: normalizedOrder.actualOrderId || normalizedOrder.orderId,
            limit: 1_000,
          });
          if (!Array.isArray(trades) || !trades.length) {
            return [normalizedOrder];
          }
          return trades.map((trade) => ({
            ...normalizedOrder,
            ...trade,
            marketType: FUTURES_MARKET_TYPE,
            orderId: trade.orderId ?? normalizedOrder.orderId,
            actualOrderId:
              normalizedOrder.actualOrderId ?? trade.actualOrderId,
            side: normalizedOrder.side || trade.side || (
              trade.isBuyer === true || trade.buyer === true ? "BUY" : "SELL"
            ),
            executedQty: trade.qty ?? trade.quantity,
            cumulativeQuoteQty: trade.quoteQty,
            updateTime: trade.time ?? trade.timestamp ?? normalizedOrder.updateTime,
            reduceOnly: normalizedOrder.reduceOnly,
            positionEffect: normalizedOrder.positionEffect,
          }));
        } catch {
          return [normalizedOrder];
        }
      }));
      for (const result of results) {
        if (result.status === "fulfilled") fetchedOrders.push(...result.value);
        else failedCount += 1;
      }
    }

    const fetchedResult = tradingRoundStore.backfillExecutionPricing(
      fetchedOrders,
      context
    );
    for (const roundId of fetchedResult.affectedRoundIds) {
      affectedRoundIds.add(roundId);
    }
    if (affectedRoundIds.size && targetClient === client) {
      sendToRenderer("binance:trading-rounds-update", {
        rounds: listTradingRounds({}, targetClient).filter((round) =>
          affectedRoundIds.has(round.id)
        ),
        partial: true,
        reason: "historical-price-backfill",
        time: Date.now(),
      });
    }
    return {
      affectedRoundIds: [...affectedRoundIds],
      queriedOrderCount: selectedReferences.length,
      fetchedOrderCount: fetchedOrders.length,
      failedCount,
      remainingReferenceCount: Math.max(
        0,
        references.length - selectedReferences.length
      ),
    };
  })().finally(() => {
    if (tradingRoundPriceBackfillPromise === backfillPromise) {
      tradingRoundPriceBackfillPromise = null;
      tradingRoundPriceBackfillClient = null;
    }
  });
  tradingRoundPriceBackfillPromise = backfillPromise;
  tradingRoundPriceBackfillClient = targetClient;
  return backfillPromise;
}

async function syncRecentAccountOrders(payload = {}, targetClient = client) {
  const endTime = Date.now();
  const startTime = recent24HourCutoff(endTime);
  const knownFuturesSymbols = listKnownOrderSymbols(targetClient);
  if (payload.symbol) {
    knownFuturesSymbols.push(payload.symbol);
  }

  const result = await targetClient.recentAccountOrders({
    startTime,
    endTime,
    limit: 1_000,
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
  const tradingRoundPriceBackfill = await backfillTradingRoundPrices(
    chronologicalOrders,
    targetClient
  );
  return {
    ...result,
    orders: listRecentOrders({}, targetClient),
    tradingRoundPriceBackfill,
  };
}

function getFuturesCredentials(testnet) {
  if (runtimeAccountCredentials) {
    return {
      ...runtimeAccountCredentials,
      source: "MANAGER_ACCOUNT",
    };
  }

  const prefix = testnet ? "BINANCE_TESTNET" : "BINANCE_PRODUCTION";
  return {
    apiKey: process.env[`${prefix}_FUTURES_API_KEY`] || "",
    apiSecret: process.env[`${prefix}_FUTURES_API_SECRET`] || "",
    source: `${prefix}_FUTURES`,
  };
}

function createBinanceClient(testnet) {
  const futuresCredentials = getFuturesCredentials(testnet);
  return new BinanceUnifiedClient({
    futuresCredentials,
    testnet,
    depthSpeed: process.env.BINANCE_DEPTH_SPEED || "100ms",
    futuresBrokerLinkId:
      runtimeBrokerLinkIds?.BINANCE_FUTURES_LINK_ID ||
      process.env.BINANCE_FUTURES_LINK_ID || "",
    expectedFuturesTradeGroupId:
      process.env.BINANCE_FUTURES_EXPECTED_TRADE_GROUP_ID || "",
    rateLimitCoordinator,
    publicMarketFetch: (url, options) => net.fetch(url, options),
    preflightBalanceCheck:
      process.env.BINANCE_PREFLIGHT_BALANCE_CHECK === "true",
  });
}

let client = null;

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 820,
    resizable: true,
    show: shouldShowWindowImmediately(),
    backgroundColor: "#111111",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  const targetWindow = mainWindow;
  registerWindowLoadFallbacks(targetWindow, "主窗口");
  mainWindow.webContents.on("did-finish-load", () => {
    openDevelopmentTools(mainWindow, {
      enabled: isDevelopmentMode({
        isPackaged: app.isPackaged,
      }),
    });
    if (latestBinanceLatency) {
      sendToRenderer("binance:latency-update", latestBinanceLatency);
    }
    sendAccountOverviewToRenderer();
    const activeClient = client;
    if (hasTradingCredentials(activeClient)) {
      connectUserDataInBackground(activeClient);
    }
  });
  void targetWindow.loadFile(path.join(__dirname, "index.html")).catch((error) => {
    process.stderr.write(`[窗口加载失败] 主窗口：${error.message}\n`);
    revealBrowserWindow(targetWindow);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return loginWindow;
  }
  loginWindow = new BrowserWindow({
    width: 520,
    height: 520,
    minWidth: 440,
    minHeight: 460,
    resizable: true,
    show: shouldShowWindowImmediately(),
    backgroundColor: "#111111",
    webPreferences: {
      preload: path.join(__dirname, "loginPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const targetWindow = loginWindow;
  registerWindowLoadFallbacks(targetWindow, "登录窗口");
  loginWindow.webContents.on("did-finish-load", () => {
    openDevelopmentTools(loginWindow, {
      enabled: isDevelopmentMode({
        isPackaged: app.isPackaged,
      }),
    });
  });
  void targetWindow.loadFile(path.join(__dirname, "login.html")).catch((error) => {
    process.stderr.write(`[窗口加载失败] 登录窗口：${error.message}\n`);
    revealBrowserWindow(targetWindow);
  });
  loginWindow.on("closed", () => {
    loginWindow = null;
    pendingManagerLogin = null;
  });
  return loginWindow;
}

function getManagerAccountSummary(loginResponse, userInfo, account, device) {
  return {
    id: userInfo.vtpUserId ?? loginResponse.id,
    userNm: userInfo.vtpUserNm ?? loginResponse.userNm,
    userAccount: loginResponse.userAccount ?? userInfo.vtpUserAccount,
    groupId: userInfo.groupId ?? loginResponse.groupId,
    locked: loginResponse.locked ?? userInfo.vtpLocked,
    thrRealProfit:
      loginResponse.thrRealProfit ?? userInfo.vtpThrRealProfit,
    realProfit: loginResponse.realProfit ?? userInfo.realProfit,
    futureAccountId: account.id,
    futureUserName: account.futureUserName,
    clientVersion: CLIENT_VERSION,
    networkInterface: device.name,
    userMAC: device.mac,
  };
}

async function enterTradingConsole(loginResponse, userInfo, account, device) {
  const apiKey = getAccountApiKey(account);
  const apiSecret = String(account.futureUserPwd || "").trim();
  if (!apiKey || !apiSecret) {
    throw new TypeError("所选账号缺少 Binance API Key 或 Secret。");
  }

  const tradingConfiguration =
    await managerClientService.getTradingConfiguration();
  runtimeAccountCredentials = { apiKey, apiSecret };
  runtimeBrokerLinkIds = tradingConfiguration;

  const nextClient = createBinanceClient(defaultTestnet);
  client = nextClient;
  bindClientEvents(nextClient);
  let initializationWarning = null;
  try {
    await nextClient.initialize();
  } catch (error) {
    initializationWarning = serializeError(error);
  }

  authenticatedManagerSession = getManagerAccountSummary(
    loginResponse,
    userInfo,
    account,
    device
  );
  authenticatedManagerUserInfo = sanitizeManagerUserInfo(
    userInfo,
    String(account.futureUserName || "")
  );
  authenticatedManagerLoginResponse = loginResponse;
  pendingManagerLogin = null;
  createWindow();
  startAccountMetricsRefresh();
  startManagerTradingInfoSync();
  setImmediate(() => {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
  });
  return {
    authenticated: true,
    account: authenticatedManagerSession,
    initializationWarning,
  };
}

function getUserDataEventStatus(event = {}) {
  if (event.e === "executionReport") {
    return event.X || event.x || "订单状态已更新";
  }
  if (event.e === "ACCOUNT_UPDATE") {
    return "U 本位账户已更新";
  }
  if (event.e === "eventStreamTerminated") {
    return "账户事件流已终止";
  }
  return event.X || event.x || "已收到";
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

function hasTradingCredentials(targetClient = client) {
  return Boolean(
    targetClient?.futures?.apiKey && targetClient?.futures?.apiSecret
  );
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getAccountMetricsContext(targetClient = client) {
  const futuresApiKey = targetClient?.futures?.apiKey;
  return {
    environment: targetClient?.testnet ? "testnet" : "production",
    accountFingerprint: fingerprintApiKey(futuresApiKey),
  };
}

function getPositionScope(targetClient = client) {
  return {
    ...getAccountMetricsContext(targetClient),
    accountName: targetClient === client
      ? authenticatedManagerSession?.futureUserName || ""
      : "",
    futureAccountId: targetClient === client
      ? String(authenticatedManagerSession?.futureAccountId ?? "")
      : "",
  };
}

function getDisplayedManagerUserInfo() {
  if (!authenticatedManagerUserInfo) return null;
  const metrics = latestBinanceAccountMetrics;
  return {
    ...authenticatedManagerUserInfo,
    binanceMetricsStatus: metrics ? {
      complete: metrics.complete !== false,
      environment: metrics.environment,
      updatedAt: metrics.updatedAt,
      warnings: metrics.warnings,
    } : null,
    accounts: (authenticatedManagerUserInfo.accounts || []).map((account) => {
      if (!account.selected || !metrics) return { ...account };
      return {
        ...account,
        staticBalance: metrics.staticBalance,
        balance: metrics.balance,
        available: metrics.available,
        margin: metrics.margin,
        positionProfit: metrics.positionProfit,
        closeProfit: metrics.closeProfit,
        realProfit: metrics.realProfit,
        openVolume: metrics.openVolume,
        orderVolume: metrics.orderVolume,
        qryCommission: metrics.commission,
        metricsCurrency: metrics.currency,
        metricsUpdatedAt: metrics.updatedAt,
      };
    }),
  };
}

function getAccountOverview() {
  return buildAccountOverview({
    session: authenticatedManagerSession,
    userInfo: getDisplayedManagerUserInfo(),
    latency: latestBinanceLatency,
    accountMetrics: latestBinanceAccountMetrics,
  });
}

function sendAccountDataToRenderer() {
  sendToRenderer("manager:user-info-update", getDisplayedManagerUserInfo());
  sendToRenderer("manager:account-overview-update", getAccountOverview());
}

function sendAccountOverviewToRenderer() {
  sendAccountDataToRenderer();
}

function buildCurrentPositionsPayload(
  metrics = latestBinanceAccountMetrics,
  {
    targetClient = client,
    positionEvidenceVersion = 0,
  } = {}
) {
  const next = buildPositionSnapshot(metrics, {
    ...getPositionScope(targetClient),
    positionEvidenceVersion,
  });
  return targetClient === client
    ? mergePositionSnapshots(latestBinancePositionSnapshot, next)
    : next;
}

function publishPositionMetrics(
  metrics,
  {
    targetClient = client,
    positionEvidenceVersion = 0,
  } = {}
) {
  const next = buildPositionSnapshot(metrics, {
    ...getPositionScope(targetClient),
    positionEvidenceVersion,
  });
  if (targetClient !== client) return next;
  latestBinancePositionSnapshot = mergePositionSnapshots(
    latestBinancePositionSnapshot,
    next
  );
  sendToRenderer("binance:positions-update", latestBinancePositionSnapshot);
  return latestBinancePositionSnapshot;
}

function applyPositionMetricsToAccountMetrics(targetClient, metrics) {
  if (!latestBinanceAccountMetrics || targetClient !== client || !metrics) {
    return;
  }
  const positions = Array.isArray(metrics.positions) ? metrics.positions : [];
  const positionSource =
    metrics.positionSources?.futures || metrics.positionSource || null;
  latestBinanceAccountMetrics = {
    ...latestBinanceAccountMetrics,
    positions,
    positionsComplete: metrics.positionsComplete === true,
    positionsUpdatedAt: metrics.positionsUpdatedAt || null,
    positionSources: { futures: positionSource },
    openVolume: positions.length,
    futures: {
      ...latestBinanceAccountMetrics.futures,
      positions,
      openPositionCount: positions.length,
      positionsUpdatedAt: metrics.positionsUpdatedAt || null,
    },
  };
}

function invalidateCurrentPositionSnapshot(
  reason = "成交后正在复核 U 本位持仓",
  targetClient = client
) {
  if (targetClient !== client) return null;
  positionInvalidationVersion += 1;
  const base = latestBinancePositionSnapshot || buildPositionSnapshot(
    latestBinanceAccountMetrics,
    getPositionScope(targetClient)
  );
  latestBinancePositionSnapshot = invalidatePositionSnapshot(base, {
    ...getPositionScope(targetClient),
    invalidationVersion: positionInvalidationVersion,
    reason,
  });
  sendToRenderer("binance:positions-update", latestBinancePositionSnapshot);
  return latestBinancePositionSnapshot;
}

function stopCriticalPositionRefresh() {
  clearTimeout(criticalPositionRefreshTimer);
  criticalPositionRefreshTimer = null;
  criticalPositionRefreshRequestedVersion = 0;
}

async function refreshCriticalPositions(targetClient = client) {
  if (!targetClient || !authenticatedManagerSession) return null;
  if (criticalPositionRefreshPromise) {
    if (criticalPositionRefreshClient === targetClient) {
      return criticalPositionRefreshPromise;
    }
    // 环境或账号已经切换时直接启动新范围的查询。旧 Promise 的回调均有
    // targetClient 校验，等待它只会把旧网络超时传导到新账户首屏。
  }
  const context = getAccountMetricsContext(targetClient);
  if (!context.accountFingerprint) return null;
  const evidenceVersion = positionInvalidationVersion;
  const refreshPromise = accountMetricsService.refreshPositions({
    client: targetClient,
    ...context,
  }).then((metrics) => {
    if (targetClient !== client) return metrics;
    applyPositionMetricsToAccountMetrics(targetClient, metrics);
    publishPositionMetrics(metrics, {
      targetClient,
      positionEvidenceVersion: evidenceVersion,
    });
    sendAccountDataToRenderer();
    return metrics;
  }).catch((error) => {
    if (targetClient === client) sendPositionRefreshFailure(error);
    throw error;
  }).finally(() => {
    if (criticalPositionRefreshPromise !== refreshPromise) return;
    criticalPositionRefreshPromise = null;
    criticalPositionRefreshClient = null;
    if (
      targetClient === client &&
      criticalPositionRefreshRequestedVersion > evidenceVersion
    ) {
      scheduleCriticalPositionRefresh(0, targetClient);
    }
  });
  criticalPositionRefreshPromise = refreshPromise;
  criticalPositionRefreshClient = targetClient;
  return refreshPromise;
}

function scheduleCriticalPositionRefresh(
  delayMs = 0,
  targetClient = client
) {
  if (!targetClient || targetClient !== client) return;
  criticalPositionRefreshRequestedVersion = Math.max(
    criticalPositionRefreshRequestedVersion,
    positionInvalidationVersion
  );
  clearTimeout(criticalPositionRefreshTimer);
  criticalPositionRefreshTimer = setTimeout(() => {
    criticalPositionRefreshTimer = null;
    refreshCriticalPositions(targetClient).catch((error) => {
      if (targetClient !== client) return;
      sendToRenderer("manager:account-metrics-status", {
        status: "error",
        operation: "positionRisk",
        error: serializeError(error),
        time: Date.now(),
      });
    });
  }, Math.max(0, Number(delayMs) || 0));
  criticalPositionRefreshTimer.unref?.();
}

function sendPositionRefreshFailure(error) {
  const failed = {
    ...buildCurrentPositionsPayload(),
    complete: false,
    attemptedAt: Date.now(),
    error: serializeError(error),
    positionConfirmationRequired: true,
  };
  latestBinancePositionSnapshot = mergePositionSnapshots(
    latestBinancePositionSnapshot,
    failed
  );
  sendToRenderer("binance:positions-update", latestBinancePositionSnapshot);
}

async function refreshBinanceAccountMetrics(
  targetClient = client,
  { reconcileHistory = true } = {}
) {
  if (!targetClient || !authenticatedManagerSession) return null;
  const context = getAccountMetricsContext(targetClient);
  if (!context.accountFingerprint) return null;
  if (reconcileHistory) {
    reconcileBinanceIncome(targetClient).catch((error) => {
      if (targetClient !== client) return;
      sendToRenderer("manager:account-metrics-status", {
        status: "error",
        operation: "income-history",
        error: serializeError(error),
        time: Date.now(),
      });
    });
  }
  if (accountMetricsRefreshPromise) {
    if (accountMetricsRefreshClient === targetClient) {
      return accountMetricsRefreshPromise;
    }
    // 新客户端不等待旧客户端的网络请求；下面用 Promise 身份和客户端
    // 身份同时隔离结果，避免跨环境串写。
  }

  const positionEvidenceVersion = positionInvalidationVersion;

  const refreshPromise = accountMetricsService.refresh({
    client: targetClient,
    ...context,
    // 收益历史可能有多页，独立对账并在完成后单独发布，不能阻塞
    // 账户资金和持仓的快速刷新。
    reconcileHistory: false,
    openOrderCount: countConfirmedOpenOrders(targetClient),
  }).then((metrics) => {
    if (targetClient !== client) return metrics;
    latestBinanceAccountMetrics = metrics;
    sendAccountDataToRenderer();
    publishPositionMetrics(metrics, {
      targetClient,
      positionEvidenceVersion,
    });
    sendToRenderer("manager:account-metrics-status", {
      status: "updated",
      updatedAt: metrics.updatedAt,
      currency: metrics.currency,
      warnings: metrics.warnings,
      reconcileHistory: false,
    });
    return metrics;
  }).finally(() => {
    if (accountMetricsRefreshPromise === refreshPromise) {
      accountMetricsRefreshPromise = null;
      accountMetricsRefreshClient = null;
      accountMetricsRefreshMode = null;
    }
  });
  accountMetricsRefreshPromise = refreshPromise;
  accountMetricsRefreshClient = targetClient;
  accountMetricsRefreshMode = "light";
  return refreshPromise;
}

async function reconcileBinanceIncome(targetClient = client) {
  if (!targetClient || !authenticatedManagerSession) return null;
  if (incomeReconciliationPromise) {
    if (incomeReconciliationClient === targetClient) {
      return incomeReconciliationPromise;
    }
    // 收益历史可能分页或超时，切换后的账户必须立即开始自己的对账，
    // 不能被旧环境的请求阻塞。
  }
  const context = getAccountMetricsContext(targetClient);
  if (!context.accountFingerprint) return null;
  const reconciliationPromise = accountMetricsService.refreshIncome({
    client: targetClient,
    ...context,
    reconcileHistory: true,
  }).then((snapshot) => {
    if (targetClient !== client) return snapshot;
    if (snapshot.historyReconciled) {
      lastAccountMetricsHistoryRefreshAt = Date.now();
    }
    applyFuturesIncomeMetrics(targetClient, snapshot);
    sendToRenderer("manager:account-metrics-status", {
      status: "updated",
      operation: "income-history",
      updatedAt: snapshot.updatedAt,
      warnings: snapshot.warnings,
      reconcileHistory: snapshot.historyReconciled,
    });
    return snapshot;
  }).finally(() => {
    if (incomeReconciliationPromise === reconciliationPromise) {
      incomeReconciliationPromise = null;
      incomeReconciliationClient = null;
    }
  });
  incomeReconciliationPromise = reconciliationPromise;
  incomeReconciliationClient = targetClient;
  return reconciliationPromise;
}

function scheduleAccountMetricsRefresh(
  delayMs = 750,
  { reconcileHistory = false } = {}
) {
  accountMetricsScheduledReconcileHistory ||=
    Boolean(reconcileHistory);
  clearTimeout(accountMetricsRefreshTimer);
  accountMetricsRefreshTimer = setTimeout(() => {
    accountMetricsRefreshTimer = null;
    const shouldReconcileHistory = accountMetricsScheduledReconcileHistory;
    accountMetricsScheduledReconcileHistory = false;
    refreshBinanceAccountMetrics(client, {
      reconcileHistory: shouldReconcileHistory,
    }).catch((error) => {
      sendPositionRefreshFailure(error);
      sendToRenderer("manager:account-metrics-status", {
        status: "error",
        error: serializeError(error),
        time: Date.now(),
      });
    });
  }, delayMs);
  accountMetricsRefreshTimer.unref?.();
}

function stopAccountMetricsRefresh() {
  clearTimeout(accountMetricsRefreshTimer);
  accountMetricsRefreshTimer = null;
  accountMetricsScheduledReconcileHistory = false;
  clearInterval(accountMetricsInterval);
  accountMetricsInterval = null;
}

function startAccountMetricsRefresh({ reconcileHistory = true } = {}) {
  stopAccountMetricsRefresh();
  lastAccountMetricsHistoryRefreshAt = reconcileHistory ? 0 : Date.now();
  scheduleAccountMetricsRefresh(0, { reconcileHistory });
  accountMetricsInterval = setInterval(() => {
    scheduleAccountMetricsRefresh(0, {
      reconcileHistory:
        Date.now() - lastAccountMetricsHistoryRefreshAt >=
        ACCOUNT_METRICS_HISTORY_REFRESH_MS,
    });
  }, ACCOUNT_METRICS_REFRESH_MS);
  accountMetricsInterval.unref?.();
}

function stopManagerTradingInfoSync() {
  clearTimeout(managerTradingInfoSyncTimer);
  managerTradingInfoSyncTimer = null;
  clearInterval(managerTradingInfoSyncInterval);
  managerTradingInfoSyncInterval = null;
}

async function syncManagerTradingInfo() {
  if (managerTradingInfoSyncPromise) return managerTradingInfoSyncPromise;
  const targetClient = client;
  const session = authenticatedManagerSession;
  if (!targetClient || !session) return null;

  const syncPromise = (async () => {
    const metrics = await refreshBinanceAccountMetrics(targetClient, {
      reconcileHistory: false,
    });
    if (!metrics || targetClient !== client || session !== authenticatedManagerSession) {
      return null;
    }
    if (metrics.complete === false) {
      sendToRenderer("manager:trading-info-sync-status", {
        status: "skipped",
        reason: "Binance 账户指标不完整，本周期不覆盖管理端数据。",
        warnings: metrics.warnings,
        metricsUpdatedAt: metrics.updatedAt,
        time: Date.now(),
      });
      return null;
    }
    const response = await managerClientService.updateFutureAccountTradingInfo({
      id: session.futureAccountId,
      staticBalance: metrics.staticBalance,
      balance: metrics.balance,
      available: metrics.available,
      closeProfit: metrics.closeProfit,
      commission: metrics.commission,
      deviation: metrics.deviation,
      margin: metrics.margin,
      openVolume: metrics.openVolume,
      orderVolume: metrics.orderVolume,
      positionProfit: metrics.positionProfit,
      realProfit: metrics.realProfit,
    });
    sendToRenderer("manager:trading-info-sync-status", {
      status: "synced",
      accountId: session.futureAccountId,
      environment: targetClient.testnet ? "testnet" : "production",
      metricsUpdatedAt: metrics.updatedAt,
      syncedAt: Date.now(),
    });
    return response;
  })().catch((error) => {
    sendToRenderer("manager:trading-info-sync-status", {
      status: "error",
      error: serializeError(error),
      time: Date.now(),
    });
    return null;
  }).finally(() => {
    if (managerTradingInfoSyncPromise === syncPromise) {
      managerTradingInfoSyncPromise = null;
    }
  });
  managerTradingInfoSyncPromise = syncPromise;
  return syncPromise;
}

function startManagerTradingInfoSync() {
  stopManagerTradingInfoSync();
  managerTradingInfoSyncTimer = setTimeout(() => {
    managerTradingInfoSyncTimer = null;
    syncManagerTradingInfo();
  }, 0);
  managerTradingInfoSyncTimer.unref?.();
  managerTradingInfoSyncInterval = setInterval(() => {
    syncManagerTradingInfo();
  }, MANAGER_TRADING_INFO_SYNC_MS);
  managerTradingInfoSyncInterval.unref?.();
}

function applyFuturesIncomeMetrics(targetClient, snapshot) {
  if (!snapshot || !latestBinanceAccountMetrics || targetClient !== client) {
    return;
  }
  const incomeComplete = snapshot.incomeComplete === true ||
    (snapshot.incomeComplete === undefined && snapshot.complete === true);
  const incomeOperations = new Set([
    "income history",
    "income metrics",
    "executionReport income",
    "ACCOUNT_UPDATE funding",
  ]);
  const incomeWarnings = Array.isArray(snapshot.warnings)
    ? snapshot.warnings.map((warning) => ({ ...warning }))
    : [];
  if (snapshot.error) incomeWarnings.push({ ...snapshot.error });
  if (Array.isArray(snapshot.unsupportedAssets) && snapshot.unsupportedAssets.length) {
    incomeWarnings.push({
      marketType: FUTURES_MARKET_TYPE,
      operation: "income metrics",
      name: "UnsupportedIncomeAssetWarning",
      message: `以下收益资产尚未折算为 USDT：${snapshot.unsupportedAssets.join(", ")}`,
    });
  }
  const retainedWarnings = (latestBinanceAccountMetrics.warnings || [])
    .filter((warning) => !incomeOperations.has(warning?.operation));
  const warnings = [...retainedWarnings, ...incomeWarnings]
    .filter((warning, index, rows) => rows.findIndex((candidate) =>
      candidate?.operation === warning?.operation &&
      candidate?.name === warning?.name &&
      candidate?.message === warning?.message
    ) === index);
  const accountComplete = latestBinanceAccountMetrics.accountComplete === true;
  const positionsComplete = latestBinanceAccountMetrics.positionsComplete === true;
  latestBinanceAccountMetrics = {
    ...latestBinanceAccountMetrics,
    closeProfit: snapshot.realizedPnl24h,
    commission: snapshot.commission24h,
    realProfit: snapshot.actualPnl24h,
    incomeComplete,
    complete: accountComplete && positionsComplete && incomeComplete,
    warnings,
    futures: {
      ...latestBinanceAccountMetrics.futures,
      realizedPnl24h: snapshot.realizedPnl24h,
      commission24h: snapshot.commission24h,
      fundingFee24h: snapshot.fundingFee24h,
      actualPnl24h: snapshot.actualPnl24h,
      realizedIncomeCount: snapshot.count,
      realizedIncomeUpdatedAt: snapshot.updatedAt,
      incomeComplete,
    },
    updatedAt: Date.now(),
  };
  sendAccountDataToRenderer();
}

function ingestFuturesExecutionMetrics(targetClient, event) {
  const snapshot = accountMetricsService.ingestFuturesExecution({
    ...getAccountMetricsContext(targetClient),
    event,
  });
  applyFuturesIncomeMetrics(targetClient, snapshot);
  return snapshot;
}

function ingestFuturesAccountUpdateMetrics(targetClient, event) {
  const snapshot = accountMetricsService.ingestFuturesAccountUpdate({
    ...getAccountMetricsContext(targetClient),
    event,
  });
  if (!snapshot) return null;
  if (snapshot.incomeUpdated) {
    applyFuturesIncomeMetrics(targetClient, snapshot);
  }
  if (snapshot.positionsUpdated || snapshot.positionError) {
    const positionMetrics = {
      ...snapshot,
      environment: getAccountMetricsContext(targetClient).environment,
      accountFingerprint:
        getAccountMetricsContext(targetClient).accountFingerprint,
      positionSources: { futures: snapshot.positionSource },
      warnings: snapshot.positionError ? [snapshot.positionError] : [],
      orderVolume: countConfirmedOpenOrders(targetClient),
    };
    applyPositionMetricsToAccountMetrics(targetClient, positionMetrics);
    publishPositionMetrics(positionMetrics, {
      targetClient,
      positionEvidenceVersion: positionInvalidationVersion,
    });
    sendAccountDataToRenderer();
  }
  return snapshot;
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
    clientVersion: CLIENT_VERSION,
    managerAccount: authenticatedManagerSession,
    managerUserInfo: getDisplayedManagerUserInfo(),
    accountMetrics: latestBinanceAccountMetrics,
    accountOverview: getAccountOverview(),
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
  stopAccountMetricsRefresh();
  stopCriticalPositionRefresh();
  stopManagerTradingInfoSync();
  clearFuturesDeadManTimer();
  const nextClient = createBinanceClient(testnet);
  bindClientEvents(nextClient);
  client = nextClient;
  latestBinanceLatency = null;
  latestBinanceAccountMetrics = null;
  latestBinancePositionSnapshot = null;
  positionInvalidationVersion += 1;
  sendToRenderer("binance:latency-update", null);
  publishPositionMetrics(null, { targetClient: nextClient });
  sendAccountOverviewToRenderer();
  previousClient.close();

  let initializationWarning = null;
  try {
    await nextClient.initialize();
  } catch (error) {
    initializationWarning = serializeError(error);
  }
  if (hasTradingCredentials(nextClient)) {
    connectUserDataInBackground(nextClient);
  }
  startAccountMetricsRefresh();
  startManagerTradingInfoSync();

  return {
    ...getClientStatus(),
    switched: true,
    reused: false,
    initializationWarning,
  };
}

function registerIpcHandlers() {
  ipcMain.handle("manager:login-context", async () => {
    return safeCall(async () => {
      const device = managerClientService.getDeviceIdentity();
      return {
        clientVersion: CLIENT_VERSION,
        networkInterface: device.name,
        userMAC: device.mac,
      };
    });
  });

  ipcMain.handle("manager:login", async (_event, payload) => {
    return safeCall(async () => {
      pendingManagerLogin = null;
      const { response, userInfo, device } = await managerClientService.login({
        userNm: payload?.userNm,
        userPwd: payload?.userPwd,
      });
      const accounts = getAccountChoices(userInfo);
      if (accounts.length === 1) {
        const account = resolveSelectedAccount(userInfo, accounts[0].accountKey);
        return enterTradingConsole(response, userInfo, account, device);
      }

      const selectionToken = crypto.randomUUID();
      pendingManagerLogin = {
        selectionToken,
        response,
        userInfo,
        device,
      };
      return {
        authenticated: false,
        requiresSelection: true,
        selectionToken,
        accounts,
      };
    });
  });

  ipcMain.handle("manager:select-account", async (_event, payload) => {
    return safeCall(async () => {
      if (
        !pendingManagerLogin ||
        payload?.selectionToken !== pendingManagerLogin.selectionToken
      ) {
        throw new TypeError("账号选择已失效，请重新登录。");
      }
      const { response, userInfo, device } = pendingManagerLogin;
      const account = resolveSelectedAccount(userInfo, payload?.accountKey);
      return enterTradingConsole(response, userInfo, account, device);
    });
  });

  ipcMain.handle("manager:user-info", async () => {
    return safeCall(async () => {
      if (!authenticatedManagerSession || !client) {
        throw new TypeError("当前客户端尚未登录管理端。");
      }
      const rawUserInfo = await managerClientService.getUserInfo();
      const userInfo = mergeManagerAccountInfo(
        authenticatedManagerLoginResponse || {},
        rawUserInfo
      );
      authenticatedManagerUserInfo = sanitizeManagerUserInfo(
        userInfo,
        authenticatedManagerSession.futureUserName
      );
      await refreshBinanceAccountMetrics(client);
      sendAccountDataToRenderer();
      return getDisplayedManagerUserInfo();
    });
  });

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
    return safeCall(async () => client.connectDepth(payload?.symbol, {
      depthLevels: payload?.depthLevels,
    }));
  });

  ipcMain.handle("binance:set-depth-levels", async (_event, payload) => {
    return safeCall(async () => client.setDepthLevels(payload?.depthLevels));
  });

  ipcMain.handle("binance:disconnect-market", async () => {
    return safeCall(async () => {
      client.disconnectMarket();
      return { disconnected: true };
    });
  });

  ipcMain.handle("binance:place-order", async (_event, payload) => {
    const { triggerSource, ...order } = payload || {};
    const submissionSource = String(triggerSource || "unknown")
      .replace(/[^A-Za-z0-9:_-]/g, "")
      .slice(0, 64) || "unknown";
    return safeCall(() => trackOrderCall(
      () => client.placeOrder(order),
      {
        defaultStatus: "ACKNOWLEDGED",
        submissionSource,
        source: "place-order",
      }
    ));
  });

  ipcMain.handle("binance:test-order", async (_event, payload) => {
    return safeCall(() => client.placeOrder(payload || {}, { testOnly: true }));
  });

  ipcMain.handle("binance:cancel-order", async (_event, payload) => {
    return safeCall(() => {
      const cancelRequest = resolveCancelOrderRequest(
        payload || {},
        listRecentOrders({}, client)
      );
      return trackOrderCall(
        () => client.cancelOrder(cancelRequest),
        { defaultStatus: "CANCELED", source: "cancel-order" }
      );
    });
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

  ipcMain.handle("binance:close-all-positions", async () => {
    return safeCall(async () => {
      const targetClient = client;
      const pausedBackgroundRefresh = targetClient === client;
      if (pausedBackgroundRefresh) {
        // 清仓期间暂停高频账户刷新和管理端同步，避免它们争用 Binance
        // 请求权重；清仓任务结束后会立即恢复。
        stopAccountMetricsRefresh();
        stopManagerTradingInfoSync();
      }
      let result;
      try {
        result = await trackOrderCall(
          () => targetClient.closeAllPositions(),
          {
            targetClient,
            defaultStatus: "ACKNOWLEDGED",
            submissionSource: "shortcut:close-all-positions",
            source: "close-all-positions",
          }
        );
      } finally {
        if (targetClient === client) {
          startAccountMetricsRefresh({ reconcileHistory: false });
          startManagerTradingInfoSync();
        }
      }
      if (!result.verifiedFlat) {
        const remainingPositionCount = result.remainingFuturesPositions?.length || 0;
        const remainingOpenOrderCount = result.remainingOpenOrders?.length || 0;
        const error = new Error(
          "未能确认全部 U 本位持仓已平：" +
          `剩余 U 本位持仓 ${remainingPositionCount} 项，` +
          `剩余挂单 ${remainingOpenOrderCount} 笔。` +
          (result.markets?.futures?.error
            ? "U 本位清仓流程未完成，剩余数量可能不完整。"
            : "") +
          "请查看失败明细并重新查询当前持仓。"
        );
        error.name = "CloseAllPositionsIncompleteError";
        error.data = result;
        throw error;
      }
      return result;
    });
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
    return safeCall(async () => {
      await backfillTradingRoundPrices(listRecentOrders({}, client), client);
      return listTradingRounds(payload || {});
    });
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

  ipcMain.handle("binance:current-positions", async () => {
    return safeCall(async () => {
      await refreshCriticalPositions(client);
      return latestBinancePositionSnapshot || buildCurrentPositionsPayload();
    });
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
        sendAccountOverviewToRenderer();
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

  targetClient.on("close-all-progress", (data) => {
    if (targetClient === client) {
      sendToRenderer("binance:close-all-progress", data);
    }
  });

  targetClient.on("order-state-update", (data) => {
    if (targetClient !== client) return;
    trackOrderPayload(data, {
      targetClient,
      source: "order-attempt",
    });
  });

  targetClient.on("user-data-event", (data) => {
    if (targetClient !== client) return;
    if (data.event?.e === "TRADE_LITE") {
      // TRADE_LITE 是 Binance 更早送达的精简成交信号。它不包含完整的
      // 收益/手续费字段，只用于立即让旧持仓失效并启动关键持仓复核；
      // 实际盈亏仍由后续 ORDER_TRADE_UPDATE 精确入账。
      invalidateCurrentPositionSnapshot(
        "收到 U 本位快速成交信号，正在重新确认持仓",
        targetClient
      );
      scheduleCriticalPositionRefresh(0, targetClient);
    }
    if (data.event?.e === "executionReport") {
      const isTrade = String(data.event.x || "").toUpperCase() === "TRADE";
      if (isTrade) {
        invalidateCurrentPositionSnapshot(
          "收到 U 本位成交，正在重新确认持仓",
          targetClient
        );
        scheduleCriticalPositionRefresh(0, targetClient);
      }
      trackOrderPayload(data.event, {
        targetClient,
        source: "user-data-stream",
      });
      ingestFuturesExecutionMetrics(targetClient, {
        ...data.event,
        marketType: FUTURES_MARKET_TYPE,
      });
      if (isTrade) scheduleAccountMetricsRefresh(500);
    }
    if (data.event?.e === "ACCOUNT_UPDATE") {
      ingestFuturesAccountUpdateMetrics(targetClient, {
        ...data.event,
        marketType: FUTURES_MARKET_TYPE,
      });
    }
    if (data.event?.e === "ACCOUNT_UPDATE") {
      scheduleAccountMetricsRefresh(500);
    }
    sendToRenderer("binance:user-data-event", data);
    showUserDataNotification(data);
  });

  targetClient.on("user-data-status", (data) => {
    if (targetClient !== client) return;
    sendToRenderer("binance:user-data-status", data);
    if (["connected", "reconnected"].includes(data.status)) {
      scheduleCriticalPositionRefresh(0, targetClient);
      refreshBinanceAccountMetrics(targetClient, {
        reconcileHistory: true,
      }).catch((error) => {
        if (targetClient !== client) return;
        sendToRenderer("manager:account-metrics-status", {
          status: "error",
          operation: "user-data-reconnect-reconciliation",
          error: serializeError(error),
          time: Date.now(),
        });
      });
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

registerIpcHandlers();

app.whenReady().then(() => {
  createLoginWindow();
  stopDevelopmentHotReload = startDevelopmentRendererHotReload({
    enabled: isDevelopmentMode({ isPackaged: app.isPackaged }),
    sourceDirectory: __dirname,
    reloadMainWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        process.stdout.write("[热更新] 正在刷新主窗口。\n");
        mainWindow.webContents.reloadIgnoringCache();
      }
    },
    reloadLoginWindow: () => {
      if (loginWindow && !loginWindow.isDestroyed()) {
        process.stdout.write("[热更新] 正在刷新登录窗口。\n");
        loginWindow.webContents.reloadIgnoringCache();
      }
    },
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (authenticatedManagerSession && client) {
        createWindow();
      } else {
        createLoginWindow();
      }
    }
  });
});

app.on("before-quit", () => {
  stopDevelopmentHotReload();
  stopAccountMetricsRefresh();
  stopCriticalPositionRefresh();
  stopManagerTradingInfoSync();
  clearFuturesDeadManTimer();
  for (const timer of unknownOrderReconciliationTimers) clearTimeout(timer);
  unknownOrderReconciliationTimers.clear();
  recentOrderStore.close();
  tradingRoundStore.close();
  accountMetricsService.close();
  rateLimitCoordinator.close();
  client?.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
