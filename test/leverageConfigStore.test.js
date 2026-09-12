const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  LeverageConfigStore,
  resolveLeverageConfigPath,
} = require("../src/leverageConfigStore");

function createTemporaryStore(context, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-leverage-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "leverage-settings.json");
  return { filePath, store: new LeverageConfigStore(filePath, options) };
}

test("杠杆配置路径在 macOS 与 Windows 都位于 appData 产品目录", () => {
  assert.equal(
    resolveLeverageConfigPath("/Users/jason/Library/Application Support", {
      platform: "darwin",
    }),
    "/Users/jason/Library/Application Support/Binance统一交易台/leverage-settings.json"
  );
  assert.equal(
    resolveLeverageConfigPath("C:\\Users\\Jason\\AppData\\Roaming", {
      platform: "win32",
    }),
    "C:\\Users\\Jason\\AppData\\Roaming\\Binance统一交易台\\leverage-settings.json"
  );
});

test("杠杆按 environment、account、symbol 隔离并可重新加载", (context) => {
  let now = 1_000;
  const { filePath, store } = createTemporaryStore(context, {
    now: () => now++,
  });
  store.set({
    environment: "testnet",
    account: "account-1",
    symbol: "btcusdt",
    apiKey: "must-not-be-stored",
    apiSecret: "must-not-be-stored-either",
  }, 10);
  store.set({
    environment: "production",
    account: "account-1",
    symbol: "BTCUSDT",
  }, 20);
  store.set({
    environment: "testnet",
    account: "account-2",
    symbol: "BTCUSDT",
  }, 30);
  store.set({
    environment: "testnet",
    account: "account-1",
    symbol: "ETHUSDT",
  }, 40);

  const reloaded = new LeverageConfigStore(filePath);
  assert.equal(reloaded.get({
    environment: "testnet",
    account: "account-1",
    symbol: "BTCUSDT",
  }).leverage, 10);
  assert.equal(reloaded.get({
    environment: "production",
    account: "account-1",
    symbol: "BTCUSDT",
  }).leverage, 20);
  assert.equal(reloaded.get({
    environment: "testnet",
    account: "account-2",
    symbol: "BTCUSDT",
  }).leverage, 30);
  assert.equal(reloaded.get({
    environment: "testnet",
    account: "account-1",
    symbol: "ETHUSDT",
  }).leverage, 40);

  const storedText = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(storedText, /must-not-be-stored/);
  assert.doesNotMatch(storedText, /apiKey|apiSecret/);
});

test("无效杠杆不会覆盖磁盘上的有效配置", (context) => {
  const { filePath, store } = createTemporaryStore(context);
  const scope = {
    environment: "production",
    account: "future-account-7",
    symbol: "BTCUSDT",
  };
  store.set(scope, 15);
  const before = fs.readFileSync(filePath, "utf8");

  assert.throws(() => store.set(scope, 15.5), /1-125 的整数/);
  assert.equal(fs.readFileSync(filePath, "utf8"), before);
  assert.equal(store.get(scope).leverage, 15);
});

test("损坏的本地文件不会阻塞后续写入", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-leverage-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "leverage-settings.json");
  fs.writeFileSync(filePath, "{not json", "utf8");
  const store = new LeverageConfigStore(filePath, { now: () => 1234 });

  assert.equal(store.list().length, 0);
  store.set({
    environment: "testnet",
    account: "account-1",
    symbol: "BTCUSDT",
  }, 5);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).entries[0].leverage, 5);
});

test("两个应用实例用旧快照写不同账号时不会互相覆盖", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-leverage-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "leverage-settings.json");
  const firstInstance = new LeverageConfigStore(filePath, { now: () => 1_000 });
  const secondInstance = new LeverageConfigStore(filePath, { now: () => 2_000 });

  firstInstance.set({
    environment: "production",
    account: "account-1",
    symbol: "BTCUSDT",
  }, 10);
  secondInstance.set({
    environment: "production",
    account: "account-2",
    symbol: "ETHUSDT",
  }, 20);

  const reloaded = new LeverageConfigStore(filePath);
  assert.equal(reloaded.get({
    environment: "production",
    account: "account-1",
    symbol: "BTCUSDT",
  }).leverage, 10);
  assert.equal(reloaded.get({
    environment: "production",
    account: "account-2",
    symbol: "ETHUSDT",
  }).leverage, 20);
  assert.equal(reloaded.list().length, 2);
});
