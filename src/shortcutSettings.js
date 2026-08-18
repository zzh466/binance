(function exposeShortcutSettings(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShortcutSettings = api;
  }
})(typeof window !== "undefined" ? window : globalThis, () => {
  const ACTION_ORDER = "ORDER";
  const ACTION_CANCEL_ALL = "CANCEL_ALL";
  const DIRECTION_SHORT = "SHORT";
  const DIRECTION_LONG = "LONG";

  const AVAILABLE_KEYS = Object.freeze(
    Array.from({ length: 10 }, (_value, number) =>
      Object.freeze({ code: `Numpad${number}`, label: `Num ${number}` })
    )
  );

  const DEFAULT_SHORTCUTS = Object.freeze([
    Object.freeze({
      id: "order-short",
      key: "Numpad1",
      action: ACTION_ORDER,
      direction: DIRECTION_SHORT,
      priceOffset: 0.1,
      quantity: "0.001",
    }),
    Object.freeze({
      id: "order-long",
      key: "Numpad3",
      action: ACTION_ORDER,
      direction: DIRECTION_LONG,
      priceOffset: -0.1,
      quantity: "0.001",
    }),
    Object.freeze({
      id: "cancel-all",
      key: "Numpad5",
      action: ACTION_CANCEL_ALL,
      direction: "",
      priceOffset: null,
      quantity: "",
    }),
  ]);

  const availableCodes = new Set(AVAILABLE_KEYS.map(({ code }) => code));
  const actions = new Set([ACTION_ORDER, ACTION_CANCEL_ALL]);
  const directions = new Set([DIRECTION_SHORT, DIRECTION_LONG]);

  function cloneDefaults() {
    return DEFAULT_SHORTCUTS.map((shortcut) => ({ ...shortcut }));
  }

  function migrateLegacySettings(settings) {
    if (Array.isArray(settings)) return settings;
    if (!settings || typeof settings !== "object") return cloneDefaults();

    const legacyKeys = {
      "order-short": settings.sell,
      "order-long": settings.buy,
      "cancel-all": settings.cancelAll,
    };
    return cloneDefaults()
      .map((shortcut) => ({
        ...shortcut,
        key: legacyKeys[shortcut.id] ?? shortcut.key,
      }))
      .filter(({ key }) => Boolean(key));
  }

  function normalizeRecord(record, index) {
    if (!record || typeof record !== "object") return null;
    const key = typeof record.key === "string" ? record.key : "";
    const action = typeof record.action === "string" ? record.action : "";
    if (!availableCodes.has(key) || !actions.has(action)) return null;

    const id = typeof record.id === "string" && record.id.trim()
      ? record.id.trim()
      : `shortcut-${index}-${key}`;

    if (action === ACTION_CANCEL_ALL) {
      return {
        id,
        key,
        action,
        direction: "",
        priceOffset: null,
        quantity: "",
      };
    }

    const priceOffset = Number(record.priceOffset);
    const quantity = String(record.quantity ?? "").trim();
    return {
      id,
      key,
      action,
      direction: directions.has(record.direction) ? record.direction : "",
      priceOffset: Number.isFinite(priceOffset) ? priceOffset : null,
      quantity,
    };
  }

  function normalize(settings) {
    return migrateLegacySettings(settings)
      .map(normalizeRecord)
      .filter(Boolean);
  }

  function validate(settings) {
    const source = migrateLegacySettings(settings);
    const normalized = normalize(source);
    const errors = [];
    const usedKeys = new Map();
    const usedIds = new Set();

    if (normalized.length !== source.length) {
      errors.push("快捷键配置中包含无效的按键或动作。");
    }

    for (const shortcut of normalized) {
      if (usedIds.has(shortcut.id)) {
        errors.push("快捷键记录标识不能重复。");
      }
      usedIds.add(shortcut.id);

      if (usedKeys.has(shortcut.key)) {
        errors.push(
          `${getKeyLabel(shortcut.key)} 已被“${usedKeys.get(shortcut.key)}”使用。`
        );
      } else {
        usedKeys.set(shortcut.key, describeShortcut(shortcut));
      }

      if (shortcut.action === ACTION_ORDER) {
        if (!directions.has(shortcut.direction)) {
          errors.push(`${getKeyLabel(shortcut.key)} 必须选择下单方向。`);
        }
        if (!Number.isFinite(shortcut.priceOffset)) {
          errors.push(`${getKeyLabel(shortcut.key)} 的超价必须是数字。`);
        }
        if (!(Number(shortcut.quantity) > 0)) {
          errors.push(`${getKeyLabel(shortcut.key)} 的手数必须大于 0。`);
        }
      }
    }

    return { valid: errors.length === 0, errors, settings: normalized };
  }

  function getShortcutForCode(code, settings) {
    return normalize(settings).find((shortcut) => shortcut.key === code) || null;
  }

  function getKeyLabel(code) {
    return AVAILABLE_KEYS.find((key) => key.code === code)?.label || "未设置";
  }

  function getActionLabel(action) {
    return action === ACTION_ORDER ? "下单" : "撤单";
  }

  function getDirectionLabel(direction) {
    if (direction === DIRECTION_SHORT) return "空";
    if (direction === DIRECTION_LONG) return "多";
    return "-";
  }

  function formatPriceOffset(value) {
    if (!Number.isFinite(Number(value))) return "-";
    const numericValue = Number(value);
    return numericValue >= 0 ? `+${numericValue}` : String(numericValue);
  }

  function describeShortcut(shortcut) {
    if (shortcut.action === ACTION_CANCEL_ALL) return "撤销全部未成交订单";
    return `${getDirectionLabel(shortcut.direction)}单`;
  }

  return {
    ACTION_ORDER,
    ACTION_CANCEL_ALL,
    DIRECTION_SHORT,
    DIRECTION_LONG,
    AVAILABLE_KEYS,
    DEFAULT_SHORTCUTS,
    cloneDefaults,
    migrateLegacySettings,
    normalize,
    validate,
    getShortcutForCode,
    getKeyLabel,
    getActionLabel,
    getDirectionLabel,
    formatPriceOffset,
    describeShortcut,
  };
});
