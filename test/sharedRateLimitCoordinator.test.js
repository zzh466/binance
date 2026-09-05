const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BinanceRateLimitGuardError,
  SharedRateLimitCoordinator,
} = require("../src/sharedRateLimitCoordinator");

test("多个应用实例共享 Binance 限流快照并为订单保留容量", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-rate-limit-"));
  let now = 1_000;
  const first = new SharedRateLimitCoordinator(directory, {
    instanceId: "darwin-instance",
    now: () => now,
    refreshIntervalMs: 60_000,
    saveDelayMs: 60_000,
  });
  const second = new SharedRateLimitCoordinator(directory, {
    instanceId: "win32-instance",
    now: () => now,
    refreshIntervalMs: 60_000,
    saveDelayMs: 60_000,
  });
  t.after(() => {
    first.close();
    second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  first.observe({
    marketType: "spot",
    rateLimits: [{
      rateLimitType: "REQUEST_WEIGHT",
      interval: "MINUTE",
      intervalNum: 1,
      limit: 100,
      count: 91,
    }],
  });
  first.flush();
  second.refresh();

  assert.throws(
    () => second.beforeRequest({ critical: false }),
    BinanceRateLimitGuardError
  );
  assert.doesNotThrow(() => second.beforeRequest({ critical: true }));

  now += 60_001;
  assert.doesNotThrow(() => second.beforeRequest({ critical: false }));
  const expired = second.snapshot();
  assert.equal(expired.nearLimit, false);
  assert.equal(expired.limits[0].active, false);
});

test("收到 429 后在 retry-after 窗口内连关键请求也会被本地拦截", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-ban-"));
  const coordinator = new SharedRateLimitCoordinator(directory, {
    instanceId: "one",
    now: () => 5_000,
    refreshIntervalMs: 60_000,
    saveDelayMs: 60_000,
  });
  t.after(() => {
    coordinator.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  coordinator.observe({ status: 429, headers: { "retry-after": "2" } });
  assert.throws(
    () => coordinator.beforeRequest({ critical: true }),
    /限流保护中/
  );
});
