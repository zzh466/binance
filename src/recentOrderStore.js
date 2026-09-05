const fs = require("node:fs");
const path = require("node:path");

const STORE_VERSION = 1;
const RECENT_ORDER_RETENTION_MS = 24 * 60 * 60 * 1000;
const TERMINAL_ORDER_STATUSES = new Set([
  "FILLED",
  "CANCELED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "EXPIRED_IN_MATCH",
]);

function firstPresent(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ""
  );
}

function finiteTimestamp(...values) {
  for (const value of values) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  return null;
}

function recent24HourCutoff(now = Date.now()) {
  return now - RECENT_ORDER_RETENTION_MS;
}

function normalizeRecentOrder(order, context = {}, now = Date.now()) {
  if (!order || typeof order !== "object") return null;

  const marketType = String(
    firstPresent(order.marketType, context.marketType, "")
  ).toLowerCase();
  const symbol = String(firstPresent(order.symbol, order.s, "")).toUpperCase();
  const orderId = firstPresent(order.orderId, order.i);
  const clientOrderId = String(firstPresent(
    order.clientOrderId,
    order.c,
    order.newClientOrderId,
    ""
  ));
  if (!marketType || !symbol || (orderId === undefined && !clientOrderId)) {
    return null;
  }

  const status = String(firstPresent(
    order.status,
    order.X,
    order.x,
    context.defaultStatus,
    "UNKNOWN"
  )).toUpperCase();
  const updatedAt = finiteTimestamp(
    order.updateTime,
    order.T,
    order.E,
    order.transactTime,
    order.transactionTime,
    context.updatedAt,
    now
  );
  const createdAt = finiteTimestamp(
    order.time,
    order.O,
    order.transactTime,
    order.transactionTime,
    order.workingTime,
    updatedAt
  );
  const environment = String(context.environment || "unknown");
  const accountFingerprint = String(context.accountFingerprint || "anonymous");
  const algoOrder = order.algoOrder === true;
  const identity = orderId === undefined
    ? `client:${clientOrderId}`
    : `${algoOrder ? "algo" : "order"}:${String(orderId)}`;

  return {
    key: `${environment}:${accountFingerprint}:${marketType}:${symbol}:${identity}`,
    environment,
    accountFingerprint,
    marketType,
    symbol,
    orderId: orderId === undefined ? null : orderId,
    actualOrderId: firstPresent(
      order.actualOrderId,
      order.actualOrderID,
      order.actualOrder?.orderId,
      null
    ),
    clientOrderId,
    algoOrder,
    side: String(firstPresent(order.side, order.S, "")).toUpperCase(),
    type: String(firstPresent(order.type, order.o, "")).toUpperCase(),
    timeInForce: String(firstPresent(order.timeInForce, order.f, "")).toUpperCase(),
    status,
    price: String(firstPresent(order.price, order.p, "0")),
    stopPrice: String(firstPresent(order.stopPrice, order.P, order.sp, "0")),
    origQty: String(firstPresent(order.origQty, order.q, "0")),
    executedQty: String(firstPresent(order.executedQty, order.z, "0")),
    cumulativeQuoteQty: String(firstPresent(
      order.cummulativeQuoteQty,
      order.cumulativeQuoteQty,
      order.Z,
      order.cumQuote,
      "0"
    )),
    averagePrice: String(firstPresent(order.avgPrice, order.ap, "0")),
    positionSide: String(firstPresent(
      order.positionSide,
      order.ps,
      ""
    )).toUpperCase(),
    positionEffect: String(firstPresent(
      order.positionEffect,
      ""
    )).toUpperCase(),
    reduceOnly:
      firstPresent(order.reduceOnly, order.R, false) === true ||
      String(firstPresent(order.reduceOnly, order.R, false)).toLowerCase() === "true",
    closePosition:
      firstPresent(order.closePosition, order.cp, false) === true ||
      String(firstPresent(order.closePosition, order.cp, false)).toLowerCase() === "true",
    rejectReason: String(firstPresent(order.rejectReason, order.r, "")),
    createdAt,
    updatedAt,
    observedAt: now,
    terminal: TERMINAL_ORDER_STATUSES.has(status),
    source: String(context.source || "unknown"),
    statusHistory: [{ status, updatedAt, observedAt: now }],
  };
}

