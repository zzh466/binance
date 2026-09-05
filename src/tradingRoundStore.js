const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  addDecimal,
  compareDecimal,
  isPositiveDecimal,
  subtractDecimal,
} = require("./binance/decimalMath");

const STORE_VERSION = 1;
const ROUND_STATUS_OPEN = "OPEN";
const ROUND_STATUS_COMPLETED = "COMPLETED";
const EXECUTION_ACTIONS = new Set([
  "OPEN_LONG",
  "CLOSE_SHORT",
  "OPEN_SHORT",
  "CLOSE_LONG",
]);

function firstPresent(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ""
  );
}

function normalizeBoolean(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function resolveExecutionAction(order = {}, marketType = "") {
  const side = String(firstPresent(order.side, order.S, "")).toUpperCase();
  if (!new Set(["BUY", "SELL"]).has(side)) return null;

  const positionEffect = String(
    firstPresent(order.positionEffect, "")
  ).toUpperCase();
  const closesPosition = marketType === "futures" && (
    positionEffect === "CLOSE" ||
    normalizeBoolean(firstPresent(order.reduceOnly, order.R, false)) ||
    normalizeBoolean(firstPresent(order.closePosition, order.cp, false))
  );

  if (side === "BUY") {
    return closesPosition ? "CLOSE_SHORT" : "OPEN_LONG";
  }
  if (marketType === "spot") return "CLOSE_LONG";
  return closesPosition ? "CLOSE_LONG" : "OPEN_SHORT";
}

function getActionDirection(action) {
  if (["OPEN_LONG", "CLOSE_SHORT"].includes(action)) return "LONG";
  if (["OPEN_SHORT", "CLOSE_LONG"].includes(action)) return "SHORT";
  return null;
}

function getActionQuantityField(action) {
  return {
    OPEN_LONG: "openLongQty",
    CLOSE_SHORT: "closeShortQty",
    OPEN_SHORT: "openShortQty",
    CLOSE_LONG: "closeLongQty",
  }[action];
}

function compareRoundsNewestFirst(left = {}, right = {}) {
  const createdAtDifference =
    Number(right.createdAt || 0) - Number(left.createdAt || 0);
  if (createdAtDifference !== 0) return createdAtDifference;

  const sequenceDifference =
    Number(right.creationSequence || 0) - Number(left.creationSequence || 0);
  if (sequenceDifference !== 0) return sequenceDifference;

  return String(right.id || "").localeCompare(String(left.id || ""));
}

function getExecutionIdentity(order = {}) {
  const actualOrderId = firstPresent(
    order.actualOrderId,
    order.actualOrderID,
    order.actualOrder?.orderId
  );
  if (actualOrderId !== undefined) return `order:${actualOrderId}`;
  const orderId = firstPresent(order.orderId, order.i, order.algoId);
  if (orderId !== undefined) {
    return `${order.algoOrder === true ? "algo" : "order"}:${orderId}`;
  }
  const clientOrderId = firstPresent(
    order.clientOrderId,
    order.c,
    order.newClientOrderId,
    order.clientAlgoId
  );
  return clientOrderId ? `client:${clientOrderId}` : null;
}

function getCumulativeExecutedQuantity(order = {}) {
  return String(firstPresent(
    order.executedQty,
    order.z,
    order.actualExecutedQty,
    order.cumulativeFilledQty,
    "0"
  ));
}

function createRound({
  id,
  environment,
  accountFingerprint,
  marketType,
  symbol,
  time,
  creationSequence,
}) {
  return {
    id,
    environment,
    accountFingerprint,
    marketType,
    symbol,
    creationSequence,
    status: ROUND_STATUS_OPEN,
    longQty: "0",
    shortQty: "0",
    openLongQty: "0",
    closeShortQty: "0",
    openShortQty: "0",
    closeLongQty: "0",
    remainingDirection: "FLAT",
    remainingQty: "0",
    executionCount: 0,
    orderIds: [],
    createdAt: time,
    updatedAt: time,
    completedAt: null,
  };
}

class TradingRoundStore {
  constructor(filePath, {
    now = () => Date.now(),
    idFactory = () => crypto.randomUUID(),
    saveDelayMs = 50,
  } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.idFactory = idFactory;
    this.saveDelayMs = saveDelayMs;
    this.rounds = [];
    this.nextCreationSequence = 1;
    this.executionCursors = {};
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const storedRounds = Array.isArray(payload?.rounds) ? payload.rounds : [];
      this.rounds = storedRounds.map((round, index) => ({
        ...round,
        creationSequence: Number.isSafeInteger(Number(round.creationSequence))
          ? Number(round.creationSequence)
          : index + 1,
      }));
      this.nextCreationSequence = this.rounds.reduce(
        (maximum, round) => Math.max(maximum, round.creationSequence),
        0
      ) + 1;
      this.executionCursors = payload?.executionCursors &&
        typeof payload.executionCursors === "object"
        ? payload.executionCursors
        : {};
    } catch {
      this.rounds = [];
      this.nextCreationSequence = 1;
      this.executionCursors = {};
    }
  }

  getScope(context = {}, order = {}) {
    const environment = String(context.environment || "unknown");
    const accountFingerprint = String(
      context.accountFingerprint || "anonymous"
    );
    const marketType = String(
      firstPresent(order.marketType, context.marketType, "")
    ).toLowerCase();
    const symbol = String(firstPresent(order.symbol, order.s, "")).toUpperCase();
    if (!marketType || !symbol) return null;
    return { environment, accountFingerprint, marketType, symbol };
  }

  getActiveRound(scope) {
    for (let index = this.rounds.length - 1; index >= 0; index -= 1) {
      const round = this.rounds[index];
      if (
        round.status === ROUND_STATUS_OPEN &&
        round.environment === scope.environment &&
        round.accountFingerprint === scope.accountFingerprint &&
        round.marketType === scope.marketType &&
        round.symbol === scope.symbol
      ) {
        return round;
      }
    }
    return null;
  }

  addExecutionToRound(round, action, quantity, orderIdentity, time) {
    const quantityField = getActionQuantityField(action);
    const direction = getActionDirection(action);
    round[quantityField] = addDecimal(round[quantityField], quantity);
    if (direction === "LONG") {
      round.longQty = addDecimal(round.longQty, quantity);
    } else {
      round.shortQty = addDecimal(round.shortQty, quantity);
    }
    round.executionCount += 1;
    if (orderIdentity && !round.orderIds.includes(orderIdentity)) {
      round.orderIds.push(orderIdentity);
    }
    round.updatedAt = time;

    const comparison = compareDecimal(round.longQty, round.shortQty);
    if (comparison === 0) {
      round.status = ROUND_STATUS_COMPLETED;
      round.remainingDirection = "FLAT";
      round.remainingQty = "0";
      round.completedAt = time;
    } else {
      round.remainingDirection = comparison > 0 ? "LONG" : "SHORT";
      round.remainingQty = comparison > 0
        ? subtractDecimal(round.longQty, round.shortQty)
        : subtractDecimal(round.shortQty, round.longQty);
    }
  }

  applyExecution(scope, action, quantity, orderIdentity, time) {
    let remaining = quantity;
    const affectedRounds = [];
    const incomingDirection = getActionDirection(action);

    while (isPositiveDecimal(remaining)) {
      let round = this.getActiveRound(scope);
      if (!round) {
        round = createRound({
          ...scope,
          id: this.idFactory(),
          time,
          creationSequence: this.nextCreationSequence++,
        });
        this.rounds.push(round);
      }

      const currentDirection = round.remainingDirection === "FLAT"
        ? incomingDirection
        : round.remainingDirection;
      if (currentDirection === incomingDirection) {
        this.addExecutionToRound(
          round,
          action,
          remaining,
          orderIdentity,
          time
        );
        affectedRounds.push(round.id);
        remaining = "0";
        continue;
      }

      const comparison = compareDecimal(remaining, round.remainingQty);
      const matchedQuantity = comparison <= 0
        ? remaining
        : round.remainingQty;
      this.addExecutionToRound(
        round,
        action,
        matchedQuantity,
        orderIdentity,
        time
      );
      affectedRounds.push(round.id);
      remaining = comparison > 0
        ? subtractDecimal(remaining, matchedQuantity)
        : "0";
    }

    return affectedRounds;
  }

  recordOrderExecution(order, context = {}) {
    if (!order || typeof order !== "object") return null;
    const scope = this.getScope(context, order);
    if (!scope) return null;
    const orderIdentity = getExecutionIdentity(order);
    if (!orderIdentity) return null;
    const action = resolveExecutionAction(order, scope.marketType);
    if (!EXECUTION_ACTIONS.has(action)) return null;

    const cumulativeQty = getCumulativeExecutedQuantity(order);
    if (!isPositiveDecimal(cumulativeQty)) return null;
    const cursorKey = [
      scope.environment,
      scope.accountFingerprint,
      scope.marketType,
      scope.symbol,
      orderIdentity,
    ].join(":");
    const previousQty = String(
      this.executionCursors[cursorKey]?.cumulativeQty || "0"
    );
    if (compareDecimal(cumulativeQty, previousQty) <= 0) return null;

    const delta = subtractDecimal(cumulativeQty, previousQty);
    const time = Number(firstPresent(
      order.updateTime,
      order.T,
      order.E,
      order.transactTime,
      context.updatedAt,
      this.now()
    ));
    const affectedRoundIds = this.applyExecution(
      scope,
      action,
      delta,
      orderIdentity,
      Number.isFinite(time) && time > 0 ? time : this.now()
    );
    this.executionCursors[cursorKey] = {
      cumulativeQty,
      updatedAt: this.now(),
    };
    this.scheduleSave();
    return {
      action,
      direction: getActionDirection(action),
      delta,
      cumulativeQty,
      affectedRoundIds,
    };
  }

  list({ environment, accountFingerprints, marketType, symbol } = {}) {
    const allowedAccounts = Array.isArray(accountFingerprints)
      ? new Set(accountFingerprints.filter(Boolean))
      : null;
    const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
    return this.rounds
      .filter((round) => !environment || round.environment === environment)
      .filter((round) =>
        !allowedAccounts || allowedAccounts.has(round.accountFingerprint)
      )
      .filter((round) => !marketType || round.marketType === marketType)
      .filter((round) => !normalizedSymbol || round.symbol === normalizedSymbol)
      .sort(compareRoundsNewestFirst)
      .map((round) => ({ ...round, orderIds: [...(round.orderIds || [])] }));
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = `${JSON.stringify({
      version: STORE_VERSION,
      updatedAt: this.now(),
      rounds: this.rounds,
      executionCursors: this.executionCursors,
    }, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, payload, "utf8");
    fs.renameSync(temporaryPath, this.filePath);
  }

  close() {
    if (this.saveTimer) this.flush();
  }
}

module.exports = {
  ROUND_STATUS_COMPLETED,
  ROUND_STATUS_OPEN,
  TradingRoundStore,
  compareRoundsNewestFirst,
  getActionDirection,
  resolveExecutionAction,
};
