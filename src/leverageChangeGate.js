class LeverageChangeInProgressError extends Error {
  constructor(symbol) {
    super(`${symbol} 正在设置杠杆倍率，请等待 Binance 确认后再提交新委托。`);
    this.name = "LeverageChangeInProgressError";
    this.code = "LEVERAGE_CHANGE_IN_PROGRESS";
    this.data = { symbol };
  }
}

function normalizeGateSymbol(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  if (!normalized) throw new TypeError("杠杆设置门禁缺少交易对。");
  return normalized;
}

class LeverageChangeGate {
  constructor() {
    this.pendingByClient = new WeakMap();
  }

  getClientPending(client, { create = false } = {}) {
    if (!client || (typeof client !== "object" && typeof client !== "function")) {
      throw new TypeError("杠杆设置门禁缺少客户端。");
    }
    let pending = this.pendingByClient.get(client);
    if (!pending && create) {
      pending = new Map();
      this.pendingByClient.set(client, pending);
    }
    return pending || null;
  }

  isPending(client, symbol) {
    const normalizedSymbol = normalizeGateSymbol(symbol);
    return Boolean(this.getClientPending(client)?.has(normalizedSymbol));
  }

  assertOrderAllowed(client, symbol) {
    const normalizedSymbol = normalizeGateSymbol(symbol);
    if (this.getClientPending(client)?.has(normalizedSymbol)) {
      throw new LeverageChangeInProgressError(normalizedSymbol);
    }
    return normalizedSymbol;
  }

  run(client, symbol, action) {
    if (typeof action !== "function") {
      throw new TypeError("杠杆设置任务必须是函数。");
    }
    const normalizedSymbol = this.assertOrderAllowed(client, symbol);
    const pending = this.getClientPending(client, { create: true });
    const marker = {};
    pending.set(normalizedSymbol, marker);
    const operation = Promise.resolve().then(action);
    return operation.finally(() => {
      if (pending.get(normalizedSymbol) === marker) {
        pending.delete(normalizedSymbol);
      }
    });
  }
}

module.exports = {
  LeverageChangeGate,
  LeverageChangeInProgressError,
  normalizeGateSymbol,
};
