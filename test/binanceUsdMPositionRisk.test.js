const assert = require("node:assert/strict");
const test = require("node:test");
const WebSocket = require("ws");
const { BinanceApiError } = require("../src/binance/binanceClientBase");
const { BinanceUsdMClient } = require("../src/binance/binanceUsdMClient");

function createClient() {
  return new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
  });
}

test("U 本位持仓查询优先使用 v2/account.position 并归一化字段", async () => {
  const client = createClient();
  let request;
  client.signedWsOrRest = async (...args) => {
    request = args;
    return [{
      symbol: "btcusdt",
      positionAmt: "-0.010",
      unRealizedProfit: "1.25",
      marginType: "CROSSED",
    }, {
      symbol: "ethusdt",
      positionAmt: "0.20",
      unrealizedProfit: "-0.75",
      marginType: "isolated",
    }];
  };

  const result = await client.positionRisk({ symbol: "btcusdt" });

  assert.equal(request[0], "v2/account.position");
  assert.equal(request[1], "GET");
  assert.equal(request[2], "/fapi/v3/positionRisk");
  assert.deepEqual(request[3], { symbol: "BTCUSDT" });
  assert.deepEqual(request[4], { retrySafe: true, critical: true });
  assert.deepEqual(result.map((position) => ({
    symbol: position.symbol,
    positionAmt: position.positionAmt,
    unrealizedProfit: position.unrealizedProfit,
    unRealizedProfit: position.unRealizedProfit,
    marginType: position.marginType,
    isolated: position.isolated,
  })), [{
    symbol: "BTCUSDT",
    positionAmt: "-0.010",
    unrealizedProfit: "1.25",
    unRealizedProfit: "1.25",
    marginType: "cross",
    isolated: false,
  }, {
    symbol: "ETHUSDT",
    positionAmt: "0.20",
    unrealizedProfit: "-0.75",
    unRealizedProfit: "-0.75",
    marginType: "isolated",
    isolated: true,
  }]);
  client.close();
});

test("U 本位账户查询使用更轻量的 v2/account.status 并保留 REST 降级", async () => {
  const client = createClient();
  let request;
  client.signedWsOrRest = async (...args) => {
    request = args;
    return {
      totalWalletBalance: "100",
      totalMarginBalance: "101",
      availableBalance: "90",
      totalUnrealizedProfit: "1",
      totalInitialMargin: "11",
      positions: [],
      assets: [],
    };
  };

  const result = await client.accountStatus({ critical: true });

  assert.equal(request[0], "v2/account.status");
  assert.equal(request[1], "GET");
  assert.equal(request[2], "/fapi/v3/account");
  assert.deepEqual(request[3], {});
  assert.deepEqual(request[4], { retrySafe: true, critical: true });
  assert.equal(result.totalWalletBalance, "100");
  assert.deepEqual(result.positions, []);
  client.close();
});

test("U 本位账户新版 WS 方法不受节点支持时安全降级到 V3 REST", async () => {
  const client = createClient();
  client.signedWsOrRest = async () => {
    throw new BinanceApiError("Method not found", {
      status: 400,
      code: -1,
      data: { id: "request-id", error: { code: -1, msg: "Method not found" } },
    });
  };
  let restRequest;
  client.signedRest = async (...args) => {
    restRequest = args;
    return {
      totalWalletBalance: "100",
      totalMarginBalance: "101",
      availableBalance: "90",
      totalUnrealizedProfit: "1",
      totalInitialMargin: "11",
      positions: [],
      assets: [],
    };
  };

  const result = await client.accountStatus({ critical: true });

  assert.deepEqual(restRequest, [
    "GET",
    "/fapi/v3/account",
    {},
    { critical: true },
  ]);
  assert.equal(result.accountType, "USDⓈ-M Futures");
  client.close();
});

test("U 本位持仓 GET 在 WebSocket 传输失败后安全降级到 REST", async () => {
  const client = createClient();
  client.ensureTradingServerTime = async () => {};
  const socket = {
    readyState: WebSocket.OPEN,
    terminate() {
      this.readyState = WebSocket.CLOSED;
    },
  };
  client.tradingWsApiSocket = socket;
  client.getPersistentWsApiSocket = () => socket;
  client.startTradingWebSocketInBackground = () => {};
  let wsMethod;
  client.requestWsApiOnSocket = async (_socket, method) => {
    wsMethod = method;
    throw client.createWsTransportError("持仓 WebSocket 查询连接中断", {
      requestSent: true,
    });
  };
  let restRequest;
  client.request = async (...args) => {
    restRequest = args;
    return [{ symbol: "BTCUSDT", positionAmt: "0.001" }];
  };

  const result = await client.positionRisk();

  assert.equal(wsMethod, "v2/account.position");
  assert.equal(restRequest[0], "GET");
  assert.equal(restRequest[1], "/fapi/v3/positionRisk");
  assert.equal(restRequest[3], true);
  assert.equal(restRequest[5].critical, true);
  assert.equal(result[0].positionAmt, "0.001");
  client.close();
});

test("U 本位持仓查询允许显式取消关键请求标记", async () => {
  const client = createClient();
  let options;
  client.signedWsOrRest = async (...args) => {
    options = args[4];
    return [];
  };

  await client.positionRisk({ critical: false });

  assert.deepEqual(options, { retrySafe: true, critical: false });
  client.close();
});

test("U 本位持仓查询拒绝非数组响应", async () => {
  const client = createClient();
  client.signedWsOrRest = async () => ({ positions: [] });

  await assert.rejects(
    client.positionRisk(),
    (error) => error instanceof BinanceApiError &&
      error.data?.invalidField === "result"
  );
  client.close();
});

test("U 本位持仓查询拒绝缺失 symbol 或无效 positionAmt 的行", async () => {
  const client = createClient();
  const responses = [
    [{ symbol: "", positionAmt: "1" }],
    [{ symbol: "BTCUSDT", positionAmt: "not-a-number" }],
    [{ symbol: "BTCUSDT" }],
  ];
  client.signedWsOrRest = async () => responses.shift();

  await assert.rejects(
    client.positionRisk(),
    (error) => error instanceof BinanceApiError &&
      error.data?.invalidField === "result[0].symbol"
  );
  await assert.rejects(
    client.positionRisk(),
    (error) => error instanceof BinanceApiError &&
      error.data?.invalidField === "result[0].positionAmt"
  );
  await assert.rejects(
    client.positionRisk(),
    (error) => error instanceof BinanceApiError &&
      error.data?.invalidField === "result[0].positionAmt"
  );
  client.close();
});
