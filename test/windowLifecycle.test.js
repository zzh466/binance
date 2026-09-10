const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  registerWindowLoadFallbacks,
  revealBrowserWindow,
} = require("../src/windowLifecycle");

function createWindowMock({ minimized = false } = {}) {
  const targetWindow = new EventEmitter();
  targetWindow.webContents = new EventEmitter();
  targetWindow.destroyed = false;
  targetWindow.minimized = minimized;
  targetWindow.calls = [];
  targetWindow.isDestroyed = () => targetWindow.destroyed;
  targetWindow.isMinimized = () => targetWindow.minimized;
  targetWindow.restore = () => {
    targetWindow.calls.push("restore");
    targetWindow.minimized = false;
  };
  targetWindow.show = () => targetWindow.calls.push("show");
  targetWindow.focus = () => targetWindow.calls.push("focus");
  return targetWindow;
}

test("窗口准备完成后统一显示并聚焦", () => {
  const targetWindow = createWindowMock({ minimized: true });
  registerWindowLoadFallbacks(targetWindow, "登录窗口");

  targetWindow.emit("ready-to-show");
  assert.deepEqual(targetWindow.calls, ["restore", "show", "focus"]);
});

test("主页面加载完成也会兜底显示窗口", () => {
  const targetWindow = createWindowMock();
  registerWindowLoadFallbacks(targetWindow, "主窗口");

  targetWindow.webContents.emit("did-finish-load");
  assert.deepEqual(targetWindow.calls, ["show", "focus"]);
});

test("主页面加载失败时记录原因并显示窗口", () => {
  const targetWindow = createWindowMock();
  const messages = [];
  registerWindowLoadFallbacks(targetWindow, "主窗口", {
    errorOutput: { write: (message) => messages.push(message) },
  });

  targetWindow.webContents.emit(
    "did-fail-load",
    {},
    -6,
    "FILE_NOT_FOUND",
    "file:///missing.html",
    true
  );
  assert.match(messages[0], /主窗口.*FILE_NOT_FOUND.*missing\.html/);
  assert.deepEqual(targetWindow.calls, ["show", "focus"]);
});

test("已销毁窗口不会被再次显示", () => {
  const targetWindow = createWindowMock();
  targetWindow.destroyed = true;
  assert.equal(revealBrowserWindow(targetWindow), false);
  assert.deepEqual(targetWindow.calls, []);
});
