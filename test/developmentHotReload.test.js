const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getRendererReloadTargets,
  isDevelopmentMode,
  openDevelopmentTools,
  startDevelopmentRendererHotReload,
} = require("../src/developmentHotReload");
const {
  buildElectronLaunch,
  normalizeChangePath,
  shouldRestartElectron,
} = require("../scripts/dev");
const packageManifest = require("../package.json");

test("页面文件热刷新，后台交易代码触发 Electron 重启", () => {
  assert.deepEqual(getRendererReloadTargets("renderer.js"), {
    main: true,
    login: false,
  });
  assert.deepEqual(getRendererReloadTargets("rendererElements.js"), {
    main: true,
    login: false,
  });
  assert.deepEqual(getRendererReloadTargets("tablePagination.js"), {
    main: true,
    login: true,
  });
  assert.deepEqual(getRendererReloadTargets("loginRenderer.js"), {
    main: false,
    login: true,
  });
  assert.equal(shouldRestartElectron("src/renderer.js"), false);
  assert.equal(shouldRestartElectron("src\\preload.js"), false);
  assert.equal(shouldRestartElectron("src/main.js"), true);
  assert.equal(
    shouldRestartElectron("src\\binance\\binanceSpotClient.js"),
    true
  );
});

test("macOS 与 Windows 都直接启动 Electron 可执行文件且不依赖 shell", () => {
  const mac = buildElectronLaunch({
    electronPath: "/project/node_modules/electron/Electron",
    projectRoot: "/project",
    forwardedArguments: ["--demo"],
    platform: "darwin",
  });
  assert.equal(mac.command, "/project/node_modules/electron/Electron");
  assert.deepEqual(mac.args, ["/project", "--demo"]);
  assert.equal(mac.options.shell, false);
  assert.equal(mac.options.windowsHide, false);
  assert.equal(mac.options.env.BINANCE_DEV_HOT_RELOAD, "true");

  const windows = buildElectronLaunch({
    electronPath: "C:\\project\\node_modules\\electron\\electron.exe",
    projectRoot: "C:\\project",
    platform: "win32",
  });
  assert.equal(
    windows.command,
    "C:\\project\\node_modules\\electron\\electron.exe"
  );
  assert.deepEqual(windows.args, ["C:\\project"]);
  assert.equal(windows.options.shell, false);
  assert.equal(windows.options.windowsHide, true);
});

test("Windows 风格监听路径会统一为正斜线", () => {
  assert.equal(
    normalizeChangePath("binance\\binanceUsdMClient.js"),
    "binance/binanceUsdMClient.js"
  );
});

test("渲染文件保存后按窗口类型防抖刷新", async () => {
  let changeListener;
  let closed = false;
  let mainReloads = 0;
  let loginReloads = 0;
  const stop = startDevelopmentRendererHotReload({
    enabled: true,
    sourceDirectory: "/project/src",
    debounceMs: 1,
    watch: (_directory, _options, callback) => {
      changeListener = callback;
      return { close: () => { closed = true; } };
    },
    reloadMainWindow: () => { mainReloads += 1; },
    reloadLoginWindow: () => { loginReloads += 1; },
  });

  changeListener("change", "renderer.js");
  changeListener("change", "positionSafety.js");
  changeListener("rename", "index.html");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(mainReloads, 1);
  assert.equal(loginReloads, 0);

  changeListener("change", "loginRenderer.js");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(loginReloads, 1);
  stop();
  assert.equal(closed, true);
});

test("npm start 默认启用热更新并保留单次启动入口", () => {
  assert.equal(packageManifest.scripts.start, "node scripts/dev.js");
  assert.equal(packageManifest.scripts["start:once"], "electron .");
});

test("只有未打包且由开发启动器启动时才属于开发者模式", () => {
  assert.equal(
    isDevelopmentMode({
      isPackaged: false,
      environment: { BINANCE_DEV_HOT_RELOAD: "true" },
    }),
    true
  );
  assert.equal(
    isDevelopmentMode({
      isPackaged: true,
      environment: { BINANCE_DEV_HOT_RELOAD: "true" },
    }),
    false
  );
  assert.equal(
    isDevelopmentMode({
      isPackaged: false,
      environment: {},
    }),
    false
  );
});

test("开发者模式自动打开独立调试控制台，热刷新时不会重复打开", () => {
  let opened = false;
  const openOptions = [];
  const browserWindow = {
    webContents: {
      isDestroyed: () => false,
      isDevToolsOpened: () => opened,
      openDevTools: (options) => {
        opened = true;
        openOptions.push(options);
      },
    },
  };

  assert.equal(openDevelopmentTools(browserWindow, { enabled: true }), true);
  assert.deepEqual(openOptions, [{ mode: "detach", activate: true }]);

  assert.equal(openDevelopmentTools(browserWindow, { enabled: true }), true);
  assert.equal(openOptions.length, 1);

  assert.equal(openDevelopmentTools(browserWindow, { enabled: false }), false);
  assert.equal(
    openDevelopmentTools(
      {
        webContents: {
          isDestroyed: () => true,
          isDevToolsOpened: () => false,
          openDevTools: () => openOptions.push("unexpected"),
        },
      },
      { enabled: true }
    ),
    false
  );
  assert.equal(openOptions.length, 1);
});

test("Windows 自动打开调试控制台但不抢走主窗口焦点", () => {
  const openOptions = [];
  const browserWindow = {
    webContents: {
      isDestroyed: () => false,
      isDevToolsOpened: () => false,
      openDevTools: (options) => openOptions.push(options),
    },
  };

  assert.equal(openDevelopmentTools(browserWindow, {
    enabled: true,
    platform: "win32",
  }), true);
  assert.deepEqual(openOptions, [{ mode: "detach", activate: false }]);
});
