(function exposeRendererElements(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.RendererElements = api;
  }
})(typeof window !== "undefined" ? window : globalThis, () => {
  const ELEMENT_SELECTORS = Object.freeze({
    environmentSwitch: "#environmentSwitch",
    environmentSwitchStatus: "#environmentSwitchStatus",
    environmentWarning: "#environmentWarning",
    accountOverviewBody: "#accountOverviewBody",
    refreshCurrentPositionsButton: "#refreshCurrentPositionsButton",
    positionSafetyBanner: "#positionSafetyBanner",
    currentPositionsStatus: "#currentPositionsStatus",
    currentPositionsBody: "#currentPositionsBody",
    managerAccount: "#managerAccount",
    refreshManagerUserInfoButton: "#refreshManagerUserInfoButton",
    managerUserInfoStatus: "#managerUserInfoStatus",
    managerUserName: "#managerUserName",
    managerUserAccount: "#managerUserAccount",
    managerGroupId: "#managerGroupId",
    managerProfitThreshold: "#managerProfitThreshold",
    managerPoints: "#managerPoints",
    managerRealProfit: "#managerRealProfit",
    managerAccountsBody: "#managerAccountsBody",
    environment: "#environment",
    tradingEnvironment: "#tradingEnvironment",
    orderHistoryEnvironment: "#orderHistoryEnvironment",
    tradeHistoryEnvironment: "#tradeHistoryEnvironment",
    accountEnvironment: "#accountEnvironment",
    credentials: "#credentials",
    stpSafetyStatus: "#stpSafetyStatus",
    chartOpenOrderStatus: "#chartOpenOrderStatus",
    marketStatus: "#marketStatus",
    timeOffset: "#timeOffset",
    depthConfig: "#depthConfig",
    rateLimitStatus: "#rateLimitStatus",
    futuresDeadManToggle: "#futuresDeadManToggle",
    futuresDeadManCountdown: "#futuresDeadManCountdown",
    futuresDeadManStatus: "#futuresDeadManStatus",
    klineInterval: "#klineInterval",
    overviewStatus: "#overviewStatus",
    overviewLastPrice: "#overviewLastPrice",
    overviewBookTicker: "#overviewBookTicker",
    overviewAveragePrice: "#overviewAveragePrice",
    overviewChange: "#overviewChange",
    overviewHighLow: "#overviewHighLow",
    filterRulesBody: "#filterRulesBody",
    klineBody: "#klineBody",
    publicTradesBody: "#publicTradesBody",
    openOrdersStatus: "#openOrdersStatus",
    openOrdersBody: "#openOrdersBody",
    queryOrderId: "#queryOrderId",
    amendOrderQty: "#amendOrderQty",
    replaceOrderPrice: "#replaceOrderPrice",
    queryOrderStatus: "#queryOrderStatus",
    queryOrderBody: "#queryOrderBody",
    chartSymbolInput: "#chartSymbolInput",
    switchChartSymbolButton: "#switchChartSymbolButton",
    chartSymbolSwitchStatus: "#chartSymbolSwitchStatus",
    chartLatestTradePrice: "#chartLatestTradePrice",
    lastUpdateId: "#lastUpdateId",
    receivedAt: "#receivedAt",
    spread: "#spread",
    bidRows: "#bidRows",
    askRows: "#askRows",
    side: "#side",
    positionEffect: "#positionEffect",
    orderType: "#orderType",
    orderSizingMode: "#orderSizingMode",
    quantityOrderLabel: "#quantityOrderLabel",
    quantity: "#quantity",
    quoteOrderQtyLabel: "#quoteOrderQtyLabel",
    quoteOrderQty: "#quoteOrderQty",
    orderSizingHint: "#orderSizingHint",
    price: "#price",
    latestTradePriceToggle: "#latestTradePriceToggle",
    latestTradePriceState: "#latestTradePriceState",
    stopPrice: "#stopPrice",
    trailingDelta: "#trailingDelta",
    icebergQty: "#icebergQty",
    orderId: "#orderId",
    refreshOrderHistoryButton: "#refreshOrderHistoryButton",
    orderHistoryStatus: "#orderHistoryStatus",
    orderHistoryBody: "#orderHistoryBody",
    refreshTradingRoundsButton: "#refreshTradingRoundsButton",
    tradingRoundsStatus: "#tradingRoundsStatus",
    tradingRoundsBody: "#tradingRoundsBody",
    refreshTradeHistoryButton: "#refreshTradeHistoryButton",
    tradeHistoryStatus: "#tradeHistoryStatus",
    tradeHistoryBody: "#tradeHistoryBody",
    refreshAccountButton: "#refreshAccountButton",
    signTradFiAgreementButton: "#signTradFiAgreementButton",
    tradFiAgreementStatus: "#tradFiAgreementStatus",
    accountStatus: "#accountStatus",
    accountType: "#accountType",
    accountCanTrade: "#accountCanTrade",
    accountCanDeposit: "#accountCanDeposit",
    accountCanWithdraw: "#accountCanWithdraw",
    accountPermissions: "#accountPermissions",
    accountTradeGroupId: "#accountTradeGroupId",
    accountUpdateTime: "#accountUpdateTime",
    accountBalancesBody: "#accountBalancesBody",
    riskStatus: "#riskStatus",
    riskBody: "#riskBody",
    ocoSide: "#ocoSide",
    ocoQuantity: "#ocoQuantity",
    ocoWorkingPrice: "#ocoWorkingPrice",
    ocoAbovePrice: "#ocoAbovePrice",
    ocoAboveStopPrice: "#ocoAboveStopPrice",
    ocoBelowPrice: "#ocoBelowPrice",
    ocoBelowStopPrice: "#ocoBelowStopPrice",
    orderListId: "#orderListId",
    orderListsStatus: "#orderListsStatus",
    orderListsBody: "#orderListsBody",
    userDataStatus: "#userDataStatus",
    userDataBody: "#userDataBody",
    binanceLatencyBar: "#binanceLatencyBar",
    requestDuration: "#requestDuration",
    output: "#output",
  });

  function collect(documentRef, { strict = true } = {}) {
    if (!documentRef || typeof documentRef.querySelector !== "function") {
      throw new TypeError("页面元素注册表需要有效的 document。");
    }

    const elements = Object.fromEntries(
      Object.entries(ELEMENT_SELECTORS).map(([name, selector]) => [
        name,
        documentRef.querySelector(selector),
      ])
    );
    const missing = Object.entries(elements)
      .filter(([, element]) => !element)
      .map(([name]) => `${name} (${ELEMENT_SELECTORS[name]})`);
    if (strict && missing.length) {
      throw new Error(`页面缺少必要控件：${missing.join("、")}`);
    }
    return elements;
  }

  return { ELEMENT_SELECTORS, collect };
});
