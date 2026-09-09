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
const { addDecimal } = require("./binance/decimalMath");

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
let accountMetricsRefreshPromise = null;
let accountMetricsRefreshClient = null;
let accountMetricsRefreshMode = null;
let accountMetricsRefreshTimer = null;
let accountMetricsInterval = null;
let managerTradingInfoSyncPromise = null;
let managerTradingInfoSyncTimer = null;
let managerTradingInfoSyncInterval = null;
let tradingRoundPriceBackfillPromise = null;
let tradingRoundPriceBackfillClient = null;
let stopDevelopmentHotReload = () => {};
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
const accountMetricsService = new BinanceAccountMetricsService({
  storePath: path.join(app.getPath("userData"), "spot-pnl-ledger.json"),
});
const rateLimitCoordinator = new SharedRateLimitCoordinator(
  path.join(app.getPath("appData"), "Binance统一交易台", "rate-limits"),
  { instanceId: instanceId || `pid-${process.pid}` }
);
const unknownOrderReconciliationTimers = new Set();
const ACCOUNT_METRICS_REFRESH_MS = 30_000;
const MANAGER_TRADING_INFO_SYNC_MS = 2_000;
const MAX_ROUND_PRICE_BACKFILL_ORDERS_PER_RUN = 200;
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
  marketType,
  { defaultStatus, submissionSource, source } = {}
) {
  const marketClient = targetClient.getClient(marketType);
  return {
    environment: targetClient.testnet ? "testnet" : "production",
    accountFingerprint: fingerprintApiKey(marketClient.apiKey),
    marketType,
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
  {
    targetClient = client,
    marketType,
    defaultStatus,
    submissionSource,
    source,
  } = {}
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
    const contexts = new Map();
    const affectedRoundIds = new Set();
    for (const marketType of ["spot", "futures"]) {
      const accountFingerprint = fingerprintApiKey(
        targetClient.getClient(marketType).apiKey
      );
      if (!accountFingerprint) continue;
      const context = { environment, accountFingerprint, marketType };
      contexts.set(marketType, context);
      const knownResult = tradingRoundStore.backfillExecutionPricing(
        knownOrders.filter((order) => order.marketType === marketType),
        context
      );
      for (const roundId of knownResult.affectedRoundIds) {
        affectedRoundIds.add(roundId);
      }
    }

    const references = [];
    for (const [marketType, context] of contexts) {
      references.push(...tradingRoundStore.listMissingPricingOrderReferences({
        environment,
        accountFingerprints: [context.accountFingerprint],
        marketType,
      }));
    }
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
          marketType: reference.marketType,
        });
        const normalizedOrder = {
          ...order,
          marketType: reference.marketType,
        };
        if (reference.roundIds.length <= 1) return [normalizedOrder];
        try {
          const trades = await targetClient.myTrades({
            symbol: reference.symbol,
            orderId: normalizedOrder.actualOrderId || normalizedOrder.orderId,
            limit: 1_000,
            marketType: reference.marketType,
          });
          if (!Array.isArray(trades) || !trades.length) {
            return [normalizedOrder];
          }
          return trades.map((trade) => ({
            ...normalizedOrder,
            ...trade,
            marketType: reference.marketType,
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

    for (const [marketType, context] of contexts) {
      const fetchedResult = tradingRoundStore.backfillExecutionPricing(
        fetchedOrders.filter((order) => order.marketType === marketType),
        context
      );
      for (const roundId of fetchedResult.affectedRoundIds) {
        affectedRoundIds.add(roundId);
      }
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

function getEnvironmentCredentials(testnet) {
  if (runtimeAccountCredentials) {
    return {
      ...runtimeAccountCredentials,
      source: "MANAGER_ACCOUNT",
    };
  }

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
  if (runtimeAccountCredentials) {
    return {
      ...runtimeAccountCredentials,
      source: "MANAGER_ACCOUNT（Spot 与 USDⓈ-M 共用）",
    };
  }

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
    spotBrokerLinkId:
      runtimeBrokerLinkIds?.BINANCE_SPOT_LINK_ID ||
      process.env.BINANCE_SPOT_LINK_ID || "",
    futuresBrokerLinkId:
      runtimeBrokerLinkIds?.BINANCE_FUTURES_LINK_ID ||
      process.env.BINANCE_FUTURES_LINK_ID || "",
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

function revealBrowserWindow(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return false;
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.show();
  targetWindow.focus();
  return true;
}

function registerWindowLoadFallbacks(targetWindow, label) {
  targetWindow.once("ready-to-show", () => revealBrowserWindow(targetWindow));
  targetWindow.webContents.once("did-finish-load", () => {
    revealBrowserWindow(targetWindow);
  });
  targetWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      process.stderr.write(
        `[窗口加载失败] ${label}：${errorDescription || "未知错误"}` +
        `（${errorCode || "无错误码"}）${validatedURL ? ` ${validatedURL}` : ""}\n`
      );
      revealBrowserWindow(targetWindow);
    }
  );
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
    if (hasAnyTradingCredentials(activeClient)) {
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

function getAccountMetricsContext(targetClient = client) {
  const spotApiKey = targetClient?.spot?.apiKey;
  const futuresApiKey = targetClient?.futures?.apiKey;
  return {
    environment: targetClient?.testnet ? "testnet" : "production",
    accountFingerprint: fingerprintApiKey(spotApiKey || futuresApiKey),
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
      spotTradeCount: metrics.spot?.tradeHistory?.tradeCount || 0,
      spotCommission: metrics.spot?.commission24h,
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

function buildCurrentPositionsPayload(metrics = latestBinanceAccountMetrics) {
  return {
    positions: Array.isArray(metrics?.positions) ? metrics.positions : [],
    environment: metrics?.environment || (client.testnet ? "testnet" : "production"),
    updatedAt: metrics?.updatedAt || null,
    complete: metrics?.positionsComplete !== false,
    warnings: Array.isArray(metrics?.warnings) ? metrics.warnings : [],
  };
}

async function refreshBinanceAccountMetrics(
  targetClient = client,
  { reconcileHistory = true } = {}
) {
  if (!targetClient || !authenticatedManagerSession) return null;
  if (accountMetricsRefreshPromise) {
    if (
      accountMetricsRefreshClient === targetClient &&
      (!reconcileHistory || accountMetricsRefreshMode === "full")
    ) {
      return accountMetricsRefreshPromise;
    }
    try {
      await accountMetricsRefreshPromise;
    } catch {
      // 环境切换时旧客户端的刷新结果不应阻止新客户端立即刷新。
    }
    return refreshBinanceAccountMetrics(targetClient, { reconcileHistory });
  }

  const context = getAccountMetricsContext(targetClient);
  if (!context.accountFingerprint) return null;
  const knownSpotSymbols = listKnownOrderSymbols("spot", targetClient);
  if (
    targetClient.activeMarketType === "spot" &&
    targetClient.activeSymbol
  ) {
    knownSpotSymbols.push(targetClient.activeSymbol);
  }

  const refreshPromise = accountMetricsService.refresh({
    client: targetClient,
    ...context,
    knownSpotSymbols: [...new Set(knownSpotSymbols)],
    reconcileHistory,
    openOrderCount: countConfirmedOpenOrders(targetClient),
  }).then((metrics) => {
    if (targetClient !== client) return metrics;
    latestBinanceAccountMetrics = metrics;
    sendAccountDataToRenderer();
    sendToRenderer("binance:positions-update", buildCurrentPositionsPayload(metrics));
    sendToRenderer("manager:account-metrics-status", {
      status: "updated",
      updatedAt: metrics.updatedAt,
      currency: metrics.currency,
      warnings: metrics.warnings,
      reconcileHistory: metrics.historyReconciled,
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
  accountMetricsRefreshMode = reconcileHistory ? "full" : "light";
  return refreshPromise;
}

function scheduleAccountMetricsRefresh(delayMs = 750) {
  clearTimeout(accountMetricsRefreshTimer);
  accountMetricsRefreshTimer = setTimeout(() => {
    accountMetricsRefreshTimer = null;
    refreshBinanceAccountMetrics(client).catch((error) => {
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
  clearInterval(accountMetricsInterval);
  accountMetricsInterval = null;
}

function startAccountMetricsRefresh() {
  stopAccountMetricsRefresh();
  scheduleAccountMetricsRefresh(0);
  accountMetricsInterval = setInterval(() => {
    scheduleAccountMetricsRefresh(0);
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

function ingestSpotExecutionMetrics(targetClient, event) {
  const context = getAccountMetricsContext(targetClient);
  const snapshot = accountMetricsService.ingestSpotExecution({
    ...context,
    event,
  });
  if (!snapshot || !latestBinanceAccountMetrics || targetClient !== client) {
    return;
  }
  latestBinanceAccountMetrics = {
    ...latestBinanceAccountMetrics,
    closeProfit: addDecimal(
      snapshot.realizedPnl24h,
      latestBinanceAccountMetrics.futures?.realizedPnl24h || "0"
    ),
    commission: addDecimal(
      snapshot.commission24h,
      latestBinanceAccountMetrics.futures?.commission24h || "0"
    ),
    realProfit: addDecimal(
      snapshot.realizedPnl24h,
      latestBinanceAccountMetrics.futures?.actualPnl24h || "0"
    ),
    positionProfit: addDecimal(
      snapshot.unrealizedProfit,
      latestBinanceAccountMetrics.futures?.unrealizedProfit || "0"
    ),
    openVolume: snapshot.openPositionCount +
      Number(latestBinanceAccountMetrics.futures?.openPositionCount || 0),
    orderVolume: countConfirmedOpenOrders(targetClient),
    spot: {
      ...latestBinanceAccountMetrics.spot,
      realizedPnl24h: snapshot.realizedPnl24h,
      commission24h: snapshot.commission24h,
      unrealizedProfit: snapshot.unrealizedProfit,
      openPositionCount: snapshot.openPositionCount,
      ledger: snapshot.ledger,
    },
    updatedAt: Date.now(),
  };
  sendAccountDataToRenderer();
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
  stopAccountMetricsRefresh();
  stopManagerTradingInfoSync();
  clearFuturesDeadManTimer();
  const nextClient = createBinanceClient(testnet);
  bindClientEvents(nextClient);
  client = nextClient;
  latestBinanceLatency = null;
  latestBinanceAccountMetrics = null;
  sendToRenderer("binance:latency-update", null);
  sendAccountOverviewToRenderer();
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
    return safeCall(async () => client.connectDepth(payload?.symbol));
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
      const metrics = await refreshBinanceAccountMetrics(client, {
        reconcileHistory: false,
      });
      return buildCurrentPositionsPayload(metrics);
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
      ingestSpotExecutionMetrics(targetClient, data.event);
      if (data.event.x === "TRADE") scheduleAccountMetricsRefresh(500);
    }
    if (
      [
        "outboundAccountPosition",
        "balanceUpdate",
        "ACCOUNT_UPDATE",
        "ORDER_TRADE_UPDATE",
      ].includes(
        data.event?.e
      )
    ) {
      scheduleAccountMetricsRefresh(500);
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
