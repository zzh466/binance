function serializePersistenceError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || "未知错误",
    code: error?.code,
  };
}

function publicAccountScope(scope = {}) {
  return {
    environment: String(scope.environment || ""),
    accountScope: String(scope.account || ""),
    accountScopeType: String(scope.accountScopeType || "unknown"),
  };
}

function resolveFuturesLeverageScope({
  testnet,
  futureAccountId,
  accountFingerprint,
} = {}) {
  const managerAccount = String(futureAccountId ?? "").trim();
  const fallbackFingerprint = String(accountFingerprint || "").trim();
  const account = managerAccount || fallbackFingerprint;
  if (!account) {
    throw new TypeError("当前账号没有可用于隔离杠杆配置的非敏感标识。");
  }
  return {
    environment: testnet ? "testnet" : "production",
    account,
    accountScopeType: managerAccount
      ? "futureAccountId"
      : "apiKeyFingerprint",
  };
}

function readCachedLeverage(store, scope) {
  try {
    const record = store.get(scope);
    return {
      cached: record
        ? { leverage: record.leverage, updatedAt: record.updatedAt }
        : null,
      persistence: {
        ok: true,
        found: Boolean(record),
        source: "appData",
      },
    };
  } catch (error) {
    return {
      cached: null,
      persistence: {
        ok: false,
        found: false,
        source: "appData",
        error: serializePersistenceError(error),
      },
    };
  }
}

function loadFuturesLeverageCache({ store, scope, symbol }) {
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  const cache = readCachedLeverage(store, {
    ...scope,
    symbol: normalizedSymbol,
  });
  return {
    marketType: "futures",
    symbol: normalizedSymbol,
    ...publicAccountScope(scope),
    ...cache,
    savedLeverage: cache.cached?.leverage ?? null,
    source: cache.cached ? "appData" : "none",
  };
}

async function queryFuturesLeverage({ client, store, scope, symbol }) {
  const cache = readCachedLeverage(store, { ...scope, symbol });
  const network = await client.leverageConfig(symbol);
  let savedRecord = null;
  let persistence;
  try {
    savedRecord = store.set(
      { ...scope, symbol: network.symbol },
      network.currentLeverage ?? network.leverage
    );
    persistence = {
      ok: true,
      saved: true,
      found: true,
      source: "appData",
      updatedAt: savedRecord.updatedAt,
    };
  } catch (error) {
    persistence = {
      ok: false,
      saved: false,
      found: Boolean(cache.cached),
      source: "appData",
      error: serializePersistenceError(error),
    };
  }
  return {
    ...network,
    ...publicAccountScope(scope),
    cached: cache.cached,
    persistence,
    savedLeverage:
      savedRecord?.leverage ?? cache.cached?.leverage ?? null,
    source: "binance",
  };
}

async function setFuturesLeverage({ client, store, scope, symbol, leverage }) {
  // Binance 必须先确认成功；任何 API 失败都会在触碰本地存储前直接抛出。
  const applied = await client.setLeverage(symbol, leverage);
  let record = null;
  let persistence;
  try {
    record = store.set(
      { ...scope, symbol: applied.symbol },
      applied.leverage
    );
    persistence = {
      ok: true,
      saved: true,
      source: "appData",
      updatedAt: record.updatedAt,
    };
  } catch (error) {
    // 远端已成功时不能把本地写盘问题误报成 Binance 设置失败。
    persistence = {
      ok: false,
      saved: false,
      source: "appData",
      error: serializePersistenceError(error),
    };
  }

  return {
    ...applied,
    ...publicAccountScope(scope),
    applied: true,
    cached: record
      ? { leverage: record.leverage, updatedAt: record.updatedAt }
      : null,
    savedLeverage: record?.leverage ?? null,
    source: "binance",
    persistence,
  };
}

module.exports = {
  loadFuturesLeverageCache,
  queryFuturesLeverage,
  readCachedLeverage,
  resolveFuturesLeverageScope,
  serializePersistenceError,
  setFuturesLeverage,
};
