const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  getAdditionalInstanceLaunch,
  getPackagedEnvironmentPath,
  resolveCurlExecutable,
} = require("../src/platformSupport");
const { BinanceUsdMClient } = require("../src/binance/binanceUsdMClient");

test("curl 可执行文件同时支持 macOS 和 Windows", () => {
  assert.equal(resolveCurlExecutable({ platform: "darwin", environment: {} }), "/usr/bin/curl");
  assert.equal(resolveCurlExecutable({ platform: "win32", environment: {} }), "curl.exe");
  assert.equal(resolveCurlExecutable({ platform: "linux", environment: {} }), "curl");
  assert.equal(
    resolveCurlExecutable({
      platform: "win32",
      environment: { BINANCE_CURL_PATH: "D:\\Tools\\curl.exe" },
    }),
    "D:\\Tools\\curl.exe"
  );
});

test("打包应用从各自平台的可执行文件旁读取 .env", () => {
  assert.equal(
    getPackagedEnvironmentPath({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/Binance.app/Contents/Resources",
      execPath: "/Applications/Binance.app/Contents/MacOS/Electron",
    }),
    "/Applications/.env"
  );
  assert.equal(
    getPackagedEnvironmentPath({
      isPackaged: true,
      platform: "win32",
      resourcesPath: "C:\\Binance\\resources",
      execPath: "C:\\Binance\\Binance.exe",
    }),
    path.win32.join("C:\\Binance", ".env")
  );
});

test("Windows 打包版多开不再把 appPath 当作启动参数", () => {
  assert.deepEqual(
    getAdditionalInstanceLaunch({
      isPackaged: true,
      platform: "win32",
      execPath: "C:\\Binance\\Binance.exe",
      appPath: "C:\\Binance\\resources\\app.asar",
      instanceId: "second",
    }),
    {
      command: "C:\\Binance\\Binance.exe",
      args: ["--binance-instance=second"],
    }
  );
});

test("curl 后备通道可跨平台调用且可重试", async () => {
  const calls = [];
  const client = new BinanceUsdMClient({
    testnet: false,
    curlExecutable: "curl.exe",
    executeFile: async (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        const error = new Error("connection reset");
        error.code = "ECONNRESET";
        throw error;
      }
      return {
        stdout: '{"serverTime":1}\n__BINANCE_HTTP_STATUS__:200',
      };
    },
  });

  const result = await client.requestPublicMarketDataWithCurl(
    "GET",
    "/fapi/v1/time"
  );

  assert.deepEqual(result, { serverTime: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "curl.exe");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].args.includes("--retry-all-errors"), false);
  client.close();
});

test("Windows 没有 curl 时优先使用 Electron 原生网络", async () => {
  let curlCalls = 0;
  const client = new BinanceUsdMClient({
    testnet: false,
    platform: "win32",
    publicMarketFetch: async () => ({
      status: 200,
      text: async () => '{"serverTime":2}',
    }),
    executeFile: async () => {
      curlCalls += 1;
      const error = new Error("curl missing");
      error.code = "ENOENT";
      throw error;
    },
  });

  const result = await client.request("GET", "/fapi/v1/time");

  assert.deepEqual(result, { serverTime: 2 });
  assert.equal(client.publicMarketTransport, "electron");
  assert.equal(curlCalls, 0);
  client.close();
});

test("Windows Electron 网络失败后使用 Node HTTPS 并缓存选择", async () => {
  let electronCalls = 0;
  let nodeCalls = 0;
  let curlCalls = 0;
  const client = new BinanceUsdMClient({
    testnet: false,
    platform: "win32",
    publicMarketFetch: async () => {
      electronCalls += 1;
      throw new Error("native network unavailable");
    },
    executeFile: async () => {
      curlCalls += 1;
      throw new Error("curl should not be used");
    },
  });
  client.requestPublicMarketDataWithNode = async () => {
    nodeCalls += 1;
    return { serverTime: nodeCalls };
  };

  assert.deepEqual(
    await client.request("GET", "/fapi/v1/time"),
    { serverTime: 1 }
  );
  assert.deepEqual(
    await client.request("GET", "/fapi/v1/time"),
    { serverTime: 2 }
  );
  assert.equal(client.publicMarketTransport, "node");
  assert.equal(electronCalls, 1);
  assert.equal(nodeCalls, 2);
  assert.equal(curlCalls, 0);
  client.close();
});
