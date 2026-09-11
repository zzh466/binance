(function exposeOpenOrderState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OpenOrderState = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const terminalOrdersByMap = new WeakMap();
  const TERMINAL_ORDER_LIMIT = 5_000;
  const TERMINAL_ORDER_STATUSES = new Set([
    "CANCELED",
    "CANCELLED",
    "EXPIRED",
    "EXPIRED_IN_MATCH",
    "FILLED",
    "REJECTED",
  ]);

  function normalizeOpenOrder(order = {}, receivedAt = Date.now()) {
    if (order.marketType && order.marketType !== "futures") return null;
    const normalized = {
      marketType: "futures",
      symbol: String(order.symbol ?? order.s ?? "").toUpperCase(),
      orderId: order.orderId ?? order.i,
      clientOrderId:
        order.clientOrderId ?? order.c ?? order.newClientOrderId ?? "",
      side: String(order.side ?? order.S ?? "").toUpperCase(),
      type: String(order.type ?? order.o ?? "").toUpperCase(),
      status: String(order.status ?? order.X ?? "").toUpperCase(),
      price: String(order.price ?? order.p ?? "0"),
      stopPrice: String(order.stopPrice ?? order.P ?? "0"),
      origQty: String(order.origQty ?? order.q ?? "0"),
      executedQty: String(order.executedQty ?? order.z ?? "0"),
      updateTime: Number(
        order.updateTime ?? order.transactTime ?? order.T ?? order.E ?? receivedAt
      ),
      receivedAt,
      algoOrder: order.algoOrder === true,
    };
    return normalized.symbol && normalized.orderId !== undefined
      ? normalized
      : null;
  }

  function openOrderKey(order) {
    return `${order.symbol}:${order.orderId}`;
  }

  function isOpenOrder(order) {
    return ["NEW", "PARTIALLY_FILLED", "PENDING_CANCEL"].includes(order.status) &&
      Number(order.origQty) - Number(order.executedQty) > 0;
  }

  function isTerminalOrder(order) {
    return TERMINAL_ORDER_STATUSES.has(order.status);
  }

  function isSameOrder(left, right) {
    if (!left || !right || left.symbol !== right.symbol) return false;
    const sameOrderId =
      left.orderId !== undefined && right.orderId !== undefined &&
      String(left.orderId) === String(right.orderId);
    const sameClientOrderId =
      left.clientOrderId && right.clientOrderId &&
      left.clientOrderId === right.clientOrderId;
    return sameOrderId || sameClientOrderId;
  }

  function compareOrderFreshness(left, right) {
    const leftUpdateTime = Number(left?.updateTime);
    const rightUpdateTime = Number(right?.updateTime);
    if (
      Number.isFinite(leftUpdateTime) && Number.isFinite(rightUpdateTime) &&
      leftUpdateTime !== rightUpdateTime
    ) {
      return leftUpdateTime - rightUpdateTime;
    }
    return Number(left?.receivedAt || 0) - Number(right?.receivedAt || 0);
  }

  function getTerminalOrders(openOrdersByKey) {
    let terminalOrders = terminalOrdersByMap.get(openOrdersByKey);
    if (!terminalOrders) {
      terminalOrders = new Map();
      terminalOrdersByMap.set(openOrdersByKey, terminalOrders);
    }
    return terminalOrders;
  }

  function rememberTerminalOrder(terminalOrders, key, order) {
    terminalOrders.delete(key);
    terminalOrders.set(key, order);
    while (terminalOrders.size > TERMINAL_ORDER_LIMIT) {
      terminalOrders.delete(terminalOrders.keys().next().value);
    }
  }

  function updateOpenOrderMap(
    openOrdersByKey,
    order,
    receivedAt = Date.now()
  ) {
    const normalized = normalizeOpenOrder(order, receivedAt);
    if (!normalized) return { updated: false, reason: "invalid-order" };

    const key = openOrderKey(normalized);
    const existing = openOrdersByKey.get(key);
    if (existing && compareOrderFreshness(existing, normalized) > 0) {
      return { updated: false, reason: "stale-update", key, normalized };
    }

    if (isOpenOrder(normalized)) {
      const terminalOrders = getTerminalOrders(openOrdersByKey);
      const terminal = [...terminalOrders.values()]
        .filter((candidate) => isSameOrder(candidate, normalized))
        .sort(compareOrderFreshness)
        .at(-1);
      if (terminal && compareOrderFreshness(terminal, normalized) >= 0) {
        return {
          updated: false,
          reason: "terminal-order-is-newer",
          key,
          normalized,
        };
      }
      openOrdersByKey.set(key, normalized);
    } else if (isTerminalOrder(normalized)) {
      const terminalOrders = getTerminalOrders(openOrdersByKey);
      const matchingKeys = [...openOrdersByKey.entries()]
        .filter(([, candidate]) => isSameOrder(candidate, normalized))
        .map(([candidateKey]) => candidateKey);
      matchingKeys.push(key);
      for (const matchingKey of new Set(matchingKeys)) {
        const matchingOrder = openOrdersByKey.get(matchingKey);
        const terminalOrder = matchingOrder
          ? {
            ...normalized,
            marketType: "futures",
            clientOrderId:
              normalized.clientOrderId || matchingOrder.clientOrderId,
          }
          : normalized;
        const previousTerminal = terminalOrders.get(matchingKey);
        if (
          !previousTerminal ||
          compareOrderFreshness(terminalOrder, previousTerminal) >= 0
        ) {
          rememberTerminalOrder(terminalOrders, matchingKey, terminalOrder);
        }
        openOrdersByKey.delete(matchingKey);
      }
    } else {
      return {
        updated: false,
        reason: "non-final-status",
        key,
        normalized,
      };
    }
    return { updated: true, key, normalized };
  }

  return {
    isOpenOrder,
    normalizeOpenOrder,
    openOrderKey,
    updateOpenOrderMap,
  };
});
