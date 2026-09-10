const fs = require("node:fs");
const path = require("node:path");

const MAIN_RENDERER_FILES = new Set([
  "chart.js",
  "chartOrderSelection.js",
  "index.html",
  "openOrderState.js",
  "positionSafety.js",
  "preload.js",
  "rendererElements.js",
  "renderer.js",
  "shortcutSettings.js",
]);
const LOGIN_RENDERER_FILES = new Set([
  "login.html",
  "loginPreload.js",
  "loginRenderer.js",
]);

function getRendererReloadTargets(filename) {
  const normalized = String(filename || "").replace(/\\/g, "/");
  const basename = path.posix.basename(normalized);
  if (!basename) return { main: false, login: false };
  if (basename.endsWith(".css")) return { main: true, login: true };
  return {
    main: MAIN_RENDERER_FILES.has(basename),
    login: LOGIN_RENDERER_FILES.has(basename),
  };
}

function isDevelopmentMode({
  isPackaged,
  environment = process.env,
} = {}) {
  return !isPackaged && environment.BINANCE_DEV_HOT_RELOAD === "true";
}

function openDevelopmentTools(
  browserWindow,
  { enabled, platform = process.platform } = {}
) {
  const webContents = browserWindow?.webContents;
  if (!enabled || !webContents || webContents.isDestroyed?.()) return false;
  if (!webContents.isDevToolsOpened()) {
    webContents.openDevTools({
      mode: "detach",
      activate: platform !== "win32",
    });
  }
  return true;
}

function startDevelopmentRendererHotReload({
  enabled,
  sourceDirectory,
  reloadMainWindow,
  reloadLoginWindow,
  watch = fs.watch,
  debounceMs = 120,
} = {}) {
  if (!enabled) return () => {};

  let timer = null;
  let pendingMainReload = false;
  let pendingLoginReload = false;
  const watcher = watch(
    sourceDirectory,
    { persistent: false },
    (_eventType, filename) => {
      const targets = getRendererReloadTargets(filename);
      if (!targets.main && !targets.login) return;
      pendingMainReload ||= targets.main;
      pendingLoginReload ||= targets.login;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (pendingMainReload) reloadMainWindow?.();
        if (pendingLoginReload) reloadLoginWindow?.();
        pendingMainReload = false;
        pendingLoginReload = false;
      }, debounceMs);
    }
  );

  return () => {
    clearTimeout(timer);
    timer = null;
    watcher.close();
  };
}

module.exports = {
  getRendererReloadTargets,
  isDevelopmentMode,
  openDevelopmentTools,
  startDevelopmentRendererHotReload,
};
