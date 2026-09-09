const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  getRendererReloadTargets,
} = require("../src/developmentHotReload");

function normalizeChangePath(filename) {
  return String(filename || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function shouldRestartElectron(relativePath) {
  const normalized = normalizeChangePath(relativePath);
  if (!normalized.startsWith("src/")) return true;
  const targets = getRendererReloadTargets(normalized.slice(4));
  return !targets.main && !targets.login;
}

function buildElectronLaunch({
  electronPath,
  projectRoot,
  forwardedArguments = [],
  platform = process.platform,
} = {}) {
  return {
    command: electronPath,
    args: [projectRoot, ...forwardedArguments],
    options: {
      cwd: projectRoot,
      stdio: "inherit",
      shell: false,
      windowsHide: platform === "win32",
      env: {
        ...process.env,
        BINANCE_DEV_HOT_RELOAD: "true",
      },
    },
  };
}

function runDevelopmentSupervisor({
  projectRoot = path.resolve(__dirname, ".."),
  electronPath = require("electron"),
  forwardedArguments = process.argv.slice(2),
  platform = process.platform,
  watch = fs.watch,
  spawnProcess = spawn,
  debounceMs = 180,
} = {}) {
  const sourceDirectory = path.join(projectRoot, "src");
  let electronProcess = null;
  let restartRequested = false;
  let shuttingDown = false;
  let restartTimer = null;
  const watchers = [];

  const launchElectron = () => {
    const launch = buildElectronLaunch({
      electronPath,
      projectRoot,
      forwardedArguments,
      platform,
    });
    electronProcess = spawnProcess(
      launch.command,
      launch.args,
      launch.options
    );
    process.stdout.write("[热更新] Electron 已启动，正在监听代码改动。\n");
    electronProcess.once("exit", (code, signal) => {
      electronProcess = null;
      if (shuttingDown) {
        process.exit(code || 0);
        return;
      }
      if (restartRequested) {
        restartRequested = false;
        launchElectron();
        return;
      }
      if (code === 0) {
        for (const watcher of watchers) watcher.close();
        process.exit(0);
        return;
      }
      process.stderr.write(
        `[热更新] Electron 已退出（${signal || code}），修复代码并保存后会自动重启。\n`
      );
    });
    electronProcess.once("error", (error) => {
      process.stderr.write(`[热更新] Electron 启动失败：${error.message}\n`);
    });
  };

  const restartElectron = (changedPath) => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!electronProcess) {
        launchElectron();
        return;
      }
      restartRequested = true;
      process.stdout.write(
        `[热更新] 后台代码已变化，正在重启：${changedPath}\n`
      );
      electronProcess.kill();
    }, debounceMs);
  };

  watchers.push(watch(
    sourceDirectory,
    { recursive: true, persistent: true },
    (_eventType, filename) => {
      const relativePath = `src/${normalizeChangePath(filename)}`;
      if (!electronProcess || shouldRestartElectron(relativePath)) {
        restartElectron(relativePath);
      }
    }
  ));
  watchers.push(watch(
    projectRoot,
    { persistent: true },
    (_eventType, filename) => {
      const relativePath = normalizeChangePath(filename);
      if ([".env", ".env.example", "package.json"].includes(relativePath)) {
        restartElectron(relativePath);
      }
    }
  ));

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(restartTimer);
    for (const watcher of watchers) watcher.close();
    if (electronProcess) electronProcess.kill();
    else process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (platform === "win32") process.once("SIGBREAK", shutdown);

  launchElectron();
  return { shutdown };
}

if (require.main === module) runDevelopmentSupervisor();

module.exports = {
  buildElectronLaunch,
  normalizeChangePath,
  runDevelopmentSupervisor,
  shouldRestartElectron,
};
