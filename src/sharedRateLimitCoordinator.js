const fs = require("node:fs");
const path = require("node:path");

const INTERVAL_MS = {
  SECOND: 1_000,
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
};

class BinanceRateLimitGuardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BinanceRateLimitGuardError";
    this.data = details;
  }
}

class SharedRateLimitCoordinator {
  constructor(directoryPath, {
    instanceId = `pid-${process.pid}`,
    now = () => Date.now(),
    threshold = 0.9,
    refreshIntervalMs = 500,
    saveDelayMs = 25,
  } = {}) {
    this.directoryPath = directoryPath;
    this.instanceId = String(instanceId).replace(/[^a-zA-Z0-9_-]/g, "_");
    this.filePath = path.join(
      directoryPath,
      `instance-${this.instanceId}.json`
    );
    this.now = now;
    this.threshold = threshold;
    this.saveDelayMs = saveDelayMs;
    this.localState = { updatedAt: 0, banUntil: 0, limits: {} };
    this.sharedState = { updatedAt: 0, banUntil: 0, limits: {} };
    this.saveTimer = null;
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  limitKey(marketType, rateLimitType, interval, intervalNum = 1) {
    return [marketType, rateLimitType, interval, intervalNum].join(":");
  }

  mergeState(target, source) {
    target.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(source.updatedAt) || 0);
    target.banUntil = Math.max(Number(target.banUntil) || 0, Number(source.banUntil) || 0);
    for (const [key, incoming] of Object.entries(source.limits || {})) {
      const existing = target.limits[key];
      if (!existing || Number(incoming.observedAt) >= Number(existing.observedAt)) {
        target.limits[key] = incoming;
      }
    }
    return target;
  }

  refresh() {
    const combined = { updatedAt: 0, banUntil: 0, limits: {} };
    try {
      if (fs.existsSync(this.directoryPath)) {
        for (const entry of fs.readdirSync(this.directoryPath)) {
          if (!entry.endsWith(".json")) continue;
          try {
            const payload = JSON.parse(fs.readFileSync(
              path.join(this.directoryPath, entry),
              "utf8"
            ));
            this.mergeState(combined, payload);
          } catch {
            // 另一个实例可能正在替换自身快照；下一轮会重新读取。
          }
        }
      }
    } catch {
      // 限流协调是保护层，文件系统异常不能阻断交易链路。
    }
    this.mergeState(combined, this.localState);
    this.sharedState = combined;
    return this.snapshot();
  }

  observe({ marketType, rateLimits = [], headers = {}, status } = {}) {
    const now = this.now();
    for (const item of rateLimits || []) {
      const rateLimitType = String(item.rateLimitType || "").toUpperCase();
      const interval = String(item.interval || "").toUpperCase();
      const intervalNum = Number(item.intervalNum) || 1;
      if (!rateLimitType || !interval) continue;
      const key = this.limitKey(
        marketType,
        rateLimitType,
        interval,
        intervalNum
      );
      this.localState.limits[key] = {
        marketType,
        rateLimitType,
        interval,
        intervalNum,
        limit: Number(item.limit) || null,
        count: Number(item.count) || 0,
        observedAt: now,
      };
    }

    const normalizedHeaders = {};
    for (const [key, value] of Object.entries(headers || {})) {
      normalizedHeaders[String(key).toLowerCase()] = Array.isArray(value)
        ? value[0]
        : value;
    }
    const headerMappings = [
      ["x-mbx-used-weight-1m", "REQUEST_WEIGHT", "MINUTE", 1],
      ["x-mbx-order-count-10s", "ORDERS", "SECOND", 10],
      ["x-mbx-order-count-1m", "ORDERS", "MINUTE", 1],
    ];
    for (const [header, type, interval, intervalNum] of headerMappings) {
      const count = Number(normalizedHeaders[header]);
      if (!Number.isFinite(count)) continue;
      const key = this.limitKey(marketType, type, interval, intervalNum);
      this.localState.limits[key] = {
        ...(this.localState.limits[key] || this.sharedState.limits[key] || {}),
        marketType,
        rateLimitType: type,
        interval,
        intervalNum,
        count,
        observedAt: now,
      };
    }
    if ([418, 429].includes(Number(status))) {
      const retryAfterSeconds = Number(normalizedHeaders["retry-after"]);
      this.localState.banUntil = Math.max(
        this.localState.banUntil,
        now + (Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 60_000)
      );
    }
    this.localState.updatedAt = now;
    this.mergeState(this.sharedState, this.localState);
    this.scheduleSave();
    return this.snapshot();
  }

  beforeRequest({ critical = false } = {}) {
    const now = this.now();
    if (Number(this.sharedState.banUntil) > now) {
      throw new BinanceRateLimitGuardError(
        `Binance 限流保护中，请在 ${new Date(this.sharedState.banUntil).toLocaleTimeString()} 后重试。`,
        { banUntil: this.sharedState.banUntil }
      );
    }
    if (critical) return;
    for (const limit of Object.values(this.sharedState.limits)) {
      const intervalMs = (INTERVAL_MS[limit.interval] || 0) * limit.intervalNum;
      if (!limit.limit || !intervalMs || now - limit.observedAt >= intervalMs) continue;
      const usage = limit.count / limit.limit;
      if (usage >= this.threshold) {
        throw new BinanceRateLimitGuardError(
          `Binance ${limit.rateLimitType} 已使用 ${limit.count}/${limit.limit}，` +
          "为订单与撤单预留容量，暂缓非关键查询。",
          { ...limit, usage }
        );
      }
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(this.directoryPath, { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(this.localState)}\n`, "utf8");
      fs.renameSync(temporaryPath, this.filePath);
    } catch {
      // 不让诊断/协调文件影响真实交易请求。
    }
  }

  snapshot() {
    const now = this.now();
    const limits = Object.values(this.sharedState.limits).map((limit) => ({
      ...limit,
      usage: limit.limit ? limit.count / limit.limit : null,
      active: Boolean(
        (INTERVAL_MS[limit.interval] || 0) * limit.intervalNum &&
        now - limit.observedAt <
          (INTERVAL_MS[limit.interval] || 0) * limit.intervalNum
      ),
    }));
    return {
      updatedAt: this.sharedState.updatedAt,
      banUntil: Number(this.sharedState.banUntil) > now
        ? this.sharedState.banUntil
        : 0,
      limits,
      nearLimit: limits.some((limit) =>
        limit.active &&
        Number.isFinite(limit.usage) &&
        limit.usage >= this.threshold
      ),
    };
  }

  close() {
    clearInterval(this.refreshTimer);
    if (this.saveTimer) this.flush();
  }
}

module.exports = {
  BinanceRateLimitGuardError,
  SharedRateLimitCoordinator,
};
