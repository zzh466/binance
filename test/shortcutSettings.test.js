const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACTION_ORDER,
  ACTION_ORDER_QUOTE_TOTAL,
  ACTION_CANCEL_ALL,
  DIRECTION_SHORT,
  DIRECTION_LONG,
  DEFAULT_SHORTCUTS,
  migrateLegacySettings,
  validate,
  getShortcutForCode,
  getKeyLabel,
  formatPriceOffset,
  getActionLabel,
  isOrderAction,
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
    quoteOrderQty: "",
  });
  assert.equal(getShortcutForCode("Numpad5", result.settings).action, ACTION_CANCEL_ALL);
  assert.equal(getKeyLabel("Numpad1"), "Num 1");
  assert.equal(formatPriceOffset(0.1), "+0.1");
});

test("按总价下单快捷键保留方向、超价和计价资产总价", () => {
  const result = validate([
    ...DEFAULT_SHORTCUTS,
    {
      id: "order-quote-total-long",
      key: "Numpad7",
      action: ACTION_ORDER_QUOTE_TOTAL,
      direction: DIRECTION_LONG,
      priceOffset: -0.2,
      quoteOrderQty: "100",
    },
  ]);

  assert.equal(result.valid, true);
  assert.deepEqual(getShortcutForCode("Numpad7", result.settings), {
    id: "order-quote-total-long",
    key: "Numpad7",
    action: ACTION_ORDER_QUOTE_TOTAL,
    direction: DIRECTION_LONG,
    priceOffset: -0.2,
    quantity: "",
    quoteOrderQty: "100",
  });
  assert.equal(getActionLabel(ACTION_ORDER_QUOTE_TOTAL), "下单（按总价）");
  assert.equal(isOrderAction(ACTION_ORDER_QUOTE_TOTAL), true);
});

test("按数量和按总价下单动作使用明确的展示名称", () => {
  assert.equal(getActionLabel(ACTION_ORDER), "下单（按数量）");
  assert.equal(getActionLabel(ACTION_ORDER_QUOTE_TOTAL), "下单（按总价）");
});

test("按总价下单快捷键拒绝无效方向、超价和非正数总价", () => {
  const result = validate([{
    id: "invalid-quote-total",
    key: "Numpad7",
    action: ACTION_ORDER_QUOTE_TOTAL,
    direction: "",
    priceOffset: "not-a-number",
    quoteOrderQty: "0",
  }]);

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors.join(" "), /总价必须大于 0/);
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
