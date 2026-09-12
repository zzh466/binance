const fs = require("node:fs");
const path = require("node:path");

const LEVERAGE_CONFIG_VERSION = 1;
const LEVERAGE_CONFIG_DIRECTORY = "Binance统一交易台";
const LEVERAGE_CONFIG_FILENAME = "leverage-settings.json";
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_STALE_LOCK_MS = 30_000;

function waitSynchronously(milliseconds) {
  const timeout = Math.max(1, Math.floor(Number(milliseconds) || 1));
  if (typeof SharedArrayBuffer === "function" && typeof Atomics?.wait === "function") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout);
    return;
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // Node 运行时始终支持 Atomics.wait；此分支仅用于极旧运行时后备。
  }
}

function resolveLeverageConfigPath(
  appDataPath,
  { platform = process.platform } = {}
) {
  const basePath = String(appDataPath || "").trim();
  if (!basePath) {
    throw new TypeError("appData 路径不能为空。");
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(
    basePath,
    LEVERAGE_CONFIG_DIRECTORY,
    LEVERAGE_CONFIG_FILENAME
  );
}

function normalizeLeverageScope({ environment, account, symbol } = {}) {
  const normalizedEnvironment = String(environment || "").trim().toLowerCase();
  if (!["testnet", "production"].includes(normalizedEnvironment)) {
    throw new TypeError("杠杆配置环境必须是 testnet 或 production。");
  }

  const normalizedAccount = String(account || "").trim();
  if (!normalizedAccount || normalizedAccount.length > 256) {
    throw new TypeError("杠杆配置必须提供有效账号范围。");
  }

  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(normalizedSymbol)) {
    throw new TypeError(`杠杆配置交易对格式非法：${symbol}`);
  }

  return {
    environment: normalizedEnvironment,
    account: normalizedAccount,
    symbol: normalizedSymbol,
  };
}

function normalizeLeverage(leverage) {
  const normalized = Number(leverage);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 125) {
    throw new TypeError("U 本位杠杆必须是 1-125 的整数。");
  }
  return normalized;
}

function leverageScopeKey(scope) {
  const normalized = normalizeLeverageScope(scope);
  return JSON.stringify([
    normalized.environment,
    normalized.account,
    normalized.symbol,
  ]);
}

function normalizeStoredEntry(entry) {
  try {
    const scope = normalizeLeverageScope(entry);
    const leverage = normalizeLeverage(entry?.leverage);
    const updatedAt = Number(entry?.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    return { ...scope, leverage, updatedAt };
  } catch {
    return null;
  }
}

class LeverageConfigStore {
  constructor(filePath, {
    now = () => Date.now(),
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    lockRetryMs = DEFAULT_LOCK_RETRY_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
  } = {}) {
    this.filePath = String(filePath || "").trim();
    this.now = now;
    this.lockTimeoutMs = Math.max(1, Number(lockTimeoutMs) || DEFAULT_LOCK_TIMEOUT_MS);
    this.lockRetryMs = Math.max(1, Number(lockRetryMs) || DEFAULT_LOCK_RETRY_MS);
    this.staleLockMs = Math.max(1, Number(staleLockMs) || DEFAULT_STALE_LOCK_MS);
    this.entries = new Map();
    this.load();
  }

  readDiskEntries() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return new Map();
    try {
      const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      const result = new Map();
      for (const candidate of entries) {
        const entry = normalizeStoredEntry(candidate);
        if (entry) result.set(leverageScopeKey(entry), entry);
      }
      return result;
    } catch {
      return null;
    }
  }

  load() {
    const diskEntries = this.readDiskEntries();
    // 无效或不完整的本地文件不能阻塞从 Binance 读取真实杠杆。
    this.entries = diskEntries || new Map();
  }

  mergeDiskEntries() {
    const diskEntries = this.readDiskEntries();
    if (!diskEntries) return;
    for (const [key, diskEntry] of diskEntries) {
      const localEntry = this.entries.get(key);
      if (!localEntry || diskEntry.updatedAt >= localEntry.updatedAt) {
        this.entries.set(key, diskEntry);
      }
    }
  }

  get(scope) {
    // 其他应用实例可能刚写入同一个 appData 文件，读取时轻量合并。
    this.mergeDiskEntries();
    const entry = this.entries.get(leverageScopeKey(scope));
    return entry ? { ...entry } : null;
  }

  set(scope, leverage) {
    const normalizedScope = normalizeLeverageScope(scope);
    const normalizedLeverage = normalizeLeverage(leverage);
    return this.withWriteLock(() => {
      // 锁内重新读取并合并，避免多个应用实例各自用旧快照覆盖别的账号。
      this.mergeDiskEntries();
      const key = leverageScopeKey(normalizedScope);
      const previous = this.entries.get(key);
      const requestedTimestamp = Number(this.now());
      const updatedAt = Math.max(
        Number.isFinite(requestedTimestamp) && requestedTimestamp > 0
          ? requestedTimestamp
          : Date.now(),
        Number(previous?.updatedAt || 0) + 1
      );
      const record = {
        ...normalizedScope,
        leverage: normalizedLeverage,
        updatedAt,
      };
      this.entries.set(key, record);
      try {
        this.flush();
      } catch (error) {
        if (previous) this.entries.set(key, previous);
        else this.entries.delete(key);
        throw error;
      }
      return { ...record };
    });
  }

  withWriteLock(action) {
    if (!this.filePath) {
      throw new TypeError("杠杆配置文件路径不能为空。");
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (ageMs >= this.staleLockMs) {
            fs.rmdirSync(lockPath);
            continue;
          }
        } catch (lockError) {
          if (!["ENOENT", "ENOTDIR", "ENOTEMPTY"].includes(lockError?.code)) {
            throw lockError;
          }
          if (lockError?.code === "ENOENT") continue;
        }
        if (Date.now() >= deadline) {
          const timeoutError = new Error("等待杠杆配置文件锁超时。");
          timeoutError.code = "ELOCKTIMEOUT";
          throw timeoutError;
        }
        waitSynchronously(this.lockRetryMs);
      }
    }

    try {
      return action();
    } finally {
      try {
        fs.rmdirSync(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  list() {
    return [...this.entries.values()]
      .sort((left, right) => {
        const leftKey = leverageScopeKey(left);
        const rightKey = leverageScopeKey(right);
        return leftKey.localeCompare(rightKey);
      })
      .map((entry) => ({ ...entry }));
  }

  flush() {
    if (!this.filePath) {
      throw new TypeError("杠杆配置文件路径不能为空。");
    }
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = {
      version: LEVERAGE_CONFIG_VERSION,
      entries: this.list(),
    };

    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch {
        // 临时文件清理失败不能掩盖原始保存错误。
      }
      throw error;
    }
  }
}

module.exports = {
  LEVERAGE_CONFIG_DIRECTORY,
  LEVERAGE_CONFIG_FILENAME,
  LEVERAGE_CONFIG_VERSION,
  LeverageConfigStore,
  leverageScopeKey,
  normalizeLeverage,
  normalizeLeverageScope,
  resolveLeverageConfigPath,
};
