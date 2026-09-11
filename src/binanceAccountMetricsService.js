const {
  addDecimal,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  subtractDecimal,
} = require("./binance/decimalMath");

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORY_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_RETRY_INTERVAL_MS = 30 * 1000;
const PROCESSED_EVENT_RETENTION_MS = 48 * 60 * 60 * 1000;
const POSITION_EVENT_RETENTION_MS = 60 * 1000;
const ACCOUNTING_ASSET = "USDT";

function firstPresent(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ""
  );
}

function safeDecimal(value, fallback = "0") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  try {
    addDecimal("0", text);
    return text;
  } catch {
    return fallback;
  }
}

function requiredDecimal(value, name) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new TypeError(`${name} 缺失`);
  }
  try {
    addDecimal("0", text);
  } catch {
    throw new TypeError(`${name} 不是有效的十进制数`);
  }
  return text;
}

function sumDecimals(values) {
  return values.reduce(
    (total, value) => addDecimal(total, safeDecimal(value)),
    "0"
  );
}

function negateDecimal(value) {
  return subtractDecimal("0", safeDecimal(value));
}

function absoluteDecimal(value) {
  const normalized = safeDecimal(value);
  return compareDecimal(normalized, "0") < 0
    ? subtractDecimal("0", normalized)
    : normalized;
}

function normalizeAccountingAmount(asset, value, unsupportedAssets) {
  const normalizedAsset = String(asset || ACCOUNTING_ASSET).toUpperCase();
  if (normalizedAsset !== ACCOUNTING_ASSET) {
    unsupportedAssets?.add(normalizedAsset);
    return null;
  }
  const amount = safeDecimal(value, "");
  return amount === "" ? null : amount;
}

function normalizePositionSide(value) {
  const normalized = String(value || "BOTH").trim().toUpperCase();
  if (!["BOTH", "LONG", "SHORT"].includes(normalized)) {
    throw new TypeError(`U 本位持仓 positionSide 无效：${normalized || "空值"}`);
  }
  return normalized;
}

function extractFuturesPositions(response) {
  if (Array.isArray(response)) return response;
  if (
    response &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    Array.isArray(response.positions)
  ) {
    return response.positions;
  }
  throw new TypeError("U 本位持仓响应缺少有效的 positions 数组");
}

function getFuturesPositionKey(position) {
  return `${position.symbol}:${position.positionSide}`;
}

function normalizeFuturesPosition(
  position,
  updatedAt = Date.now(),
  previous = null
) {
  if (!position || typeof position !== "object" || Array.isArray(position)) {
    throw new TypeError("U 本位持仓响应包含无效记录");
  }
  const symbolValue = firstPresent(position.symbol, position.s);
  const symbol = symbolValue == null
    ? ""
    : String(symbolValue).trim().toUpperCase();
  if (!symbol) throw new TypeError("U 本位持仓记录缺少 symbol");

  const signedAmount = requiredDecimal(
    firstPresent(position.positionAmt, position.pa),
    `${symbol} positionAmt`
  );
  const positionSide = normalizePositionSide(firstPresent(
    position.positionSide,
    position.ps,
    previous?.positionSide,
    "BOTH"
  ));
  const key = `${symbol}:${positionSide}`;
  if (compareDecimal(signedAmount, "0") === 0) {
    return { key, row: null };
  }

  const positionAmount = absoluteDecimal(signedAmount);
  const explicitNotional = safeDecimal(position.notional, "");
  const explicitMarkPrice = safeDecimal(position.markPrice, "");
  const previousMarkPrice = safeDecimal(previous?.markPrice, "");
  const markPrice = explicitMarkPrice || previousMarkPrice || null;
  const notionalUsdt = explicitNotional
    ? absoluteDecimal(explicitNotional)
    : markPrice
      ? absoluteDecimal(multiplyDecimal(positionAmount, markPrice))
      : "0";
  const derivedMarkPrice = compareDecimal(notionalUsdt, "0") > 0
    ? divideDecimal(notionalUsdt, positionAmount)
    : null;
  const positionUpdateTime = Number(firstPresent(
    position.updateTime,
    position.T,
    updatedAt
  ));
  const isolated = firstPresent(position.isolated, position.mt);
  const marginMode = isolated === true || isolated === "true" ||
    String(isolated || "").toLowerCase() === "isolated"
    ? "逐仓"
    : isolated === false || isolated === "false" ||
        String(isolated || "").toLowerCase() === "cross"
      ? "全仓"
      : previous?.marginMode || "全仓";
  const direction = positionSide === "LONG"
    ? "LONG"
    : positionSide === "SHORT"
      ? "SHORT"
      : compareDecimal(signedAmount, "0") > 0 ? "LONG" : "SHORT";

  return {
    key,
    row: {
      marketType: "futures",
      symbol,
      asset: symbol,
      side: direction,
      positionSide,
      positionAmount,
      availableAmount: null,
      lockedAmount: safeDecimal(firstPresent(
        position.positionInitialMargin,
        position.initialMargin,
        previous?.lockedAmount
      )),
      entryPrice: safeDecimal(firstPresent(
        position.entryPrice,
        position.ep,
        previous?.entryPrice
      ), "") || null,
      markPrice: markPrice || derivedMarkPrice,
      notionalUsdt,
      unrealizedPnl: safeDecimal(firstPresent(
        position.unrealizedProfit,
        position.unRealizedProfit,
        position.up,
        previous?.unrealizedPnl
      )),
      leverage: safeDecimal(firstPresent(
        position.leverage,
        previous?.leverage
      ), "") || null,
      marginMode,
      updateTime: Number.isFinite(positionUpdateTime) && positionUpdateTime > 0
        ? positionUpdateTime
        : updatedAt,
    },
  };
}

function sortFuturesPositionRows(rows) {
  return rows.sort((left, right) =>
    String(left.symbol).localeCompare(String(right.symbol)) ||
    String(left.positionSide).localeCompare(String(right.positionSide))
  );
}

function buildFuturesPositionRows(response, updatedAt = Date.now()) {
  const rows = [];
  for (const position of extractFuturesPositions(response)) {
    const normalized = normalizeFuturesPosition(position, updatedAt);
    if (normalized.row) rows.push(normalized.row);
  }
  return sortFuturesPositionRows(rows);
}

