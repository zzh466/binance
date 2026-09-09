(function exposeOpenOrderState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OpenOrderState = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  function normalizeOpenOrder(order = {}, receivedAt = Date.now()) {
    const normalized = {
      marketType: order.marketType || null,
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
        order.updateTime ?? order.T ?? order.E ?? Date.now()
      ),
      receivedAt,
      algoOrder: order.algoOrder === true,
    };
    return normalized.symbol && normalized.orderId !== undefined
      ? normalized
      : null;
  }

  function openOrderKey(order) {
    return `${order.marketType || "auto"}:${order.symbol}:${order.orderId}`;
  }

  function isOpenOrder(order) {
    return ["NEW", "PARTIALLY_FILLED"].includes(order.status) &&
      Number(order.origQty) - Number(order.executedQty) > 0;
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
    if (existing && existing.receivedAt > normalized.receivedAt) {
      return { updated: false, reason: "stale-update", key, normalized };
    }

    if (isOpenOrder(normalized)) {
      openOrdersByKey.set(key, normalized);
    } else {
      openOrdersByKey.delete(key);
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
