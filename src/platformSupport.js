const path = require("node:path");

function resolveCurlExecutable({
  platform = process.platform,
  environment = process.env,
} = {}) {
  const configuredPath = String(environment.BINANCE_CURL_PATH || "").trim();
  if (configuredPath) return configuredPath;
  if (platform === "win32") return "curl.exe";
  return platform === "darwin" ? "/usr/bin/curl" : "curl";
}

function getPackagedEnvironmentPath({
  isPackaged,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
} = {}) {
  if (!isPackaged) return null;
  if (platform === "darwin") {
    return path.resolve(resourcesPath, "../../..", ".env");
  }
  const platformPath = platform === "win32" ? path.win32 : path;
  return platformPath.join(platformPath.dirname(execPath), ".env");
}

function getAdditionalInstanceLaunch({
  isPackaged,
  platform = process.platform,
  execPath = process.execPath,
  appPath,
  appBundlePath,
  instanceId,
} = {}) {
  const instanceArgument = `--binance-instance=${instanceId}`;

  if (isPackaged && platform === "darwin") {
    return {
      command: "/usr/bin/open",
      args: ["-n", appBundlePath, "--args", instanceArgument],
    };
  }

  if (isPackaged) {
    return {
      command: execPath,
      args: [instanceArgument],
    };
  }

  return {
    command: execPath,
    args: [appPath, instanceArgument],
  };
}

module.exports = {
  getAdditionalInstanceLaunch,
  getPackagedEnvironmentPath,
  resolveCurlExecutable,
};