function summarizeFuturesIncome(entries = []) {
  let realizedPnl24h = "0";
  let commissionIncome24h = "0";
  let fundingFee24h = "0";
  const unsupportedAssets = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const income = normalizeAccountingAmount(
      entry?.asset,
      entry?.income,
      unsupportedAssets
    );
    if (income === null) continue;

    const incomeType = String(entry?.incomeType || "REALIZED_PNL").toUpperCase();
    if (incomeType === "REALIZED_PNL") {
      realizedPnl24h = addDecimal(realizedPnl24h, income);
    } else if (incomeType === "COMMISSION") {
      commissionIncome24h = addDecimal(commissionIncome24h, income);
    } else if (
      incomeType === "FUNDING_FEE" ||
      incomeType === "SPECIAL_FUNDING_FEE"
    ) {
      fundingFee24h = addDecimal(fundingFee24h, income);
    }
  }

  return {
    realizedPnl24h,
    commissionIncome24h,
    commission24h: negateDecimal(commissionIncome24h),
    fundingFee24h,
    actualPnl24h: sumDecimals([
      realizedPnl24h,
      commissionIncome24h,
      fundingFee24h,
    ]),
    unsupportedAssets: [...unsupportedAssets],
  };
}

function createEmptyIncomeSnapshot() {
  return {
    realizedPnl24h: "0",
    commissionIncome24h: "0",
    commission24h: "0",
    fundingFee24h: "0",
    actualPnl24h: "0",
    count: 0,
    updatedAt: null,
    reconciledAt: null,
    complete: false,
    unsupportedAssets: [],
    error: null,
  };
}

function buildFuturesAccountMetrics(
  account,
  updatedAt = Date.now(),
  positions = []
) {
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    throw new TypeError("U 本位账户响应无效");
  }
  const walletBalance = requiredDecimal(
    account.totalWalletBalance,
    "U 本位账户 totalWalletBalance"
  );
  const marginBalance = requiredDecimal(
    account.totalMarginBalance,
    "U 本位账户 totalMarginBalance"
  );
  const availableBalance = requiredDecimal(
    account.availableBalance,
    "U 本位账户 availableBalance"
  );
  const unrealizedProfit = requiredDecimal(
    account.totalUnrealizedProfit,
    "U 本位账户 totalUnrealizedProfit"
  );
  let initialMargin;
  if (firstPresent(account.totalInitialMargin) !== undefined) {
    initialMargin = requiredDecimal(
      account.totalInitialMargin,
      "U 本位账户 totalInitialMargin"
    );
  } else {
    initialMargin = addDecimal(
      requiredDecimal(
        account.totalPositionInitialMargin,
        "U 本位账户 totalPositionInitialMargin"
      ),
      requiredDecimal(
        account.totalOpenOrderInitialMargin,
        "U 本位账户 totalOpenOrderInitialMargin"
      )
    );
  }
  return {
    walletBalance,
    marginBalance,
    availableBalance,
    initialMargin,
    unrealizedProfit,
    openPositionCount: positions.length,
    positions,
    updatedAt,
  };
}

function cloneFuturesAccountMetrics(metrics) {
  if (!metrics) return null;
  return {
    ...metrics,
    positions: (metrics.positions || []).map((position) => ({ ...position })),
  };
}

function cloneFuturesPositionSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    ...snapshot,
    positions: (snapshot.positions || []).map((position) => ({ ...position })),
    error: snapshot.error ? { ...snapshot.error } : null,
  };
}

function cloneFuturesIncomeSnapshot(snapshot) {
  if (!snapshot) return createEmptyIncomeSnapshot();
  return {
    ...snapshot,
    unsupportedAssets: [...(snapshot.unsupportedAssets || [])],
    error: snapshot.error ? { ...snapshot.error } : null,
  };
}

function positionRowsAgree(leftRows, rightRows) {
  if (leftRows.length !== rightRows.length) return false;
  const rightByKey = new Map(
    rightRows.map((row) => [getFuturesPositionKey(row), row])
  );
  return leftRows.every((left) => {
    const right = rightByKey.get(getFuturesPositionKey(left));
    return Boolean(right) &&
      left.side === right.side &&
      compareDecimal(left.positionAmount, right.positionAmount) === 0;
  });
}

function mergePositionRows(primaryRows, supplementalRows) {
  const rowsByKey = new Map(
    primaryRows.map((row) => [getFuturesPositionKey(row), { ...row }])
  );
  for (const row of supplementalRows) {
    const key = getFuturesPositionKey(row);
    if (!rowsByKey.has(key)) rowsByKey.set(key, { ...row });
  }
  return sortFuturesPositionRows([...rowsByKey.values()]);
}

function applyFuturesPositionChanges(rows, changes, updatedAt) {
  if (!Array.isArray(changes)) {
    throw new TypeError("U 本位 ACCOUNT_UPDATE 的 a.P 不是数组");
  }
  const rowsByKey = new Map(
    (Array.isArray(rows) ? rows : []).map((row) => [
      getFuturesPositionKey(row),
      { ...row },
    ])
  );
  for (const change of changes) {
    const symbolValue = firstPresent(change?.symbol, change?.s);
    const symbol = symbolValue == null
      ? ""
      : String(symbolValue).trim().toUpperCase();
    const positionSide = normalizePositionSide(firstPresent(
      change?.positionSide,
      change?.ps,
      "BOTH"
    ));
    const key = `${symbol}:${positionSide}`;
    const normalized = normalizeFuturesPosition(
      change,
      updatedAt,
      rowsByKey.get(key)
    );
    if (normalized.row) {
      rowsByKey.set(normalized.key, normalized.row);
    } else {
      rowsByKey.delete(normalized.key);
    }
  }
  return sortFuturesPositionRows([...rowsByKey.values()]);
}

function serializeWarning(operation, error) {
  return {
    marketType: "futures",
    operation,
    name: error?.name || "Error",
    message: error?.message || "未知错误",
    status: error?.status,
    code: error?.code,
  };
}

function incomeTypeMatches(entryType, expectedType) {
  const normalized = String(entryType || "").toUpperCase();
  if (expectedType === "FUNDING_FEE") {
    return normalized === "FUNDING_FEE" ||
      normalized === "SPECIAL_FUNDING_FEE";
  }
  return normalized === expectedType;
}

