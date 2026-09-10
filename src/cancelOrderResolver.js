const CANCELABLE_ORDER_STATUSES = new Set([
  "ACKNOWLEDGED",
  "NEW",
  "PARTIALLY_FILLED",
  "PENDING_CANCEL",
]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeSymbol(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeMarketType(value) {
  return normalizeText(value).toLowerCase();
}

function isSameOrderIdentity(order, request) {
  const requestedOrderId = normalizeText(request.orderId);
  const requestedClientOrderId = normalizeText(request.origClientOrderId);
  return Boolean(
    (requestedOrderId && normalizeText(order?.orderId) === requestedOrderId) ||
    (requestedClientOrderId &&
      normalizeText(order?.clientOrderId) === requestedClientOrderId)
  );
}

function isCancelableOrder(order) {
  return CANCELABLE_ORDER_STATUSES.has(
    normalizeText(order?.status).toUpperCase()
  );
}

function describeOrderIdentity(request) {
  return normalizeText(request.orderId) || normalizeText(request.origClientOrderId);
}

function throwAmbiguousOrder(request) {
  throw new TypeError(
    `订单 ${describeOrderIdentity(request)} 在当前账户中匹配到多个未成交订单，` +
    "请从当前挂单列表选择正确的合约后再撤单。"
  );
}

function resolveCancelOrderRequest(request = {}, knownOrders = []) {
  const normalizedRequest = {
    ...request,
    symbol: normalizeSymbol(request.symbol),
    marketType: normalizeMarketType(request.marketType) || undefined,
  };
  if (!describeOrderIdentity(normalizedRequest)) return normalizedRequest;

  let candidates = (Array.isArray(knownOrders) ? knownOrders : [])
    .filter((order) => isSameOrderIdentity(order, normalizedRequest));
  if (normalizedRequest.marketType) {
    candidates = candidates.filter(
      (order) => normalizeMarketType(order?.marketType) === normalizedRequest.marketType
    );
  }
  if (!candidates.length) return normalizedRequest;

  const cancelable = candidates.filter(isCancelableOrder);
  const sameSymbolCancelable = normalizedRequest.symbol
    ? cancelable.filter(
      (order) => normalizeSymbol(order?.symbol) === normalizedRequest.symbol
    )
    : [];

  let selected = null;
  if (sameSymbolCancelable.length === 1) {
    [selected] = sameSymbolCancelable;
  } else if (sameSymbolCancelable.length > 1) {
    throwAmbiguousOrder(normalizedRequest);
  } else if (cancelable.length === 1) {
    [selected] = cancelable;
  } else if (cancelable.length > 1) {
    throwAmbiguousOrder(normalizedRequest);
  }

  if (!selected) {
    const sameSymbol = normalizedRequest.symbol
      ? candidates.filter(
        (order) => normalizeSymbol(order?.symbol) === normalizedRequest.symbol
      )
      : [];
    if (sameSymbol.length === 1) {
      [selected] = sameSymbol;
    } else if (candidates.length === 1) {
      [selected] = candidates;
    } else {
      throwAmbiguousOrder(normalizedRequest);
    }
    throw new TypeError(
      `订单 ${describeOrderIdentity(normalizedRequest)} 当前状态为 ` +
      `${normalizeText(selected.status).toUpperCase() || "未知"}，已不是可撤销挂单。`
    );
  }

  return {
    ...normalizedRequest,
    symbol: normalizeSymbol(selected.symbol),
    marketType: normalizeMarketType(selected.marketType) || undefined,
    algoOrder: selected.algoOrder === true,
  };
}

module.exports = {
  CANCELABLE_ORDER_STATUSES,
  isCancelableOrder,
  resolveCancelOrderRequest,
};
