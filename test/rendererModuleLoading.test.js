const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("主页面先加载独立模块，最后加载渲染入口", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "index.html"),
    "utf8"
  );
  const expectedOrder = [
    "./chart.js",
    "./rendererElements.js",
    "./positionSafety.js",
    "./shortcutSettings.js",
    "./openOrderState.js",
    "./chartOrderSelection.js",
    "./renderer.js",
  ];
  const positions = expectedOrder.map((source) => html.indexOf(`src="${source}"`));

  assert.equal(positions.every((position) => position >= 0), true);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});
