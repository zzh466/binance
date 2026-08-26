const assert = require("node:assert/strict");
const test = require("node:test");
const packageManifest = require("../package.json");

test("提供不依赖 Unix shell 的 Windows x64 与 ARM64 构建入口", () => {
  assert.equal(
    packageManifest.scripts["build:win"],
    "electron-builder --win --x64"
  );
  assert.equal(
    packageManifest.scripts["build:win:arm64"],
    "electron-builder --win --arm64"
  );
  assert.equal(
    packageManifest.scripts["build:win:all"],
    "electron-builder --win --x64 --arm64"
  );
  assert.equal(
    packageManifest.scripts["build:win:dir"],
    "electron-builder --win --x64 --dir"
  );
});

test("Windows 构建同时生成安装程序和可解压分发包", () => {
  assert.equal(
    packageManifest.devDependencies["electron-builder"],
    "^26.15.3"
  );
  assert.deepEqual(packageManifest.build.win.target, ["nsis", "zip"]);
  assert.match(packageManifest.build.win.artifactName, /\$\{arch\}/);
  assert.equal(packageManifest.build.nsis.oneClick, false);
  assert.equal(packageManifest.build.nsis.allowToChangeInstallationDirectory, true);
});

test("打包范围只包含运行代码且不会把真实密钥打进 Windows 包", () => {
  assert.deepEqual(packageManifest.build.files, ["src/**/*", "package.json"]);
  assert.deepEqual(packageManifest.build.extraFiles, [
    { from: ".env.example", to: ".env.example" },
  ]);
  assert.equal(
    packageManifest.build.extraFiles.some(({ from }) => from === ".env"),
    false
  );
});