function mergeRecentOrder(existing, incoming) {
  if (!existing) return incoming;

  const incomingIsNewer = Number(incoming.updatedAt) >= Number(existing.updatedAt);
  const incomingStatusIsPlaceholder = new Set([
    "UNKNOWN",
    "ACKNOWLEDGED",
  ]).has(incoming.status);
  const existingStatusIsKnown = !new Set([
    "UNKNOWN",
    "ACKNOWLEDGED",
  ]).has(existing.status);
  const merged = { ...existing };
  for (const [field, value] of Object.entries(incoming)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== "" &&
      value !== "0"
    ) {
      merged[field] = value;
    }
  }

  if (!incomingIsNewer || (incomingStatusIsPlaceholder && existingStatusIsKnown)) {
    merged.status = existing.status;
    merged.updatedAt = existing.updatedAt;
    merged.terminal = existing.terminal;
    merged.source = existing.source;
  }
  merged.createdAt = Math.min(
    Number(existing.createdAt) || Number(incoming.createdAt),
    Number(incoming.createdAt) || Number(existing.createdAt)
  );
  merged.observedAt = Math.max(
    Number(existing.observedAt) || 0,
    Number(incoming.observedAt) || 0
  );

  const history = Array.isArray(existing.statusHistory)
    ? [...existing.statusHistory]
    : [];
  const latestHistory = history[history.length - 1];
  if (
    incomingIsNewer &&
    !(incomingStatusIsPlaceholder && existingStatusIsKnown) &&
    (!latestHistory || latestHistory.status !== incoming.status)
  ) {
    history.push({
      status: incoming.status,
      updatedAt: incoming.updatedAt,
      observedAt: incoming.observedAt,
    });
  }
  merged.statusHistory = history.slice(-32);
  return merged;
}

class RecentOrderStore {
  constructor(filePath, { now = () => Date.now(), saveDelayMs = 50 } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.saveDelayMs = saveDelayMs;
    this.orders = new Map();
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const orders = Array.isArray(payload?.orders) ? payload.orders : [];
      for (const order of orders) {
        if (order?.key) this.orders.set(order.key, order);
      }
      if (this.prune()) this.scheduleSave();
    } catch {
      this.orders.clear();
    }
  }

  prune() {
    const cutoff = recent24HourCutoff(this.now());
    let changed = false;
    for (const [key, order] of this.orders) {
      const activityAt = finiteTimestamp(order.updatedAt, order.createdAt);
      if (!activityAt || activityAt < cutoff) {
        this.orders.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  upsert(order, context = {}) {
    const now = this.now();
    const normalized = normalizeRecentOrder(order, context, now);
    if (!normalized) return null;
    if (normalized.updatedAt < recent24HourCutoff(now)) return null;

    const merged = mergeRecentOrder(this.orders.get(normalized.key), normalized);
    this.orders.set(merged.key, merged);
    this.prune();
    this.scheduleSave();
    return { ...merged };
  }

  upsertMany(orders, context = {}) {
    const saved = [];
    for (const order of Array.isArray(orders) ? orders : [orders]) {
      const result = this.upsert(order, context);
      if (result) saved.push(result);
    }
    return saved;
  }

  list({ environment, accountFingerprints, marketType, symbol } = {}) {
    this.prune();
    const allowedAccounts = Array.isArray(accountFingerprints)
      ? new Set(accountFingerprints.filter(Boolean))
      : null;
    const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
    return [...this.orders.values()]
      .filter((order) => !environment || order.environment === environment)
      .filter((order) => !allowedAccounts || allowedAccounts.has(order.accountFingerprint))
      .filter((order) => !marketType || order.marketType === marketType)
      .filter((order) => !normalizedSymbol || order.symbol === normalizedSymbol)
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt))
      .map((order) => ({ ...order }));
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify({
      version: STORE_VERSION,
      updatedAt: this.now(),
      orders: this.list(),
    }, null, 2)}\n`, "utf8");
  }

  close() {
    if (this.saveTimer || this.prune()) this.flush();
  }
}

module.exports = {
  RecentOrderStore,
  TERMINAL_ORDER_STATUSES,
  mergeRecentOrder,
  normalizeRecentOrder,
  recent24HourCutoff,
};
