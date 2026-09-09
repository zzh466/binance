const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CLIENT_VERSION,
  FUTURE_ACCOUNT_TRADING_INFO_PATH,
  ManagerClientService,
  getAccountChoices,
  mergeManagerAccountInfo,
  normalizeFutureAccountTradingInfo,
  resolveSelectedAccount,
  sanitizeManagerUserInfo,
  selectPreferredMac,
} = require("../src/managerClientService");

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test("win32 优先选择以太网，其次按以太网编号选择", () => {
  const selected = selectPreferredMac({
    platform: "win32",
    networkInterfaces: {
      "Wi-Fi": [{ internal: false, mac: "aa-bb-cc-dd-ee-01" }],
      "以太网 2": [{ internal: false, mac: "aa-bb-cc-dd-ee-02" }],
      "以太网": [{ internal: false, mac: "AA-BB-CC-DD-EE-03" }],
    },
  });
  assert.deepEqual(selected, {
    name: "以太网",
    mac: "aa:bb:cc:dd:ee:03",
    priority: 0,
  });
});

test("darwin 优先选择 en0 并避开 WireGuard 虚拟网卡", () => {
  const selected = selectPreferredMac({
    platform: "darwin",
    networkInterfaces: {
      utun4: [{ internal: false, mac: "aa:bb:cc:dd:ee:04" }],
      en1: [{ internal: false, mac: "aa:bb:cc:dd:ee:01" }],
      en0: [{ internal: false, mac: "aa:bb:cc:dd:ee:00" }],
    },
  });
  assert.equal(selected.name, "en0");
  assert.equal(selected.mac, "aa:bb:cc:dd:ee:00");
});

test("登录请求包含用户输入、硬编码版本号和首选 MAC", async () => {
  const requests = [];
  const service = new ManagerClientService({
    platform: "win32",
    networkInterfaces: () => ({
      "以太网": [{ internal: false, mac: "00-1C-42-D4-1B-33" }],
    }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/user/info")) {
        return jsonResponse({
          code: "REQ_SUCCESS",
          vtpLocked: false,
          futureAccountVOList: [{
            id: null,
            futureUserName: "test4bn01",
            futureUserID: "api-key",
            futureUserPwd: "api-secret",
          }],
        });
      }
      return jsonResponse({
        code: "REQ_SUCCESS",
        locked: false,
        futureAccountVOList: [{
          id: 233,
          futureInvestorId: "api-key",
          futureUserName: "test4bn01",
        }],
      });
    },
  });

  const result = await service.login({
    userNm: "demo-user",
    userPwd: "demo-password",
  });
  assert.equal(result.device.mac, "00:1c:42:d4:1b:33");
  assert.equal(requests.length, 2);
  assert.equal(result.userInfo.futureAccountVOList[0].id, 233);
  assert.equal(
    result.userInfo.futureAccountVOList[0].futureInvestorId,
    "api-key"
  );
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.useSessionCookies, true);
  assert.equal(requests[1].options.method, "GET");
  assert.equal(requests[1].options.useSessionCookies, true);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    userNm: "demo-user",
    userPwd: "demo-password",
    appVersion: CLIENT_VERSION,
    userMAC: "00:1c:42:d4:1b:33",
  });
});

test("登录账号与用户详情按 futureInvestorId 匹配而不是数组顺序", () => {
  const merged = mergeManagerAccountInfo({
    futureAccountVOList: [
      {
        id: 233,
        accountStatus: 1,
        futureInvestorId: "api-key-a",
        futureUserName: "account-a",
        brokerId: "0000",
      },
      {
        id: 234,
        accountStatus: 2,
        futureInvestorId: "api-key-b",
        futureUserName: "account-b",
      },
    ],
  }, {
    futureAccountVOList: [
      {
        id: null,
        futureInvestorId: "api-key-b",
        futureUserName: "account-b",
        futureAccountStatus: "NORMAL",
        realProfit: "20.25",
      },
      {
        id: null,
        futureUserID: "api-key-a",
        futureUserName: "account-a",
        qryCommission: "0.001",
        realProfit: "10.5",
      },
    ],
  });

  assert.equal(merged.futureAccountVOList[0].id, 233);
  assert.equal(merged.futureAccountVOList[0].futureUserName, "account-a");
  assert.equal(merged.futureAccountVOList[0].qryCommission, "0.001");
  assert.equal(merged.futureAccountVOList[0].brokerId, "0000");
  assert.equal(merged.futureAccountVOList[1].id, 234);
  assert.equal(merged.futureAccountVOList[1].futureUserName, "account-b");
  assert.equal(merged.futureAccountVOList[1].realProfit, "20.25");
  assert.deepEqual(getAccountChoices(merged), [
    { accountKey: "233", futureUserName: "account-a" },
    { accountKey: "234", futureUserName: "account-b" },
  ]);
});

test("用户详情缺少匹配账号时仍保留两侧独有账号", () => {
  const merged = mergeManagerAccountInfo({
    futureAccountVOList: [
      { id: 1, futureInvestorId: "login-only", futureUserName: "login" },
    ],
  }, {
    futureAccountVOList: [
      { id: null, futureUserID: "detail-only", futureUserName: "detail" },
    ],
  });
  assert.equal(merged.futureAccountVOList.length, 2);
  assert.equal(merged.futureAccountVOList[0].id, 1);
  assert.equal(merged.futureAccountVOList[1].futureUserName, "detail");
});

