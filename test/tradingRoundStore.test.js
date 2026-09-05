const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  TradingRoundStore,
  resolveExecutionAction,
} = require("../src/tradingRoundStore");

function createStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "binance-rounds-"));
  const filePath = path.join(directory, "trading-rounds.json");
  let nextId = 1;
  const store = new TradingRoundStore(filePath, {
    now: () => 1_000,
    idFactory: () => `round-${nextId++}`,
    saveDelayMs: 60_000,
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, filePath };
}

const context = {
  environment: "production",
  accountFingerprint: "account-1",
  marketType: "futures",
};

function execution(orderId, side, executedQty, extra = {}) {
  return {
    symbol: "CONTRACTA",
    orderId,
    side,
    executedQty,
    updateTime: 1_000 + orderId,
    ...extra,
  };
}

test("没有当前回合时，10 手开空创建一个空向回合", (t) => {
  const { store } = createStore(t);
  store.recordOrderExecution(execution(1, "SELL", "10"), context);

  const [round] = store.list();
  assert.equal(round.status, "OPEN");
  assert.equal(round.openShortQty, "10");
  assert.equal(round.shortQty, "10");
  assert.equal(round.longQty, "0");
  assert.equal(round.remainingDirection, "SHORT");
  assert.equal(round.remainingQty, "10");
});

test("已有 5 手空向时继续开空 10 手，当前回合累计为 15 手", (t) => {
  const { store } = createStore(t);
  store.recordOrderExecution(execution(1, "SELL", "5"), context);
  store.recordOrderExecution(execution(2, "SELL", "10"), context);

  const [round] = store.list();
  assert.equal(roundsLength(store), 1);
  assert.equal(round.shortQty, "15");
  assert.equal(round.remainingQty, "15");
});

test("已有 15 手多向时开空 10 手，当前回合还需 5 手空向", (t) => {
  const { store } = createStore(t);
  store.recordOrderExecution(execution(1, "BUY", "15"), context);
  store.recordOrderExecution(execution(2, "SELL", "10"), context);

  const [round] = store.list();
  assert.equal(roundsLength(store), 1);
  assert.equal(round.longQty, "15");
  assert.equal(round.shortQty, "10");
  assert.equal(round.remainingDirection, "LONG");
  assert.equal(round.remainingQty, "5");
});

test("已有 5 手多向时开空 10 手，结束旧回合并把剩余 5 手放进新回合", (t) => {
  const { store } = createStore(t);
  store.recordOrderExecution(execution(1, "BUY", "5"), context);
  store.recordOrderExecution(execution(2, "SELL", "10"), context);

  const rounds = store.list();
  assert.equal(rounds.length, 2);
  const completed = rounds.find((round) => round.status === "COMPLETED");
  const open = rounds.find((round) => round.status === "OPEN");
  assert.equal(completed.longQty, "5");
  assert.equal(completed.shortQty, "5");
  assert.equal(open.longQty, "0");
  assert.equal(open.shortQty, "5");
  assert.equal(open.remainingQty, "5");
});

test("回合按开始时间降序，同一毫秒创建的新回合也排在最上面", (t) => {
  const { store } = createStore(t);
  store.recordOrderExecution(
    execution(1, "BUY", "5", { updateTime: 2_000 }),
    context
  );
  store.recordOrderExecution(
    execution(2, "SELL", "10", { updateTime: 2_000 }),
    context
  );

  const rounds = store.list();
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].status, "OPEN");
  assert.equal(rounds[0].shortQty, "5");
  assert.equal(rounds[1].status, "COMPLETED");
  assert.ok(rounds[0].creationSequence > rounds[1].creationSequence);
});

test("开多与平空都计入多向，开空与平多都计入空向", (t) => {
  const { store } = createStore(t);
  store.recordOrderExecution(execution(1, "SELL", "10"), context);
  store.recordOrderExecution(execution(2, "BUY", "10", {
    reduceOnly: true,
  }), context);
  store.recordOrderExecution(execution(3, "BUY", "8"), context);
  store.recordOrderExecution(execution(4, "SELL", "8", {
    positionEffect: "CLOSE",
  }), context);

  const rounds = store.list();
  assert.equal(rounds.length, 2);
  assert.ok(rounds.every((round) => round.status === "COMPLETED"));
  assert.equal(rounds[1].openShortQty, "10");
  assert.equal(rounds[1].closeShortQty, "10");
  assert.equal(rounds[0].openLongQty, "8");
  assert.equal(rounds[0].closeLongQty, "8");
});

test("部分成交按累计成交量差额记账，重复事件与重启后对账不会重复", (t) => {
  const { store, filePath } = createStore(t);
  store.recordOrderExecution(execution(1, "BUY", "3"), context);
  store.recordOrderExecution(execution(1, "BUY", "10"), context);
  assert.equal(
    store.recordOrderExecution(execution(1, "BUY", "10"), context),
    null
  );
  assert.equal(store.list()[0].longQty, "10");
  store.flush();

  const reloaded = new TradingRoundStore(filePath, {
    now: () => 2_000,
    saveDelayMs: 60_000,
  });
  assert.equal(
    reloaded.recordOrderExecution(execution(1, "BUY", "10"), context),
    null
  );
  assert.equal(reloaded.list()[0].longQty, "10");
  reloaded.close();
});

test("Algo 更新和触发后的普通订单使用 actualOrderId 去重", (t) => {
  const { store } = createStore(t);
  store.recordOrderExecution({
    ...execution(77, "SELL", "5"),
    algoOrder: true,
    actualOrderId: 88,
  }, context);
  assert.equal(
    store.recordOrderExecution(execution(88, "SELL", "5"), context),
    null
  );
  assert.equal(store.list()[0].shortQty, "5");
});

test("现货卖出归类为平多，U 本位 reduceOnly 买入归类为平空", () => {
  assert.equal(resolveExecutionAction({ side: "SELL" }, "spot"), "CLOSE_LONG");
  assert.equal(
    resolveExecutionAction({ side: "BUY", R: true }, "futures"),
    "CLOSE_SHORT"
  );
});

function roundsLength(store) {
  return store.list().length;
}
