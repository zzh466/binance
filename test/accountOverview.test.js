const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildAccountOverview,
  classifyBinanceLatency,
  sumRealProfit,
} = require("../src/accountOverview");

test("Binance 延迟按 70ms 和 120ms 边界分级", () => {
  assert.equal(classifyBinanceLatency({ success: true, elapsedMs: 70 }).tone, "fast");
  assert.equal(classifyBinanceLatency({ success: true, elapsedMs: 70.001 }).tone, "medium");
  assert.equal(classifyBinanceLatency({ success: true, elapsedMs: 120 }).tone, "medium");
  assert.equal(classifyBinanceLatency({ success: true, elapsedMs: 120.001 }).tone, "slow");
  assert.equal(classifyBinanceLatency({ success: false, elapsedMs: 10 }).tone, "offline");
  assert.equal(
    classifyBinanceLatency({ success: false, status: 400, elapsedMs: 82 }).tone,
    "medium"
  );
  assert.equal(classifyBinanceLatency(null).label, "离线");
});

test("账号实际盈亏使用十进制精确求和", () => {
  assert.equal(sumRealProfit([
    { realProfit: "0.1" },
    { realProfit: "0.2" },
    { realProfit: null },
  ]), "0.3");
});

test("账号信息行采用登录数据、当前账号和所有账号盈利合计", () => {
  const overview = buildAccountOverview({
    session: {
      userAccount: "XQDAThz",
      futureUserName: "account-b",
      locked: false,
      thrRealProfit: "100000",
      realProfit: "31.25",
    },
    userInfo: {
      vtpLocked: false,
      accounts: [
        { futureUserName: "account-a", realProfit: "10.1" },
        {
          selected: true,
          futureUserName: "account-b",
          futureAccountStatus: "NORMAL",
          qryCommission: "0.002",
          realProfit: "21.15",
        },
      ],
    },
    latency: { success: true, elapsedMs: 83.5 },
  });

  assert.equal(overview.account, "XQDAThz");
  assert.equal(overview.managementStatus, "正常");
  assert.equal(overview.currentAccount, "account-b");
  assert.equal(overview.connectionTone, "medium");
  assert.equal(overview.commission, "0.002");
  assert.equal(overview.currentAccountProfit, "21.15");
  assert.equal(overview.actualProfit, "31.25");
  assert.equal(overview.availableFunds, "31.25");
  assert.equal(overview.liquidationLine, "100000");
  assert.equal(overview.totalActualProfit, "31.25");
});