test("账号选择列表不向页面暴露 API Key 和 Secret", () => {
  const response = {
    futureAccountVOList: [{
      id: 233,
      futureUserName: "test4bn01",
      futureUserID: "api-key",
      futureUserPwd: "api-secret",
    }],
  };
  assert.deepEqual(getAccountChoices(response), [{
    accountKey: "233",
    futureUserName: "test4bn01",
  }]);
  assert.equal(resolveSelectedAccount(response, "233").futureUserID, "api-key");
});

test("管理端用户账户信息保留身份配置但不采用其资金指标", () => {
  const sanitized = sanitizeManagerUserInfo({
    vtpUserId: 114,
    vtpUserNm: "新期数字资产韩喆",
    groupId: 33,
    futureAccountVOList: [{
      id: null,
      futureUserName: "test4bn01",
      futureUserID: "api-key",
      futureUserPwd: "api-secret",
      futureAuthCode: "auth-secret",
      futureAccountStatus: "NORMAL",
      balance: 12.5,
      qryCommission: 0.002,
    }],
  }, "test4bn01");

  assert.equal(sanitized.accounts[0].selected, true);
  assert.equal("balance" in sanitized.accounts[0], false);
  assert.equal(sanitized.accounts[0].qryCommission, 0.002);
  assert.equal("futureUserID" in sanitized.accounts[0], false);
  assert.equal("futureUserPwd" in sanitized.accounts[0], false);
  assert.equal("futureAuthCode" in sanitized.accounts[0], false);
});

test("系统配置接口读取两个 LinkID", async () => {
  const requestedUrls = [];
  const service = new ManagerClientService({
    networkInterfaces: () => ({}),
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      const propertyKey = decodeURIComponent(url.split("/").at(-1));
      return jsonResponse({
        code: "REQ_SUCCESS",
        propertyKey,
        propertyValue: propertyKey === "BINANCE_SPOT_LINK_ID"
          ? "spot-code"
          : "futures-code",
      });
    },
  });
  assert.deepEqual(await service.getTradingConfiguration(), {
    BINANCE_SPOT_LINK_ID: "spot-code",
    BINANCE_FUTURES_LINK_ID: "futures-code",
  });
  assert.equal(requestedUrls.length, 2);
});

test("账号交易指标使用 PATCH 且不会携带密钥", async () => {
  const requests = [];
  const service = new ManagerClientService({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ code: "REQ_SUCCESS", msg: "响应成功" });
    },
  });

  await service.updateFutureAccountTradingInfo({
    id: "233",
    staticBalance: "100.25",
    balance: "101.5",
    available: "88.75",
    closeProfit: "2.5",
    commission: "0.25",
    deviation: "0",
    margin: "12.75",
    openVolume: 2,
    orderVolume: 3,
    positionProfit: "-1",
    realProfit: "1.25",
    futureUserPwd: "不得发送",
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `http://139.196.41.155:8082/vtpmanagerapi${FUTURE_ACCOUNT_TRADING_INFO_PATH}`
  );
  assert.equal(requests[0].options.method, "PATCH");
  assert.equal(requests[0].options.useSessionCookies, true);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    id: 233,
    staticBalance: 100.25,
    balance: 101.5,
    available: 88.75,
    closeProfit: 2.5,
    commission: 0.25,
    deviation: 0,
    margin: 12.75,
    positionProfit: -1,
    realProfit: 1.25,
    openVolume: 2,
    orderVolume: 3,
  });
});

test("账号资金同步拒绝无效 id 和非数字资金字段", () => {
  assert.throws(
    () => normalizeFutureAccountTradingInfo({
      id: null,
      staticBalance: 1,
      balance: 1,
      available: 1,
      closeProfit: 1,
      commission: 1,
      deviation: 0,
      margin: 1,
      openVolume: 1,
      orderVolume: 1,
      positionProfit: 1,
      realProfit: 1,
    }),
    /账号 id/
  );
  assert.throws(
    () => normalizeFutureAccountTradingInfo({
      id: 233,
      staticBalance: 1,
      balance: "not-a-number",
      available: 1,
      closeProfit: 1,
      commission: 1,
      deviation: 0,
      margin: 1,
      openVolume: 1,
      orderVolume: 1,
      positionProfit: 1,
      realProfit: 1,
    }),
    /balance/
  );
  assert.throws(
    () => normalizeFutureAccountTradingInfo({
      id: 233,
      staticBalance: 1,
      balance: 1,
      available: null,
      closeProfit: 1,
      commission: 1,
      deviation: 0,
      margin: 1,
      openVolume: 1,
      orderVolume: 1,
      positionProfit: 1,
      realProfit: 1,
    }),
    /available/
  );
  assert.throws(
    () => normalizeFutureAccountTradingInfo({
      id: 233,
      staticBalance: 1,
      balance: 1,
      available: 1,
      closeProfit: 1,
      commission: 1,
      deviation: 0,
      margin: 1,
      openVolume: 0.001,
      orderVolume: 1,
      positionProfit: 1,
      realProfit: 1,
    }),
    /openVolume/
  );
});
