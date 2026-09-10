function revealBrowserWindow(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return false;
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.show();
  targetWindow.focus();
  return true;
}

function registerWindowLoadFallbacks(
  targetWindow,
  label,
  { errorOutput = process.stderr } = {}
) {
  if (!targetWindow?.webContents) {
    throw new TypeError("窗口加载管理需要有效的 BrowserWindow。");
  }

  targetWindow.once("ready-to-show", () => revealBrowserWindow(targetWindow));
  targetWindow.webContents.once("did-finish-load", () => {
    revealBrowserWindow(targetWindow);
  });
  targetWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      errorOutput.write(
        `[窗口加载失败] ${label}：${errorDescription || "未知错误"}` +
        `（${errorCode || "无错误码"}）${validatedURL ? ` ${validatedURL}` : ""}\n`
      );
      revealBrowserWindow(targetWindow);
    }
  );
}

module.exports = {
  registerWindowLoadFallbacks,
  revealBrowserWindow,
};
