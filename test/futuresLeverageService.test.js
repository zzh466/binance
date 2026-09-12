const assert = require("node:assert/strict");
const test = require("node:test");
const {
  loadFuturesLeverageCache,
  queryFuturesLeverage,
  resolveFuturesLeverageScope,
  setFuturesLeverage,
} = require("../src/futuresLeverageService");

const scope = {
  environment: "production",
  account: "future-account-1",
  accountScopeType: "futureAccountId",
};

test("杠杆存储优先按管理端账号隔离并后备到非敏感指纹", () => {
  assert.deepEqual(resolveFuturesLeverageScope({
    testnet: true,
    futureAccountId: 42,
    accountFingerprint: "hash-fallback",
  }), {
    environment: "testnet",
    account: "42",
    accountScopeType: "futureAccountId",
  });
  assert.deepEqual(resolveFuturesLeverageScope({
    testnet: false,
    futureAccountId: "",
    accountFingerprint: "hash-fallback",
  }), {
    environment: "production",
    account: "hash-fallback",
    accountScopeType: "apiKeyFingerprint",
  });
  assert.throws(
    () => resolveFuturesLeverageScope({ testnet: false }),
    /非敏感标识/
  );
});

test("本地杠杆缓存无需网络即可快速读取", () => {
  const store = {
    get(receivedScope) {
      assert.deepEqual(receivedScope, { ...scope, symbol: "BTCUSDT" });
      return { leverage: 12, updatedAt: 1_000 };
    },
  };

  const result = loadFuturesLeverageCache({
    store,
    scope,
    symbol: "btcusdt",
  });

  assert.equal(result.symbol, "BTCUSDT");
  assert.equal(result.environment, "production");
  assert.equal(result.accountScope, "future-account-1");
  assert.deepEqual(result.cached, { leverage: 12, updatedAt: 1_000 });
  assert.equal(result.savedLeverage, 12);
  assert.equal(result.source, "appData");
  assert.equal(result.persistence.ok, true);
});

test("Binance 杠杆查询同时返回实际值和本地缓存", async () => {
  const client = {
    async leverageConfig(symbol) {
      assert.equal(symbol, "BTCUSDT");
      return {
        marketType: "futures",
        symbol,
        leverage: 20,
        currentLeverage: 20,
        maxLeverage: 125,
        options: [1, 2, 3],
        maxNotionalValue: "1000000",
      };
    },
  };
  const store = {
    get() {
      return { leverage: 10, updatedAt: 2_000 };
    },
    set(receivedScope, leverage) {
      assert.deepEqual(receivedScope, { ...scope, symbol: "BTCUSDT" });
      assert.equal(leverage, 20);
      return { ...receivedScope, leverage, updatedAt: 2_500 };
    },
  };

  const result = await queryFuturesLeverage({
    client,
    store,
    scope,
    symbol: "BTCUSDT",
  });

  assert.equal(result.currentLeverage, 20);
  assert.equal(result.leverage, 20);
  assert.equal(result.savedLeverage, 20);
  assert.deepEqual(result.cached, { leverage: 10, updatedAt: 2_000 });
  assert.equal(result.source, "binance");
  assert.equal(result.persistence.ok, true);
  assert.equal(result.persistence.saved, true);
  assert.equal(result.persistence.updatedAt, 2_500);
});

test("Binance 查询成功但校准写盘失败时仍返回当前真实杠杆", async () => {
  const client = {
    async leverageConfig() {
      return {
        marketType: "futures",
        symbol: "BTCUSDT",
        leverage: 35,
        currentLeverage: 35,
        maxLeverage: 125,
        options: [1, 35, 125],
      };
    },
  };
  const store = {
    get() {
      return { leverage: 20, updatedAt: 2_000 };
    },
    set() {
      const error = new Error("read only filesystem");
      error.code = "EROFS";
      throw error;
    },
  };

  const result = await queryFuturesLeverage({
    client,
    store,
    scope,
    symbol: "BTCUSDT",
  });

  assert.equal(result.currentLeverage, 35);
  assert.deepEqual(result.cached, { leverage: 20, updatedAt: 2_000 });
  assert.equal(result.savedLeverage, 20);
  assert.equal(result.persistence.ok, false);
  assert.equal(result.persistence.saved, false);
  assert.equal(result.persistence.error.code, "EROFS");
});

test("Binance 设置失败时绝不写入本地杠杆", async () => {
  const binanceError = new Error("Binance rejected leverage");
  let writeCount = 0;
  const client = {
    async setLeverage() {
      throw binanceError;
    },
  };
  const store = {
    set() {
      writeCount += 1;
    },
  };

  await assert.rejects(
    setFuturesLeverage({
      client,
      store,
      scope,
      symbol: "BTCUSDT",
      leverage: 25,
    }),
    binanceError
  );
  assert.equal(writeCount, 0);
});

test("Binance 设置成功后写盘并返回明确持久化状态", async () => {
  const client = {
    async setLeverage() {
      return {
        marketType: "futures",
        symbol: "BTCUSDT",
        leverage: 25,
        currentLeverage: 25,
        maxNotionalValue: "500000",
      };
    },
  };
  const store = {
    set(receivedScope, leverage) {
      assert.deepEqual(receivedScope, { ...scope, symbol: "BTCUSDT" });
      assert.equal(leverage, 25);
      return { ...receivedScope, leverage, updatedAt: 3_000 };
    },
  };

  const result = await setFuturesLeverage({
    client,
    store,
    scope,
    symbol: "BTCUSDT",
    leverage: 25,
  });

  assert.equal(result.applied, true);
  assert.equal(result.leverage, 25);
  assert.equal(result.persistence.ok, true);
  assert.equal(result.persistence.saved, true);
  assert.equal(result.savedLeverage, 25);
});

test("Binance 已设置但写盘失败时保持 applied:true 并单列错误", async () => {
  const client = {
    async setLeverage() {
      return {
        marketType: "futures",
        symbol: "BTCUSDT",
        leverage: 30,
        currentLeverage: 30,
        maxNotionalValue: "250000",
      };
    },
  };
  const store = {
    set() {
      const error = new Error("disk full");
      error.code = "ENOSPC";
      throw error;
    },
  };

  const result = await setFuturesLeverage({
    client,
    store,
    scope,
    symbol: "BTCUSDT",
    leverage: 30,
  });

  assert.equal(result.applied, true);
  assert.equal(result.leverage, 30);
  assert.equal(result.persistence.ok, false);
  assert.equal(result.persistence.saved, false);
  assert.equal(result.persistence.error.code, "ENOSPC");
  assert.equal(result.cached, null);
});