function historyContainsIncomeDelta(entries, delta, incomeType, amount) {
  if (compareDecimal(amount, "0") === 0) return true;
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    if (!incomeTypeMatches(entry?.incomeType, incomeType)) return false;
    if (String(entry?.asset || ACCOUNTING_ASSET).toUpperCase() !== ACCOUNTING_ASSET) {
      return false;
    }
    const historyAmount = safeDecimal(entry?.income, "");
    if (!historyAmount || compareDecimal(historyAmount, amount) !== 0) {
      return false;
    }
    const entryTradeId = firstPresent(entry?.tradeId, entry?.tradeID);
    if (delta.tradeId !== undefined && entryTradeId !== undefined) {
      return String(entryTradeId) === String(delta.tradeId) &&
        (!delta.symbol || String(entry?.symbol || "").toUpperCase() === delta.symbol);
    }
    const entryTransactionId = firstPresent(entry?.tranId, entry?.transactionId);
    if (delta.transactionId !== undefined && entryTransactionId !== undefined) {
      return String(entryTransactionId) === String(delta.transactionId);
    }
    return Number(entry?.time) === Number(delta.eventTime) &&
      (!delta.symbol || !entry?.symbol ||
        String(entry.symbol).toUpperCase() === delta.symbol);
  });
}

function replayMissingIncomeDelta(income, entries, delta, historyEndTime) {
  let replayed = false;
  const afterRequestedWindow = Number(delta.eventTime) > Number(historyEndTime);
  const components = [
    ["realizedPnl24h", "REALIZED_PNL", delta.realizedPnl],
    ["commissionIncome24h", "COMMISSION", delta.commissionIncome],
    ["fundingFee24h", "FUNDING_FEE", delta.fundingFee],
  ];
  for (const [field, incomeType, amount] of components) {
    if (compareDecimal(amount, "0") === 0) continue;
    if (
      !afterRequestedWindow &&
      historyContainsIncomeDelta(entries, delta, incomeType, amount)
    ) {
      continue;
    }
    income[field] = addDecimal(income[field], amount);
    replayed = true;
  }
  if (replayed) income.count += 1;
  return replayed;
}

class BinanceAccountMetricsService {
  constructor({
    now = () => Date.now(),
    historyReconcileIntervalMs = HISTORY_RECONCILE_INTERVAL_MS,
    historyRetryIntervalMs = HISTORY_RETRY_INTERVAL_MS,
  } = {}) {
    this.now = now;
    this.historyReconcileIntervalMs = Math.max(
      0,
      Number(historyReconcileIntervalMs) || 0
    );
    this.historyRetryIntervalMs = Math.max(
      0,
      Number(historyRetryIntervalMs) || 0
    );
    this.futuresAccountCache = new Map();
    this.futuresPositionCache = new Map();
    this.futuresPositionRequestSequence = new Map();
    this.futuresPositionCommittedRequestSequence = new Map();
    this.processedFuturesPositionEvents = new Map();
    this.futuresPositionEventSequence = new Map();
    this.futuresPositionEventJournal = new Map();
    this.futuresIncomeCache = new Map();
    this.processedFuturesIncomeEvents = new Map();
    this.futuresIncomeEventSequence = new Map();
    this.futuresIncomeEventJournal = new Map();
    this.futuresIncomeLastAttemptAt = new Map();
  }

  getScopeKey(environment, accountFingerprint) {
    return `${environment}:${accountFingerprint}`;
  }

  getFuturesIncomeSnapshot(scopeKey) {
    return this.futuresIncomeCache.get(scopeKey) || createEmptyIncomeSnapshot();
  }

  markFuturesIncomeIncomplete(scopeKey, {
    unsupportedAssets = [],
    error = null,
  } = {}) {
    const previous = this.getFuturesIncomeSnapshot(scopeKey);
    const next = {
      ...previous,
      complete: false,
      unsupportedAssets: [...new Set([
        ...(previous.unsupportedAssets || []),
        ...unsupportedAssets,
      ])],
      error: error || previous.error || null,
    };
    this.futuresIncomeCache.set(scopeKey, next);
    return { ...next };
  }

  getFuturesPositionSnapshot(scopeKey) {
    return cloneFuturesPositionSnapshot(
      this.futuresPositionCache.get(scopeKey)
    );
  }

  recordFuturesPositionEvent(scopeKey, eventKey, eventTime, changes) {
    const now = this.now();
    const cutoff = now - POSITION_EVENT_RETENTION_MS;
    let processed = this.processedFuturesPositionEvents.get(scopeKey);
    if (!processed) {
      processed = new Map();
      this.processedFuturesPositionEvents.set(scopeKey, processed);
    }
    let journal = this.futuresPositionEventJournal.get(scopeKey);
    if (!journal) {
      journal = new Map();
      this.futuresPositionEventJournal.set(scopeKey, journal);
    }
    for (const [key, time] of processed) {
      if (time >= cutoff) continue;
      processed.delete(key);
      journal.delete(key);
    }
    if (processed.has(eventKey)) return null;

    const sequence = (this.futuresPositionEventSequence.get(scopeKey) || 0) + 1;
    this.futuresPositionEventSequence.set(scopeKey, sequence);
    processed.set(eventKey, Number(eventTime) || now);
    journal.set(eventKey, {
      sequence,
      eventTime,
      receivedAt: now,
      changes: changes.map((position) => ({ ...position })),
    });
    return sequence;
  }

  updateFuturesPositionCache(scopeKey, {
    eventKey,
    eventTime,
    changes,
  }) {
    // 先完整校验并计算一次，坏事件绝不能破坏最后一份有效快照。
    const previous = this.getFuturesPositionSnapshot(scopeKey);
    const nextRows = applyFuturesPositionChanges(
      previous?.positions || [],
      changes,
      eventTime
    );
    const sequence = this.recordFuturesPositionEvent(
      scopeKey,
      eventKey,
      eventTime,
      changes
    );
    if (sequence === null) return null;

    const next = {
      positions: nextRows,
      positionsUpdatedAt: this.now(),
      complete: previous?.complete === true,
      operation: "ACCOUNT_UPDATE",
      error: null,
      sequence,
    };
    this.futuresPositionCache.set(scopeKey, next);
    return cloneFuturesPositionSnapshot(next);
  }

