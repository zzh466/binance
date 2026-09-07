const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CLIENT_VERSION,
  ManagerClientService,
  getAccountChoices,
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
        futureAccountVOList: [{ id: 233, futureUserName: "test4bn01" }],
      });
    },
  });

  const result = await service.login({
    userNm: "demo-user",
    userPwd: "demo-password",
  });
  assert.equal(result.device.mac, "00:1c:42:d4:1b:33");
  assert.equal(requests.length, 2);
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

test("用户账户信息会保留交易指标但移除密钥和授权码", () => {
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
  assert.equal(sanitized.accounts[0].balance, 12.5);
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
