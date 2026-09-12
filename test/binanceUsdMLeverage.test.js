const assert = require("node:assert/strict");
const test = require("node:test");
const { BinanceApiError } = require("../src/binance/binanceClientBase");
const {
  BinanceUsdMClient,
} = require("../src/binance/binanceUsdMClient");
const {
  BinanceUnifiedClient,
} = require("../src/binance/binanceUnifiedClient");

function leverageBracket(symbol = "BTCUSDT") {
  return {
    symbol,
    brackets: [
      {
        bracket: 1,
        initialLeverage: 125,
        notionalCap: "50000",
        notionalFloor: "0",
        maintMarginRatio: "0.004",
      },
      {
        bracket: 2,
        initialLeverage: 100,
        notionalCap: "250000",
        notionalFloor: "50000",
        maintMarginRatio: "0.005",
      },
    ],
  };
}

test("U 本位杠杆查询并行读取 leverageBracket 和 symbolConfig", async () => {
  const client = new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
  });
  const requests = [];
  client.signedRest = async (method, path, params) => {
    requests.push({ method, path, params });
    if (path === "/fapi/v1/leverageBracket") {
      return [leverageBracket()];
    }
    if (path === "/fapi/v1/symbolConfig") {
      return [{
        symbol: "BTCUSDT",
        marginType: "CROSSED",
        leverage: 20,
        maxNotionalValue: "1000000",
      }];
    }
    throw new Error(`unexpected path: ${path}`);
  };

  const result = await client.leverageConfig("btcusdt");

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/fapi/v1/leverageBracket",
      params: { symbol: "BTCUSDT" },
    },
    {
      method: "GET",
      path: "/fapi/v1/symbolConfig",
      params: { symbol: "BTCUSDT" },
    },
  ]);
  assert.equal(result.marketType, "futures");
  assert.equal(result.symbol, "BTCUSDT");
  assert.equal(result.leverage, 20);
  assert.equal(result.currentLeverage, 20);
  assert.equal(result.maxLeverage, 125);
  assert.equal(result.options.length, 125);
  assert.deepEqual(result.options.slice(0, 3), [1, 2, 3]);
  assert.deepEqual(result.options.slice(-2), [124, 125]);
  assert.equal(result.maxNotionalValue, "1000000");
  assert.equal(result.leverageBracket.symbol, "BTCUSDT");
  assert.equal(result.symbolConfig.marginType, "CROSSED");
  client.close();
});

test("U 本位杠杆查询拒绝缺失目标合约或无效档位", async () => {
  const client = new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
  });
  client.signedRest = async (_method, path) => {
    if (path === "/fapi/v1/leverageBracket") {
      return [{ symbol: "ETHUSDT", brackets: [] }];
    }
    return [{ symbol: "BTCUSDT", leverage: 20 }];
  };

  await assert.rejects(
    client.leverageConfig("BTCUSDT"),
    (error) => error instanceof BinanceApiError &&
      /leverageBracket.*BTCUSDT/.test(error.message)
  );
  client.close();
});

test("U 本位设置杠杆只向 POST leverage 发送整数", async () => {
  const client = new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
  });
  let request = null;
  client.signedRest = async (method, path, params) => {
    request = { method, path, params };
    return {
      symbol: "BTCUSDT",
      leverage: 25,
      maxNotionalValue: "500000",
    };
  };

  const result = await client.setLeverage("btcusdt", "25");

  assert.deepEqual(request, {
    method: "POST",
    path: "/fapi/v1/leverage",
    params: { symbol: "BTCUSDT", leverage: 25 },
  });
  assert.equal(result.applied, true);
  assert.equal(result.leverage, 25);
  assert.equal(result.currentLeverage, 25);
  assert.equal(result.maxNotionalValue, "500000");
  client.close();
});

test("U 本位设置杠杆在请求前拒绝小数和越界值", async () => {
  const client = new BinanceUsdMClient({
    apiKey: "future-key",
    apiSecret: "future-secret",
  });
  let requestCount = 0;
  client.signedRest = async () => {
    requestCount += 1;
    return {};
  };

  await assert.rejects(client.setLeverage("BTCUSDT", 2.5), /1-125 的整数/);
  await assert.rejects(client.setLeverage("BTCUSDT", 126), /1-125 的整数/);
  assert.equal(requestCount, 0);
  client.close();
});

test("统一客户端将杠杆查询与设置限定到 U 本位客户端", async () => {
  const client = new BinanceUnifiedClient();
  client.futures.leverageConfig = async (symbol) => ({
    symbol,
    leverage: 10,
    currentLeverage: 10,
  });
  client.futures.setLeverage = async (symbol, leverage) => ({
    symbol,
    leverage,
    applied: true,
  });

  const queried = await client.leverageConfig("BTCUSDT");
  const applied = await client.setLeverage("BTCUSDT", 15);

  assert.equal(queried.marketType, "futures");
  assert.equal(queried.currentLeverage, 10);
  assert.equal(applied.marketType, "futures");
  assert.equal(applied.leverage, 15);
  client.close();
});