  replaceFuturesPositionCache(scopeKey, {
    positions,
    operation,
    queryStartSequence = 0,
  }) {
    const refreshedAt = this.now();
    let rows = positions.map((position) => ({ ...position }));
    let positionsUpdatedAt = refreshedAt;
    let sequence = queryStartSequence;
    const journal = this.futuresPositionEventJournal.get(scopeKey);
    for (const delta of journal?.values() || []) {
      if (delta.sequence <= queryStartSequence) continue;
      rows = applyFuturesPositionChanges(rows, delta.changes, delta.eventTime);
      positionsUpdatedAt = Math.max(positionsUpdatedAt, delta.receivedAt);
      sequence = Math.max(sequence, delta.sequence);
    }
    const next = {
      positions: rows,
      positionsUpdatedAt,
      complete: true,
      operation,
      error: null,
      sequence,
    };
    this.futuresPositionCache.set(scopeKey, next);
    return cloneFuturesPositionSnapshot(next);
  }

  markFuturesPositionFailure(scopeKey, operation, error) {
    const previous = this.getFuturesPositionSnapshot(scopeKey);
    const next = {
      positions: previous?.positions || [],
      positionsUpdatedAt: previous?.positionsUpdatedAt || null,
      complete: false,
      operation,
      error: serializeWarning(operation, error),
      sequence: previous?.sequence || 0,
    };
    this.futuresPositionCache.set(scopeKey, next);
    return cloneFuturesPositionSnapshot(next);
  }

  recordFuturesIncomeEvent(scopeKey, eventKey, eventTime) {
    const now = this.now();
    const cutoff = now - PROCESSED_EVENT_RETENTION_MS;
    let processed = this.processedFuturesIncomeEvents.get(scopeKey);
    if (!processed) {
      processed = new Map();
      this.processedFuturesIncomeEvents.set(scopeKey, processed);
    }
    const journal = this.futuresIncomeEventJournal.get(scopeKey);
    for (const [key, time] of processed) {
      if (time >= cutoff) continue;
      processed.delete(key);
      journal?.delete(key);
    }
    if (processed.has(eventKey)) return null;
    processed.set(eventKey, Number(eventTime) || now);
    const sequence = (this.futuresIncomeEventSequence.get(scopeKey) || 0) + 1;
    this.futuresIncomeEventSequence.set(scopeKey, sequence);
    return sequence;
  }

  updateFuturesIncomeCache(scopeKey, {
    eventKey,
    eventTime,
    kind,
    symbol,
    tradeId,
    transactionId,
    realizedPnl = "0",
    commissionIncome = "0",
    fundingFee = "0",
  }) {
    const sequence = this.recordFuturesIncomeEvent(
      scopeKey,
      eventKey,
      eventTime
    );
    if (sequence === null) {
      return null;
    }

    let journal = this.futuresIncomeEventJournal.get(scopeKey);
    if (!journal) {
      journal = new Map();
      this.futuresIncomeEventJournal.set(scopeKey, journal);
    }
    journal.set(eventKey, {
      sequence,
      eventTime,
      kind,
      symbol,
      tradeId,
      transactionId,
      realizedPnl,
      commissionIncome,
      fundingFee,
    });

    const previous = this.getFuturesIncomeSnapshot(scopeKey);
    const next = {
      ...previous,
      realizedPnl24h: addDecimal(previous.realizedPnl24h, realizedPnl),
      commissionIncome24h: addDecimal(
        previous.commissionIncome24h,
        commissionIncome
      ),
      fundingFee24h: addDecimal(previous.fundingFee24h, fundingFee),
      count: Number(previous.count || 0) + 1,
      updatedAt: this.now(),
    };
    next.commission24h = negateDecimal(next.commissionIncome24h);
    next.actualPnl24h = sumDecimals([
      next.realizedPnl24h,
      next.commissionIncome24h,
      next.fundingFee24h,
    ]);
    this.futuresIncomeCache.set(scopeKey, next);
    return { ...next };
  }

  ingestFuturesExecution({ environment, accountFingerprint, event }) {
    const rawOrder = event?.rawEvent?.o || event?.o || {};
    const eventType = String(event?.e || "").toUpperCase();
    const executionType = String(firstPresent(event?.x, rawOrder.x, ""))
      .toUpperCase();
    const isTrade = (
      eventType === "EXECUTIONREPORT" || eventType === "ORDER_TRADE_UPDATE"
    ) && executionType === "TRADE";
    if (!isTrade) return null;

    const unsupportedAssets = new Set();
    const realizedAsset = String(
      firstPresent(event?.ma, rawOrder.ma, ACCOUNTING_ASSET)
    ).toUpperCase();
    const commissionAsset = String(
      firstPresent(event?.N, rawOrder.N, ACCOUNTING_ASSET)
    ).toUpperCase();
    const realizedPnl = normalizeAccountingAmount(
      realizedAsset,
      firstPresent(event?.rp, rawOrder.rp, "0"),
      unsupportedAssets
    );
    const commission = normalizeAccountingAmount(
      commissionAsset,
      firstPresent(event?.n, rawOrder.n, "0"),
      unsupportedAssets
    );
    const eventTimeValue = Number(firstPresent(
      event?.T,
      rawOrder.T,
      event?.E,
      this.now()
    ));
    const eventTime = Number.isFinite(eventTimeValue) && eventTimeValue > 0
      ? eventTimeValue
      : this.now();
    const symbol = String(firstPresent(event?.s, rawOrder.s, ""))
      .toUpperCase();
    const orderId = firstPresent(event?.i, rawOrder.i, "");
    const tradeId = firstPresent(event?.t, rawOrder.t);
    const eventIdentity = tradeId !== undefined
      ? [symbol, orderId, tradeId]
      : [
          symbol,
          orderId,
          eventTime,
          firstPresent(event?.l, rawOrder.l, ""),
          firstPresent(event?.rp, rawOrder.rp, ""),
          firstPresent(event?.n, rawOrder.n, ""),
        ];

    const scopeKey = this.getScopeKey(environment, accountFingerprint);
    let snapshot = null;
    if (realizedPnl !== null || commission !== null) {
      snapshot = this.updateFuturesIncomeCache(scopeKey, {
        eventKey: `trade:${eventIdentity.join(":")}`,
        eventTime,
        kind: "TRADE",
        symbol,
        tradeId: tradeId === undefined ? undefined : String(tradeId),
        realizedPnl: realizedPnl || "0",
        // 成交推送中的手续费是正数，收益历史中的 COMMISSION 是负数。
        commissionIncome: commission === null ? "0" : negateDecimal(commission),
      });
    }
    if (unsupportedAssets.size) {
      snapshot = this.markFuturesIncomeIncomplete(scopeKey, {
        unsupportedAssets: [...unsupportedAssets],
      });
    }
    if (
      (realizedPnl === null && realizedAsset === ACCOUNTING_ASSET) ||
      (commission === null && commissionAsset === ACCOUNTING_ASSET)
    ) {
      snapshot = this.markFuturesIncomeIncomplete(scopeKey, {
        error: serializeWarning(
          "executionReport income",
          new TypeError("U 本位成交事件包含无效的收益或手续费字段")
        ),
      });
    }
    return snapshot;
  }

