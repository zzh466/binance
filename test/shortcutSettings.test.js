const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACTION_ORDER,
  ACTION_CANCEL_ALL,
  DIRECTION_SHORT,
  DEFAULT_SHORTCUTS,
  migrateLegacySettings,
  validate,
  getShortcutForCode,
  getKeyLabel,
  formatPriceOffset,
} = require("../src/shortcutSettings");

test("快捷键默认列表包含 Num 1 报空、Num 3 报多和 Num 5 撤单", () => {
  const result = validate(DEFAULT_SHORTCUTS);

  assert.equal(result.valid, true);
  assert.deepEqual(getShortcutForCode("Numpad1", result.settings), {
    id: "order-short",
    key: "Numpad1",
    action: ACTION_ORDER,
    direction: DIRECTION_SHORT,
    priceOffset: 0.1,
    quantity: "0.001",
  });
  assert.equal(getShortcutForCode("Numpad5", result.settings).action, ACTION_CANCEL_ALL);
  assert.equal(getKeyLabel("Numpad1"), "Num 1");
  assert.equal(formatPriceOffset(0.1), "+0.1");
});

test("旧版按动作保存的快捷键可以迁移为规则列表", () => {
  const migrated = migrateLegacySettings({
    sell: "Numpad7",
    buy: "Numpad9",
    cancelAll: "",
  });

  assert.equal(migrated.length, 2);
  assert.equal(getShortcutForCode("Numpad7", migrated).id, "order-short");
  assert.equal(getShortcutForCode("Numpad9", migrated).id, "order-long");
});

test("快捷键列表拒绝重复按键和无效下单参数", () => {
  const result = validate([
    ...DEFAULT_SHORTCUTS,
    {
      id: "invalid-order",
      key: "Numpad1",
      action: ACTION_ORDER,
      direction: "",
      priceOffset: "not-a-number",
      quantity: "0",
    },
  ]);

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 4);
});

test("删除快捷键后对应按键不再匹配动作", () => {
  const remaining = DEFAULT_SHORTCUTS.filter(({ id }) => id !== "order-short");

  assert.equal(validate(remaining).valid, true);
  assert.equal(getShortcutForCode("Numpad1", remaining), null);
});
