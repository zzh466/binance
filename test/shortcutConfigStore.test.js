const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  readShortcutConfig,
  writeShortcutConfig,
} = require("../src/shortcutConfigStore");
const { cloneDefaults } = require("../src/shortcutSettings");

test("首次读取时把旧设置迁移到 JSON 配置文件", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-shortcuts-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "shortcut-settings.json");
  const fallbackSettings = cloneDefaults().slice(0, 2);

  const settings = readShortcutConfig(configPath, { fallbackSettings });
  const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.deepEqual(settings, fallbackSettings);
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.shortcuts, fallbackSettings);
});

test("新增快捷键后完整列表会写入并可重新读取", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-shortcuts-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "shortcut-settings.json");
  const settings = [
    ...cloneDefaults(),
    {
      id: "shortcut-new",
      key: "Numpad7",
      action: "ORDER",
      direction: "LONG",
      priceOffset: -0.2,
      quantity: "0.005",
      quoteOrderQty: "",
    },
  ];

  writeShortcutConfig(configPath, settings);
  const reloaded = readShortcutConfig(configPath);

  assert.equal(reloaded.length, 4);
  assert.deepEqual(reloaded.at(-1), settings.at(-1));
});

test("按总价下单快捷键会以独立字段持久化", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-shortcuts-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "shortcut-settings.json");
  const settings = [
    ...cloneDefaults(),
    {
      id: "shortcut-quote-total",
      key: "Numpad7",
      action: "ORDER_QUOTE_TOTAL",
      direction: "SHORT",
      priceOffset: 0.1,
      quantity: "",
      quoteOrderQty: "250",
    },
  ];

  writeShortcutConfig(configPath, settings);
  const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const reloaded = readShortcutConfig(configPath);

  assert.equal(stored.version, 2);
  assert.equal(stored.shortcuts.at(-1).quoteOrderQty, "250");
  assert.deepEqual(reloaded.at(-1), settings.at(-1));
});

test("JSON 文件拒绝重复按键，且不会覆盖原配置", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-shortcuts-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "shortcut-settings.json");
  const defaults = cloneDefaults();
  writeShortcutConfig(configPath, defaults);
  const originalText = fs.readFileSync(configPath, "utf8");

  assert.throws(
    () => writeShortcutConfig(configPath, [defaults[0], { ...defaults[1], key: defaults[0].key }]),
    /已被/
  );
  assert.equal(fs.readFileSync(configPath, "utf8"), originalText);
});