  ingestFuturesAccountUpdate({ environment, accountFingerprint, event }) {
    const rawEvent = event?.rawEvent || event;
    if (String(rawEvent?.e || event?.e || "").toUpperCase() !== "ACCOUNT_UPDATE") {
      return null;
    }

    const accountUpdate = rawEvent?.a || event?.a;
    if (!accountUpdate || typeof accountUpdate !== "object") return null;
    const scopeKey = this.getScopeKey(environment, accountFingerprint);
    const eventTimeValue = Number(firstPresent(
      rawEvent?.T,
      event?.T,
      rawEvent?.E,
      event?.E,
      this.now()
    ));
    const eventTime = Number.isFinite(eventTimeValue) && eventTimeValue > 0
      ? eventTimeValue
      : this.now();
    let positionSnapshot = null;
    let positionError = null;
    let incomeSnapshot = null;

    if (Object.prototype.hasOwnProperty.call(accountUpdate, "P")) {
      if (!Array.isArray(accountUpdate.P)) {
        positionError = new TypeError(
          "U 本位 ACCOUNT_UPDATE 的 a.P 不是数组"
        );
      } else if (accountUpdate.P.length > 0) {
        const identity = accountUpdate.P
          .map((position) => [
            firstPresent(position?.s, position?.symbol, ""),
            firstPresent(position?.ps, position?.positionSide, "BOTH"),
            firstPresent(position?.pa, position?.positionAmt, ""),
            firstPresent(position?.ep, position?.entryPrice, ""),
            firstPresent(position?.up, position?.unrealizedProfit, ""),
          ].join(":"))
          .sort()
          .join(",");
        try {
          positionSnapshot = this.updateFuturesPositionCache(scopeKey, {
            eventKey: `position:${eventTime}:${identity}`,
            eventTime,
            changes: accountUpdate.P,
          });
        } catch (error) {
          positionError = error;
        }
      }
    }

    if (positionError) {
      positionSnapshot = this.markFuturesPositionFailure(
        scopeKey,
        "ACCOUNT_UPDATE",
        positionError
      );
    }

    if (String(accountUpdate.m || "").toUpperCase() === "FUNDING_FEE") {
      const unsupportedAssets = new Set();
      const balances = Array.isArray(accountUpdate.B) ? accountUpdate.B : [];
      const invalidSupportedBalance = balances.some((balance) =>
        String(balance?.a || ACCOUNTING_ASSET).toUpperCase() ===
          ACCOUNTING_ASSET &&
        safeDecimal(balance?.bc, "") === ""
      );
      const supportedChanges = balances
        .map((balance) => ({
          asset: String(balance?.a || ACCOUNTING_ASSET).toUpperCase(),
          amount: normalizeAccountingAmount(
            balance?.a,
            balance?.bc,
            unsupportedAssets
          ),
        }))
        .filter((change) => change.amount !== null);
      if (supportedChanges.length) {
        const fundingFee = sumDecimals(
          supportedChanges.map((change) => change.amount)
        );
        const identity = supportedChanges
          .map((change) => `${change.asset}:${change.amount}`)
          .sort()
          .join(",");
        const positionIdentity = (Array.isArray(accountUpdate.P)
          ? accountUpdate.P
          : [])
          .map((position) => [
            firstPresent(position?.s, position?.symbol, ""),
            firstPresent(position?.ps, position?.positionSide, "BOTH"),
          ].join(":"))
          .sort()
          .join(",");
        incomeSnapshot = this.updateFuturesIncomeCache(scopeKey, {
          eventKey: `funding:${eventTime}:${String(accountUpdate.S || "")}:${positionIdentity}:${identity}`,
          eventTime,
          kind: "FUNDING_FEE",
          fundingFee,
        });
      }
      if (unsupportedAssets.size) {
        incomeSnapshot = this.markFuturesIncomeIncomplete(scopeKey, {
          unsupportedAssets: [...unsupportedAssets],
        });
      }
      if (
        !Array.isArray(accountUpdate.B) ||
        balances.length === 0 ||
        invalidSupportedBalance
      ) {
        incomeSnapshot = this.markFuturesIncomeIncomplete(scopeKey, {
          error: serializeWarning(
            "ACCOUNT_UPDATE funding",
            new TypeError("U 本位资金费事件包含无效的 a.B/bc 字段")
          ),
        });
      }
    }

    if (!positionSnapshot && !incomeSnapshot) return null;
    const income = incomeSnapshot || this.getFuturesIncomeSnapshot(scopeKey);
    const positions = positionSnapshot || this.getFuturesPositionSnapshot(scopeKey);
    return {
      ...income,
      incomeUpdated: Boolean(incomeSnapshot),
      positionsUpdated: Boolean(positionSnapshot && !positionError),
      positions: positions?.positions || [],
      positionsComplete: positions?.complete === true,
      positionsUpdatedAt: positions?.positionsUpdatedAt || null,
      positionSource: positions ? {
        configured: true,
        ok: positions.complete === true && !positions.error,
        updatedAt: positions.positionsUpdatedAt || null,
        error: positions.error || null,
      } : null,
      positionError: positionError
        ? serializeWarning("ACCOUNT_UPDATE", positionError)
        : null,
    };
  }

