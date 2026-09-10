const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resolveDefaultTestnet,
} = require("../src/environmentSelection");

test("未配置环境开关时默认使用正式环境", () => {
  assert.equal(resolveDefaultTestnet({}), false);
  assert.equal(resolveDefaultTestnet({ BINANCE_TESTNET: "false" }), false);
});

test("只有明确配置 true 时才默认使用测试环境", () => {
  assert.equal(resolveDefaultTestnet({ BINANCE_TESTNET: "true" }), true);
  assert.equal(resolveDefaultTestnet({ BINANCE_TESTNET: " TRUE " }), true);
});
