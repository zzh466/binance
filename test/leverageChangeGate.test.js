const assert = require("node:assert/strict");
const test = require("node:test");
const {
  LeverageChangeGate,
} = require("../src/leverageChangeGate");

test("同一客户端同一合约设置杠杆期间阻止新委托和重复设置", async () => {
  const gate = new LeverageChangeGate();
  const client = {};
  let finish;
  const pending = gate.run(client, "btcusdt", () => new Promise((resolve) => {
    finish = resolve;
  }));
  await Promise.resolve();

  assert.equal(gate.isPending(client, "BTCUSDT"), true);
  assert.throws(
    () => gate.assertOrderAllowed(client, "BTCUSDT"),
    (error) => error.name === "LeverageChangeInProgressError" &&
      error.code === "LEVERAGE_CHANGE_IN_PROGRESS" &&
      error.data.symbol === "BTCUSDT"
  );
  assert.throws(
    () => gate.run(client, "BTCUSDT", async () => {}),
    /正在设置杠杆倍率/
  );

  finish("done");
  assert.equal(await pending, "done");
  assert.equal(gate.isPending(client, "BTCUSDT"), false);
  assert.equal(gate.assertOrderAllowed(client, "BTCUSDT"), "BTCUSDT");
});

test("杠杆设置门禁按客户端和合约隔离，并在失败后释放", async () => {
  const gate = new LeverageChangeGate();
  const firstClient = {};
  const secondClient = {};
  let rejectChange;
  const pending = gate.run(firstClient, "BTCUSDT", () => new Promise(
    (_resolve, reject) => {
      rejectChange = reject;
    }
  ));
  await Promise.resolve();

  assert.equal(gate.assertOrderAllowed(firstClient, "ETHUSDT"), "ETHUSDT");
  assert.equal(gate.assertOrderAllowed(secondClient, "BTCUSDT"), "BTCUSDT");
  rejectChange(new Error("Binance failure"));
  await assert.rejects(pending, /Binance failure/);
  assert.equal(gate.isPending(firstClient, "BTCUSDT"), false);
});