  async refreshAccount({
    client,
    environment,
    accountFingerprint,
  }) {
    if (!client?.futures?.apiKey || !client?.futures?.apiSecret) {
      throw new Error("未配置 U 本位凭证");
    }
    const scopeKey = this.getScopeKey(environment, accountFingerprint);
    const updatedAt = this.now();
    const warnings = [];
    let response = null;
    let accountMetrics = null;
    let accountError = null;
    let accountPositions = null;
    let accountPositionsError = null;

    try {
      response = await client.futures.accountStatus({
        omitZeroBalances: false,
        critical: true,
      });
    } catch (error) {
      accountError = error;
    }

    if (response !== null) {
      try {
        accountMetrics = buildFuturesAccountMetrics(response, updatedAt);
        this.futuresAccountCache.set(scopeKey, accountMetrics);
      } catch (error) {
        accountError = error;
      }
      try {
        accountPositions = buildFuturesPositionRows(response, updatedAt);
      } catch (error) {
        accountPositionsError = error;
      }
    }

    if (accountError) {
      warnings.push(serializeWarning("account.status", accountError));
      accountMetrics = cloneFuturesAccountMetrics(
        this.futuresAccountCache.get(scopeKey)
      );
    } else {
      accountMetrics = cloneFuturesAccountMetrics(accountMetrics);
    }
    if (accountPositionsError) {
      warnings.push(serializeWarning(
        "account.status positions",
        accountPositionsError
      ));
    }

    return {
      environment,
      accountFingerprint,
      accountMetrics,
      accountComplete: accountError === null,
      accountUpdatedAt: accountMetrics?.updatedAt || null,
      accountError: accountError
        ? serializeWarning("account.status", accountError)
        : null,
      accountPositions: accountPositions?.map((position) => ({ ...position })) || [],
      accountPositionsComplete: accountPositionsError === null && response !== null,
      accountPositionsError: accountPositionsError
        ? serializeWarning("account.status positions", accountPositionsError)
        : null,
      warnings,
    };
  }

  async refreshPositions({
    client,
    environment,
    accountFingerprint,
  }) {
    if (!client?.futures?.apiKey || !client?.futures?.apiSecret) {
      throw new Error("未配置 U 本位凭证");
    }
    const scopeKey = this.getScopeKey(environment, accountFingerprint);
    const requestSequence =
      (this.futuresPositionRequestSequence.get(scopeKey) || 0) + 1;
    this.futuresPositionRequestSequence.set(scopeKey, requestSequence);
    const queryStartSequence =
      this.futuresPositionEventSequence.get(scopeKey) || 0;
    const hasDedicatedPositionQuery =
      typeof client.futures.positionRisk === "function";
    const operation = hasDedicatedPositionQuery
      ? "positionRisk"
      : "account.status";
    const buildResult = (snapshot, warnings = []) => {
      const snapshotOperation = snapshot?.operation || operation;
      return {
        environment,
        accountFingerprint,
        positions: snapshot?.positions || [],
        positionsComplete: snapshot?.complete === true,
        positionsUpdatedAt: snapshot?.positionsUpdatedAt || null,
        positionSources: {
          futures: {
            configured: true,
            ok: snapshot?.complete === true && !snapshot?.error,
            updatedAt: snapshot?.positionsUpdatedAt || null,
            operation: snapshotOperation,
            error: snapshot?.error || null,
          },
        },
        warnings,
      };
    };

    try {
      const response = hasDedicatedPositionQuery
        ? await client.futures.positionRisk({ critical: true })
        : await client.futures.accountStatus({
            omitZeroBalances: false,
            critical: true,
          });
      const positions = buildFuturesPositionRows(response, this.now());
      const committedRequestSequence =
        this.futuresPositionCommittedRequestSequence.get(scopeKey) || 0;
      if (requestSequence < committedRequestSequence) {
        // 较早请求晚返回时，直接采用已经提交的新快照，禁止旧响应回写。
        return buildResult(this.getFuturesPositionSnapshot(scopeKey));
      }
      this.futuresPositionCommittedRequestSequence.set(
        scopeKey,
        requestSequence
      );
      const snapshot = this.replaceFuturesPositionCache(scopeKey, {
        positions,
        operation,
        queryStartSequence,
      });
      return buildResult(snapshot);
    } catch (error) {
      const committedRequestSequence =
        this.futuresPositionCommittedRequestSequence.get(scopeKey) || 0;
      if (requestSequence < committedRequestSequence) {
        return buildResult(this.getFuturesPositionSnapshot(scopeKey));
      }
      this.futuresPositionCommittedRequestSequence.set(
        scopeKey,
        requestSequence
      );
      const snapshot = this.markFuturesPositionFailure(
        scopeKey,
        operation,
        error
      );
      const warning = serializeWarning(operation, error);
      return buildResult(snapshot, [warning]);
    }
  }

