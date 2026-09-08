const os = require("node:os");

const CLIENT_VERSION = "990812b";
const MANAGER_API_BASE_URL = "http://139.196.41.155:8082/vtpmanagerapi";
const LOGIN_PATH = "/access/loginClientDAT";
const USER_INFO_PATH = "/user/info";
const PROPERTY_PATH = "/property/info";
const REQUIRED_PROPERTY_KEYS = [
  "BINANCE_SPOT_LINK_ID",
  "BINANCE_FUTURES_LINK_ID",
];

class ManagerApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "ManagerApiError";
    this.status = status;
    this.code = code;
  }
}

function normalizeMacAddress(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, ":");
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalized)) return "";
  if (normalized === "00:00:00:00:00:00") return "";
  return normalized;
}

function interfaceNamePriority(name, platform = process.platform) {
  const value = String(name || "").trim();
  const compact = value.replace(/\s+/g, "");
  let match = compact.match(/^以太网(\d*)$/i);
  if (match) return Number(match[1] || 1) - 1;

  match = compact.match(/^ethernet(\d*)$/i);
  if (match) return 100 + Number(match[1] || 1) - 1;

  match = compact.match(/^en(\d+)$/i);
  if (match) return 200 + Number(match[1]);

  if (/^(wi-?fi|wlan|无线网络连接)/i.test(compact)) return 400;
  if (/^(utun|tun|tap|wg|wireguard|vpn|vmnet|vbox|docker|hyper-v)/i.test(compact)) {
    return 900;
  }
  return platform === "win32" ? 300 : 350;
}

function selectPreferredMac({
  networkInterfaces = os.networkInterfaces(),
  platform = process.platform,
} = {}) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces || {})) {
    for (const address of addresses || []) {
      if (address?.internal) continue;
      const mac = normalizeMacAddress(address?.mac);
      if (!mac) continue;
      candidates.push({
        name,
        mac,
        priority: interfaceNamePriority(name, platform),
      });
    }
  }

  candidates.sort((left, right) =>
    left.priority - right.priority ||
    left.name.localeCompare(right.name, "zh-CN") ||
    left.mac.localeCompare(right.mac)
  );
  return candidates[0] || null;
}

