(function exposeCancelAllOrderTargets(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CancelAllOrderTargets = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const CANCELABLE_STATUSES = new Set([
    "NEW",
    "PARTIALLY_FILLED",
    "PENDING_CANCEL",
  ]);
  const DEFAULT_ACK_MAX_AGE_MS = 2 * 60_000;

  function normalizeMarketType(value) {
    const marketType = String(value || "").trim().toLowerCase();
    if (!marketType || marketType === "futures") return "futures";
    return null;
  }

  function normalizeCandidate(order, source, now, ackMaxAgeMs) {
    if (!order || typeof order !== "object") return null;
    const symbol = String(order.symbol ?? order.s ?? "").trim().toUpperCase();
    if (!symbol) return null;
    const status = String(order.status ?? order.X ?? "").trim().toUpperCase();
    const observedAt = Number(
      order.observedAt ?? order.receivedAt ?? order.updateTime ?? order.T ?? 0
    );
    const freshAcknowledgement =
      source === "recent" && status === "ACKNOWLEDGED" &&
      Number.isFinite(observedAt) && observedAt > 0 &&
      now - observedAt <= ackMaxAgeMs;
    if (!CANCELABLE_STATUSES.has(status) && !freshAcknowledgement) return null;
    const marketType = normalizeMarketType(order.marketType);
    if (!marketType) return null;
    return {
      ...order,
      symbol,
      marketType,
      status,
      discoverySource: source,
    };
  }

  function candidateIdentity(order) {
    const identity = order.orderId ?? order.i ??
      order.clientOrderId ?? order.c ?? "unknown";
    return `futures:${order.symbol}:${identity}`;
  }

  function collectCancelAllOrderTargets({
    remoteOrders = [],
    recentOrders = [],
    trackedOrders = [],
    now = Date.now(),
    ackMaxAgeMs = DEFAULT_ACK_MAX_AGE_MS,
  } = {}) {
    const candidates = new Map();
    for (const [source, orders] of [
      ["remote", remoteOrders],
      ["tracked", trackedOrders],
      ["recent", recentOrders],
    ]) {
      for (const order of Array.isArray(orders) ? orders : []) {
        const candidate = normalizeCandidate(order, source, now, ackMaxAgeMs);
        if (!candidate) continue;
        const identity = candidateIdentity(candidate);
        if (!candidates.has(identity)) candidates.set(identity, candidate);
      }
    }

    const targets = new Map();
    for (const order of candidates.values()) {
      const key = `futures:${order.symbol}`;
      if (!targets.has(key)) {
        targets.set(key, {
          symbol: order.symbol,
          marketType: "futures",
        });
      }
    }
    return {
      targets: [...targets.values()],
      orders: [...candidates.values()],
    };
  }

  function orderMatchesTarget(order, target) {
    if (!order || !target || order.symbol !== target.symbol) return false;
    return normalizeMarketType(order.marketType) === "futures" &&
      normalizeMarketType(target.marketType) === "futures";
  }

  return {
    DEFAULT_ACK_MAX_AGE_MS,
    collectCancelAllOrderTargets,
    orderMatchesTarget,
  };
});
