const fs = require("node:fs");
const path = require("node:path");
const { cloneDefaults, validate } = require("./shortcutSettings");

const SHORTCUT_CONFIG_VERSION = 1;

function normalizeShortcutConfig(payload) {
  const source = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.shortcuts) ? payload.shortcuts : null);
  if (!source) {
    throw new TypeError("快捷键配置必须包含 shortcuts 数组。");
  }
  const result = validate(source);
  if (!result.valid) {
    throw new TypeError(`快捷键配置无效：${result.errors.join(" ")}`);
  }
  return result.settings;
}

function writeShortcutConfig(configPath, settings) {
  const normalizedSettings = normalizeShortcutConfig(settings);
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const payload = {
    version: SHORTCUT_CONFIG_VERSION,
    shortcuts: normalizedSettings,
  };
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // 清理临时文件失败不应覆盖原始保存错误。
    }
    throw error;
  }

  return normalizedSettings;
}

function readShortcutConfig(configPath, { fallbackSettings } = {}) {
  if (fs.existsSync(configPath)) {
    const payload = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return normalizeShortcutConfig(payload);
  }

  let initialSettings = cloneDefaults();
  if (fallbackSettings !== undefined && fallbackSettings !== null) {
    const fallbackResult = validate(fallbackSettings);
    if (fallbackResult.valid) initialSettings = fallbackResult.settings;
  }
  return writeShortcutConfig(configPath, initialSettings);
}

module.exports = {
  SHORTCUT_CONFIG_VERSION,
  normalizeShortcutConfig,
  readShortcutConfig,
  writeShortcutConfig,
};