function normalizePropertyValue(value) {
  if (typeof value !== "string") {
    if (value === undefined || value === null) return "";
    return String(value).trim();
  }
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed.trim() : trimmed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function validateSuccessfulResponse(payload, response, operation) {
  if (!response.ok) {
    throw new ManagerApiError(`${operation}失败：HTTP ${response.status}`, {
      status: response.status,
      code: payload?.code,
    });
  }
  if (payload?.code !== "REQ_SUCCESS") {
    throw new ManagerApiError(
      payload?.msg || `${operation}失败：管理端返回非成功状态`,
      { status: response.status, code: payload?.code }
    );
  }
  return payload;
}

function getAccountChoices(loginResponse = {}) {
  const accounts = Array.isArray(loginResponse.futureAccountVOList)
    ? loginResponse.futureAccountVOList
    : [];
  return accounts.map((account, index) => ({
    accountKey: String(account.id ?? index),
    futureUserName: String(account.futureUserName || `账号 ${index + 1}`),
  }));
}

function getAccountApiKey(account = {}) {
  return String(
    account.futureInvestorId ||
    account.futureUserID ||
    account.futureUserId ||
    ""
  ).trim();
}

function mergeNonNullFields(base = {}, extra = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null) {
      merged[key] = value;
    } else if (!(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeManagerAccountInfo(loginResponse = {}, userInfo = {}) {
  const loginAccounts = Array.isArray(loginResponse.futureAccountVOList)
    ? loginResponse.futureAccountVOList
    : [];
  const detailAccounts = Array.isArray(userInfo.futureAccountVOList)
    ? userInfo.futureAccountVOList
    : [];
  const detailByApiKey = new Map();

  for (const detailAccount of detailAccounts) {
    const apiKey = getAccountApiKey(detailAccount);
    if (apiKey) detailByApiKey.set(apiKey, detailAccount);
  }

  const matchedDetailAccounts = new Set();
  const mergedAccounts = loginAccounts.map((loginAccount) => {
    const apiKey = getAccountApiKey(loginAccount);
    const detailAccount = apiKey ? detailByApiKey.get(apiKey) : null;
    if (!detailAccount) return { ...loginAccount };
    matchedDetailAccounts.add(detailAccount);
    return mergeNonNullFields(loginAccount, detailAccount);
  });

  for (const detailAccount of detailAccounts) {
    if (!matchedDetailAccounts.has(detailAccount)) {
      mergedAccounts.push({ ...detailAccount });
    }
  }

  return {
    ...userInfo,
    futureAccountVOList: mergedAccounts,
  };
}

function resolveSelectedAccount(loginResponse = {}, accountKey) {
  const accounts = Array.isArray(loginResponse.futureAccountVOList)
    ? loginResponse.futureAccountVOList
    : [];
  const index = accounts.findIndex(
    (account, accountIndex) => String(account.id ?? accountIndex) === String(accountKey)
  );
  const account = index >= 0 ? accounts[index] : null;
  if (!account) throw new ManagerApiError("所选交易账号不存在，请重新登录。");

  const apiKey = getAccountApiKey(account);
  const apiSecret = String(account.futureUserPwd || "").trim();
  if (!apiKey || !apiSecret) {
    throw new ManagerApiError(
      "所选账号缺少 futureInvestorId/futureUserID 或 futureUserPwd。"
    );
  }
  return account;
}

function sanitizeManagerUserInfo(userInfo = {}, selectedFutureUserName = "") {
  const accounts = Array.isArray(userInfo.futureAccountVOList)
    ? userInfo.futureAccountVOList
    : [];
  return {
    vtpUserId: userInfo.vtpUserId,
    vtpUserNm: userInfo.vtpUserNm,
    groupId: userInfo.groupId,
    vtpUserAccount: userInfo.vtpUserAccount,
    vtpLocked: userInfo.vtpLocked,
    vtpThrRealProfit: userInfo.vtpThrRealProfit,
    vtpRoleCode: userInfo.vtpRoleCode,
    vtpPoints: userInfo.vtpPoints,
    subscribeIndicator: userInfo.subscribeIndicator,
    indicator: userInfo.indicator,
    realProfit: userInfo.realProfit,
    instrumentConfigCount: Array.isArray(userInfo.instrumentConfigVOList)
      ? userInfo.instrumentConfigVOList.length
      : 0,
    accounts: accounts.map((account, index) => ({
      accountKey: String(account.id ?? index),
      id: account.id,
      selected: String(account.futureUserName || "") === selectedFutureUserName,
      futureUserName: account.futureUserName,
      accountStatus: account.accountStatus,
      futureAccountStatus:
        account.futureAccountStatus ?? account.accountStatus,
      roleCode: account.roleCode,
      regular: account.regular,
      puppet: account.puppet,
      tradeProxyCode: account.tradeProxyCode,
      futureBrokerId: account.futureBrokerId ?? account.brokerId,
      futureAppId: account.futureAppId ?? account.appId,
      tradeAddr: account.tradeAddr,
      margin: account.margin,
      closeProfit: account.closeProfit,
      openVolume: account.openVolume,
      orderVolume: account.orderVolume,
      qryCommission: account.qryCommission,
      instrumentOpenInterest: account.instrumentOpenInterest,
    })),
  };
}

class ManagerClientService {
  constructor({
    fetchImpl,
    baseUrl = MANAGER_API_BASE_URL,
    clientVersion = CLIENT_VERSION,
    platform = process.platform,
    networkInterfaces = () => os.networkInterfaces(),
    requestTimeoutMs = 10_000,
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("ManagerClientService 需要 fetchImpl。");
    }
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.clientVersion = clientVersion;
    this.platform = platform;
    this.networkInterfaces = networkInterfaces;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  getDeviceIdentity() {
    const selected = selectPreferredMac({
      networkInterfaces: this.networkInterfaces(),
      platform: this.platform,
    });
    if (!selected) {
      throw new ManagerApiError("未找到可用的非本地网卡 MAC 地址，无法登录。");
    }
    return selected;
  }

  async requestJson(pathname, { method = "GET", body, operation } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        useSessionCookies: true,
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      const detail = error?.name === "AbortError" ? "请求超时" : error?.message;
      throw new ManagerApiError(`${operation || "管理端请求"}失败：${detail || "网络错误"}`);
    } finally {
      clearTimeout(timeout);
    }

    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw new ManagerApiError(`${operation || "管理端请求"}失败：响应不是有效 JSON`, {
        status: response.status,
      });
    }
    return validateSuccessfulResponse(payload, response, operation || "管理端请求");
  }

  async login({ userNm, userPwd }) {
    const normalizedUserName = String(userNm || "").trim();
    const normalizedPassword = String(userPwd || "");
    if (!normalizedUserName || !normalizedPassword) {
      throw new ManagerApiError("请输入用户名和密码。");
    }
    const device = this.getDeviceIdentity();
    const response = await this.requestJson(LOGIN_PATH, {
      method: "POST",
      operation: "客户端登录",
      body: {
        userNm: normalizedUserName,
        userPwd: normalizedPassword,
        appVersion: this.clientVersion,
        userMAC: device.mac,
      },
    });
    if (response.locked === true) {
      throw new ManagerApiError("当前用户已被锁定，请联系管理端管理员。");
    }
    const rawUserInfo = await this.getUserInfo();
    if (rawUserInfo.vtpLocked === true) {
      throw new ManagerApiError("当前用户已被锁定，请联系管理端管理员。");
    }
    const userInfo = mergeManagerAccountInfo(response, rawUserInfo);
    if (!getAccountChoices(userInfo).length) {
      throw new ManagerApiError(
        "用户信息接口没有返回可用的 Binance 交易账号。"
      );
    }
    return { response, userInfo, device };
  }

  async getUserInfo() {
    return this.requestJson(USER_INFO_PATH, {
      operation: "读取用户和账户信息",
    });
  }

  async getProperty(key) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) throw new TypeError("系统配置 key 不能为空。");
    const response = await this.requestJson(
      `${PROPERTY_PATH}/${encodeURIComponent(normalizedKey)}`,
      { operation: `读取系统配置 ${normalizedKey}` }
    );
    const propertyValue = normalizePropertyValue(response.propertyValue);
    if (!propertyValue) {
      throw new ManagerApiError(`系统配置 ${normalizedKey} 的 propertyValue 为空。`, {
        code: response.code,
      });
    }
    return propertyValue;
  }

  async getTradingConfiguration() {
    const values = await Promise.all(
      REQUIRED_PROPERTY_KEYS.map((key) => this.getProperty(key))
    );
    return Object.fromEntries(
      REQUIRED_PROPERTY_KEYS.map((key, index) => [key, values[index]])
    );
  }
}

module.exports = {
  CLIENT_VERSION,
  LOGIN_PATH,
  MANAGER_API_BASE_URL,
  USER_INFO_PATH,
  ManagerApiError,
  ManagerClientService,
  getAccountChoices,
  getAccountApiKey,
  interfaceNamePriority,
  normalizeMacAddress,
  normalizePropertyValue,
  mergeManagerAccountInfo,
  resolveSelectedAccount,
  sanitizeManagerUserInfo,
  selectPreferredMac,
};
