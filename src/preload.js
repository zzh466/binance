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
  getStatus: () => ipcRenderer.invoke("binance:get-status"),
  syncTime: () => ipcRenderer.invoke("binance:sync-time"),

  connectDepth: (symbol) =>
    ipcRenderer.invoke("binance:connect-depth", { symbol }),
  disconnectMarket: () =>
    ipcRenderer.invoke("binance:disconnect-market"),

  placeOrder: (order) =>
    ipcRenderer.invoke("binance:place-order", order),
  cancelOrder: (order) =>
    ipcRenderer.invoke("binance:cancel-order", order),
  allOrderLists: (options) =>
    ipcRenderer.invoke("binance:all-order-lists", options || {}),
  allOrders: (options) =>
    ipcRenderer.invoke("binance:all-orders", options || {}),
  myTrades: (options) =>
    ipcRenderer.invoke("binance:my-trades", options || {}),
  accountStatus: (options) =>
    ipcRenderer.invoke("binance:account-status", options || {}),

  onDepthUpdate: (callback) =>
    subscribe("binance:depth-update", callback),
  onMarketStatus: (callback) =>
    subscribe("binance:market-status", callback),
  onMarketError: (callback) =>
    subscribe("binance:market-error", callback),
});
