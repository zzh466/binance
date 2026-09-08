const { addDecimal } = require("./binance/decimalMath");

function displayValue(value, fallback = "-") {
  return value === undefined || value === null || value === ""
    ? fallback
    : String(value);
}

function sumRealProfit(accounts = []) {
  let total = "0";
  for (const account of accounts) {
    const value = account?.realProfit;
    if (value === undefined || value === null || value === "") continue;
    try {
      total = addDecimal(total, value);
    } catch {
      // 单个管理端异常值不应导致整个账号信息窗口无法显示。
    }
  }
  return total;
}

function classifyBinanceLatency(latency) {
  const elapsedMs = Number(latency?.elapsedMs);
  const receivedBinanceResponse =
    latency?.status !== undefined &&
    latency?.status !== null &&
    Number.isFinite(Number(latency.status));
  if (
    (latency?.success !== true && !receivedBinanceResponse) ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0
  ) {
    return {
      label: "离线",
      tone: "offline",
      elapsedMs: null,
    };
  }
  if (elapsedMs <= 70) {
    return { label: "在线", tone: "fast", elapsedMs };
  }
  if (elapsedMs <= 120) {
    return { label: "在线", tone: "medium", elapsedMs };
  }
  return { label: "在线", tone: "slow", elapsedMs };
}

function getManagementAccountStatus(session, selectedAccount, userInfo) {
  if (session?.locked === true || userInfo?.vtpLocked === true) return "锁定";
  const status = String(selectedAccount?.futureAccountStatus || "").trim();
  if (!status || status.toUpperCase() === "NORMAL") return "正常";
  return status;
}

function buildAccountOverview({
  session,
  userInfo,
  latency,
  accountMetrics,
} = {}) {
  if (!session) return null;
  const accounts = Array.isArray(userInfo?.accounts) ? userInfo.accounts : [];
  const selectedAccount = accounts.find((account) => account.selected) ||
    accounts.find(
      (account) => account.futureUserName === session.futureUserName
    ) || null;
  const connection = classifyBinanceLatency(latency);
  const binanceRealProfit = displayValue(accountMetrics?.realProfit);

  return {
    account: displayValue(session.userAccount),
    managementStatus: getManagementAccountStatus(
      session,
      selectedAccount,
      userInfo
    ),
    currentAccount: displayValue(
      selectedAccount?.futureUserName ?? session.futureUserName
    ),
    connectionStatus: connection.label,
    connectionTone: connection.tone,
    connectionLatencyMs: connection.elapsedMs,
    commission: displayValue(selectedAccount?.qryCommission),
    currentAccountProfit: binanceRealProfit,
    settlementError: "0",
    actualProfit: binanceRealProfit,
    liquidationLine: displayValue(session.thrRealProfit),
    availableFunds: displayValue(accountMetrics?.available),
    totalActualProfit: displayValue(session.realProfit),
    metricsUpdatedAt: accountMetrics?.updatedAt ?? null,
    metricsCurrency: accountMetrics?.currency || "USDT",
    metricsWarnings: Array.isArray(accountMetrics?.warnings)
      ? accountMetrics.warnings
      : [],
  };
}

module.exports = {
  buildAccountOverview,
  classifyBinanceLatency,
  sumRealProfit,
};