  async queryFuturesIncome(client, options) {
    const rows = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await client.futures.incomeHistory({
        ...options,
        page,
        limit: 1000,
      });
      if (!Array.isArray(batch)) {
        throw new TypeError("U 本位收益历史返回了无效结果");
      }
      rows.push(...batch);
      if (batch.length < 1000) break;
    }
    return rows;
  }

  shouldReconcileIncome(scopeKey, cachedIncome, reconcileHistory, now) {
    if (!reconcileHistory) return false;
    const lastAttemptAt = this.futuresIncomeLastAttemptAt.get(scopeKey);
    if (
      lastAttemptAt != null &&
      now - Number(lastAttemptAt) < this.historyRetryIntervalMs
    ) {
      return false;
    }
    if (!cachedIncome || cachedIncome.reconciledAt == null) {
      return true;
    }
    return now - Number(cachedIncome.reconciledAt) >=
      this.historyReconcileIntervalMs;
  }

  async refreshIncome({
    client,
    environment,
    accountFingerprint,
    reconcileHistory = true,
  }) {
    if (!client?.futures?.apiKey || !client?.futures?.apiSecret) {
      throw new Error("未配置 U 本位凭证");
    }

    const now = this.now();
    const scopeKey = this.getScopeKey(environment, accountFingerprint);
    const cachedIncome = this.futuresIncomeCache.get(scopeKey);
    const shouldReconcileHistory = this.shouldReconcileIncome(
      scopeKey,
      cachedIncome,
      reconcileHistory,
      now
    );
    const warnings = [];
    let historyReconciled = false;

    if (shouldReconcileHistory) {
      this.futuresIncomeLastAttemptAt.set(scopeKey, now);
      try {
        const entries = await this.queryFuturesIncome(client, {
          startTime: now - ROLLING_WINDOW_MS,
          endTime: now,
        });
        const summary = summarizeFuturesIncome(entries);
        const futuresIncome = {
          ...summary,
          count: entries.length,
          updatedAt: this.now(),
          reconciledAt: this.now(),
          complete: summary.unsupportedAssets.length === 0,
          error: null,
        };
        const journal = this.futuresIncomeEventJournal.get(scopeKey);
        for (const delta of journal?.values() || []) {
          if (Number(delta.eventTime) < now - ROLLING_WINDOW_MS) continue;
          replayMissingIncomeDelta(futuresIncome, entries, delta, now);
        }
        futuresIncome.commission24h = negateDecimal(
          futuresIncome.commissionIncome24h
        );
        futuresIncome.actualPnl24h = sumDecimals([
          futuresIncome.realizedPnl24h,
          futuresIncome.commissionIncome24h,
          futuresIncome.fundingFee24h,
        ]);
        for (const [key, delta] of journal || []) {
          if (Number(delta.eventTime) < now - ROLLING_WINDOW_MS) {
            journal.delete(key);
          }
        }
        this.futuresIncomeCache.set(scopeKey, futuresIncome);
        historyReconciled = true;
      } catch (error) {
        const warning = serializeWarning("income history", error);
        warnings.push(warning);
        this.markFuturesIncomeIncomplete(scopeKey, { error: warning });
      }
    }

    const futuresIncome = cloneFuturesIncomeSnapshot(
      this.getFuturesIncomeSnapshot(scopeKey)
    );
    if (futuresIncome.unsupportedAssets.length) {
      warnings.push({
        marketType: "futures",
        operation: "income metrics",
        name: "UnsupportedIncomeAssetWarning",
        message: `以下收益资产不是 ${ACCOUNTING_ASSET}，缺少汇率，实际盈亏未完整折算：${futuresIncome.unsupportedAssets.join(", ")}`,
      });
    }
    if (!shouldReconcileHistory && futuresIncome.error) {
      warnings.push({ ...futuresIncome.error });
    }

    return {
      ...futuresIncome,
      environment,
      accountFingerprint,
      income: cloneFuturesIncomeSnapshot(futuresIncome),
      incomeComplete: futuresIncome.complete === true,
      historyReconciled,
      warnings,
    };
  }

  async refresh({
    client,
    environment,
    accountFingerprint,
    reconcileHistory = true,
    openOrderCount = 0,
  }) {
    if (!client?.futures?.apiKey || !client?.futures?.apiSecret) {
      throw new Error("未配置 U 本位凭证");
    }

    const now = this.now();
    const scopeKey = this.getScopeKey(environment, accountFingerprint);
    const previousPositionSnapshot = this.getFuturesPositionSnapshot(scopeKey);
    const positionQueryStartSequence =
      this.futuresPositionEventSequence.get(scopeKey) || 0;
    const accountPromise = this.refreshAccount({
      client,
      environment,
      accountFingerprint,
    });
    const hasDedicatedPositionQuery =
      typeof client.futures.positionRisk === "function";
    const positionPromise = hasDedicatedPositionQuery
      ? this.refreshPositions({ client, environment, accountFingerprint })
      : Promise.resolve(null);
    const incomePromise = this.refreshIncome({
      client,
      environment,
      accountFingerprint,
      reconcileHistory,
    });
    const [accountResult, positionResult, incomeResult] = await Promise.allSettled([
      accountPromise,
      positionPromise,
      incomePromise,
    ]);
    const warnings = [];

    const accountSnapshot = accountResult.status === "fulfilled"
      ? accountResult.value
      : {
          accountMetrics: cloneFuturesAccountMetrics(
            this.futuresAccountCache.get(scopeKey)
          ),
          accountComplete: false,
          accountError: serializeWarning("account.status", accountResult.reason),
          accountPositions: [],
          accountPositionsComplete: false,
          accountPositionsError: null,
          warnings: [serializeWarning("account.status", accountResult.reason)],
        };
    warnings.push(...(accountSnapshot.warnings || []));

    let positionSnapshot = this.getFuturesPositionSnapshot(scopeKey);
    const accountPositions = accountSnapshot.accountPositions || [];
    const accountPositionsComplete =
      accountSnapshot.accountPositionsComplete === true;

    if (hasDedicatedPositionQuery) {
      const riskResult = positionResult.status === "fulfilled"
        ? positionResult.value
        : null;
      if (positionResult.status === "rejected") {
        const warning = serializeWarning("positionRisk", positionResult.reason);
        warnings.push(warning);
        positionSnapshot = this.markFuturesPositionFailure(
          scopeKey,
          "positionRisk",
          positionResult.reason
        );
      } else {
        warnings.push(...(riskResult?.warnings || []));
        positionSnapshot = this.getFuturesPositionSnapshot(scopeKey);
      }

      const riskComplete = riskResult?.positionsComplete === true;
      // refreshPositions 返回后仍可能收到 ACCOUNT_UPDATE，缓存会比该 Promise
      // 的返回值更新；一致性复核必须以当前缓存为准，避免把刚收到的增量丢掉。
      const riskPositions = positionSnapshot?.positions ||
        riskResult?.positions || [];
      if (riskComplete && accountPositionsComplete) {
        if (!positionRowsAgree(riskPositions, accountPositions)) {
          const consistencyError = new Error(
            "positionRisk 与 account.status 返回的非零持仓不一致；已保留两边发现的持仓，禁止确认空仓。"
          );
          const warning = serializeWarning(
            "positionRisk/account.status consistency",
            consistencyError
          );
          warnings.push(warning);
          const next = {
            ...(positionSnapshot || {}),
            positions: mergePositionRows(riskPositions, accountPositions),
            positionsUpdatedAt: this.now(),
            complete: false,
            operation: "positionRisk",
            error: warning,
          };
          this.futuresPositionCache.set(scopeKey, next);
          positionSnapshot = cloneFuturesPositionSnapshot(next);
        }
      } else if (riskComplete && riskPositions.length === 0) {
        // 空仓是安全关键结论。专用查询虽已成功，但 account.status 无法复核时，
        // 不清除上一份非零快照，也不把空列表标为完整。
        const verificationError = new Error(
          "positionRisk 返回空仓，但 account.status 未提供可校验的持仓数组。"
        );
        const warning = serializeWarning(
          "empty position verification",
          verificationError
        );
        warnings.push(warning);
        const next = {
          ...(positionSnapshot || {}),
          positions: mergePositionRows(
            riskPositions,
            previousPositionSnapshot?.positions || []
          ),
          positionsUpdatedAt:
            previousPositionSnapshot?.positionsUpdatedAt ||
            positionSnapshot?.positionsUpdatedAt ||
            null,
          complete: false,
          operation: "positionRisk",
          error: warning,
        };
        this.futuresPositionCache.set(scopeKey, next);
        positionSnapshot = cloneFuturesPositionSnapshot(next);
      } else if (!riskComplete && accountPositionsComplete && accountPositions.length) {
        // account.status 只能作为失败时的危险补充源，不能把专用持仓查询
        // 失败后的结果重新升级为完整快照。
        const next = {
          ...(positionSnapshot || {}),
          positions: mergePositionRows(
            positionSnapshot?.positions || [],
            accountPositions
          ),
          positionsUpdatedAt: this.now(),
          complete: false,
          operation: "positionRisk",
        };
        this.futuresPositionCache.set(scopeKey, next);
        positionSnapshot = cloneFuturesPositionSnapshot(next);
      }
    } else if (accountPositionsComplete) {
      positionSnapshot = this.replaceFuturesPositionCache(scopeKey, {
        positions: accountPositions,
        operation: "account.status",
        queryStartSequence: positionQueryStartSequence,
      });
    } else {
      const positionError = new Error(
        accountSnapshot.accountPositionsError?.message ||
        accountSnapshot.accountError?.message ||
        "account.status 未返回有效持仓数组"
      );
      positionSnapshot = this.markFuturesPositionFailure(
        scopeKey,
        "account.status positions",
        positionError
      );
    }
    if (!positionSnapshot) {
      positionSnapshot = this.markFuturesPositionFailure(
        scopeKey,
        hasDedicatedPositionQuery ? "positionRisk" : "account.status positions",
        new Error("尚未获得有效的 U 本位持仓快照")
      );
    }

    let accountMetrics = cloneFuturesAccountMetrics(
      accountSnapshot.accountMetrics
    );
    const accountError = accountSnapshot.accountComplete
      ? null
      : new Error(accountSnapshot.accountError?.message || "U 本位账户查询失败");
    if (accountMetrics) {
      accountMetrics = {
        ...accountMetrics,
        positions: positionSnapshot.positions.map((position) => ({ ...position })),
        openPositionCount: positionSnapshot.positions.length,
      };
      this.futuresAccountCache.set(scopeKey, accountMetrics);
    } else {
      if (!accountMetrics) throw accountError;
    }

    const incomeSnapshot = incomeResult.status === "fulfilled"
      ? incomeResult.value
      : {
          ...cloneFuturesIncomeSnapshot(this.getFuturesIncomeSnapshot(scopeKey)),
          incomeComplete: false,
          historyReconciled: false,
          warnings: [serializeWarning("income history", incomeResult.reason)],
        };
    warnings.push(...(incomeSnapshot.warnings || []));
    // account.status / positionRisk 可能比本地收益缓存慢。在它们等待期间，
    // ORDER_TRADE_UPDATE 或 ACCOUNT_UPDATE 仍会把最新成交/资金费写入缓存；
    // 组装最终结果时必须重新读取缓存，不能用 Promise.all 开始时取得的旧值
    // 覆盖已经即时显示过的实际盈亏。
    const futuresIncome = cloneFuturesIncomeSnapshot(
      this.getFuturesIncomeSnapshot(scopeKey)
    );
    const historyReconciled = incomeSnapshot.historyReconciled === true;

    const futuresMetrics = {
      ...accountMetrics,
      positions: accountMetrics.positions.map((position) => ({ ...position })),
      realizedPnl24h: futuresIncome.realizedPnl24h,
      commission24h: futuresIncome.commission24h,
      fundingFee24h: futuresIncome.fundingFee24h,
      actualPnl24h: futuresIncome.actualPnl24h,
      realizedIncomeCount: futuresIncome.count,
      realizedIncomeUpdatedAt: futuresIncome.updatedAt,
      positionsUpdatedAt: positionSnapshot.positionsUpdatedAt,
    };
    const accountOk = accountSnapshot.accountComplete === true;
    const incomeOk = futuresIncome.complete === true;
    const positionsOk = positionSnapshot.complete === true;
    const positionSource = {
      configured: true,
      ok: positionsOk,
      updatedAt: positionSnapshot.positionsUpdatedAt,
      operation: positionSnapshot.operation,
      error: positionSnapshot.error,
    };

    return {
      environment,
      accountFingerprint,
      staticBalance: futuresMetrics.walletBalance,
      balance: futuresMetrics.marginBalance,
      available: futuresMetrics.availableBalance,
      margin: futuresMetrics.initialMargin,
      positionProfit: futuresMetrics.unrealizedProfit,
      closeProfit: futuresMetrics.realizedPnl24h,
      commission: futuresMetrics.commission24h,
      realProfit: futuresMetrics.actualPnl24h,
      deviation: "0",
      openVolume: futuresMetrics.openPositionCount,
      orderVolume: Math.max(0, Math.floor(Number(openOrderCount) || 0)),
      currency: ACCOUNTING_ASSET,
      rollingWindowMs: ROLLING_WINDOW_MS,
      updatedAt: now,
      positionsUpdatedAt: positionSnapshot.positionsUpdatedAt,
      source: "binance",
      complete: accountOk && incomeOk && positionsOk,
      accountComplete: accountOk,
      incomeComplete: incomeOk,
      historyReconciled,
      positions: futuresMetrics.positions,
      positionsComplete: positionsOk,
      positionSources: { futures: positionSource },
      futures: futuresMetrics,
      warnings,
    };
  }

  close() {
    this.futuresAccountCache.clear();
    this.futuresPositionCache.clear();
    this.futuresPositionRequestSequence.clear();
    this.futuresPositionCommittedRequestSequence.clear();
    this.processedFuturesPositionEvents.clear();
    this.futuresPositionEventSequence.clear();
    this.futuresPositionEventJournal.clear();
    this.futuresIncomeCache.clear();
    this.processedFuturesIncomeEvents.clear();
    this.futuresIncomeEventSequence.clear();
    this.futuresIncomeEventJournal.clear();
    this.futuresIncomeLastAttemptAt.clear();
  }
}

module.exports = {
  ACCOUNTING_ASSET,
  BinanceAccountMetricsService,
  HISTORY_RECONCILE_INTERVAL_MS,
  HISTORY_RETRY_INTERVAL_MS,
  ROLLING_WINDOW_MS,
  absoluteDecimal,
  buildFuturesPositionRows,
  summarizeFuturesIncome,
  sumDecimals,
};
