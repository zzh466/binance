const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("callback 必须是函数");
  }

  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("binance", {
  openAdditionalInstances: (count = 2) =>
    ipcRenderer.invoke("app:open-additional-instances", { count }),
  loadShortcutSettings: (fallbackSettings) =>
    ipcRenderer.invoke("app:load-shortcut-settings", { fallbackSettings }),
  saveShortcutSettings: (settings) =>
    ipcRenderer.invoke("app:save-shortcut-settings", { settings }),
  getStatus: () => ipcRenderer.invoke("binance:get-status"),
  switchEnvironment: (testnet) =>
    ipcRenderer.invoke("binance:switch-environment", { testnet }),
  syncTime: (options) =>
    ipcRenderer.invoke("binance:sync-time", options || {}),
  ping: (options) =>
    ipcRenderer.invoke("binance:ping", options || {}),
  exchangeInfo: (options) =>
    ipcRenderer.invoke("binance:exchange-info", options || {}),
  marketOverview: (options) =>
    ipcRenderer.invoke("binance:market-overview", options || {}),

  connectDepth: (symbol) =>
    ipcRenderer.invoke("binance:connect-depth", { symbol }),
  disconnectMarket: () =>
    ipcRenderer.invoke("binance:disconnect-market"),

  placeOrder: (order) =>
    ipcRenderer.invoke("binance:place-order", order),
  testOrder: (order) =>
    ipcRenderer.invoke("binance:test-order", order),
  cancelOrder: (order) =>
    ipcRenderer.invoke("binance:cancel-order", order),
  queryOrder: (options) =>
    ipcRenderer.invoke("binance:query-order", options || {}),
  openOrders: (options) =>
    ipcRenderer.invoke("binance:open-orders", options || {}),
  cancelAllOpenOrders: (options) =>
    ipcRenderer.invoke("binance:cancel-all-open-orders", options || {}),
  amendOrder: (options) =>
    ipcRenderer.invoke("binance:amend-order", options || {}),
  cancelReplace: (options) =>
    ipcRenderer.invoke("binance:cancel-replace", options || {}),
  allOrderLists: (options) =>
    ipcRenderer.invoke("binance:all-order-lists", options || {}),
  allOrders: (options) =>
    ipcRenderer.invoke("binance:all-orders", options || {}),
  recentOrders: (options) =>
    ipcRenderer.invoke("binance:recent-orders", options || {}),
  myTrades: (options) =>
    ipcRenderer.invoke("binance:my-trades", options || {}),
  accountStatus: (options) =>
    ipcRenderer.invoke("binance:account-status", options || {}),
  accountRateLimits: (options) =>
    ipcRenderer.invoke("binance:account-rate-limits", options || {}),
  accountCommission: (options) =>
    ipcRenderer.invoke("binance:account-commission", options || {}),
  signTradFiPerpsAgreement: () =>
    ipcRenderer.invoke("binance:sign-tradfi-perps-agreement"),
  queryOrderList: (options) =>
    ipcRenderer.invoke("binance:query-order-list", options || {}),
  openOrderLists: (options) =>
    ipcRenderer.invoke("binance:open-order-lists", options || {}),
  placeOco: (options) =>
    ipcRenderer.invoke("binance:place-oco", options || {}),
  placeOto: (options) =>
    ipcRenderer.invoke("binance:place-oto", options || {}),
  placeOtoco: (options) =>
    ipcRenderer.invoke("binance:place-otoco", options || {}),
  cancelOrderList: (options) =>
    ipcRenderer.invoke("binance:cancel-order-list", options || {}),
  connectUserData: (options) =>
    ipcRenderer.invoke("binance:connect-user-data", options || {}),
  disconnectUserData: () =>
    ipcRenderer.invoke("binance:disconnect-user-data"),

  onDepthUpdate: (callback) =>
    subscribe("binance:depth-update", callback),
  onTradeUpdate: (callback) =>
    subscribe("binance:trade-update", callback),
  onMarketStatus: (callback) =>
    subscribe("binance:market-status", callback),
  onMarketError: (callback) =>
    subscribe("binance:market-error", callback),
  onLatencyUpdate: (callback) =>
    subscribe("binance:latency-update", callback),
  onUserDataEvent: (callback) =>
    subscribe("binance:user-data-event", callback),
  onUserDataStatus: (callback) =>
    subscribe("binance:user-data-status", callback),
  onUserDataError: (callback) =>
    subscribe("binance:user-data-error", callback),
});
