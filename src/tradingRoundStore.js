const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  addDecimal,
  compareDecimal,
  divideDecimal,
  isPositiveDecimal,
  multiplyDecimal,
  subtractDecimal,
} = require("./binance/decimalMath");

const STORE_VERSION = 2;
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

function compareRoundsOldestFirst(left = {}, right = {}) {
  return compareRoundsNewestFirst(right, left);
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

function firstPositiveDecimal(...values) {
  for (const value of values) {
    if (isPositiveDecimal(value)) return String(value);
  }
  return null;
}

function calculateAveragePrice(quoteAmount, quantity) {
  if (!isPositiveDecimal(quantity)) return "0";
  if (!isPositiveDecimal(quoteAmount)) return null;
  return divideDecimal(quoteAmount, quantity);
}

function getExecutionQuoteAmounts(
  order,
  { cumulativeQty, previousQty, previousQuoteAmount }
) {
  const deltaQty = subtractDecimal(cumulativeQty, previousQty);
  const averagePrice = firstPositiveDecimal(
    order.avgPrice,
    order.averagePrice,
    order.ap
  );
  const explicitCumulativeQuoteAmount = firstPositiveDecimal(
    order.cummulativeQuoteQty,
    order.cumulativeQuoteQty,
    order.cumQuote,
    order.Z
  );
  const cumulativeQuoteAmount = explicitCumulativeQuoteAmount || (
    averagePrice ? multiplyDecimal(cumulativeQty, averagePrice) : null
  );

  if (cumulativeQuoteAmount) {
    if (!isPositiveDecimal(previousQty)) {
      return { deltaQuoteAmount: cumulativeQuoteAmount, cumulativeQuoteAmount };
    }
    if (isPositiveDecimal(previousQuoteAmount)) {
      const deltaQuoteAmount = subtractDecimal(
        cumulativeQuoteAmount,
        previousQuoteAmount
      );
      if (isPositiveDecimal(deltaQuoteAmount)) {
        return { deltaQuoteAmount, cumulativeQuoteAmount };
      }
    }
  }

  const lastExecutedQty = firstPositiveDecimal(
    order.lastExecutedQty,
    order.l
  );
  const lastQuoteAmount = firstPositiveDecimal(
    order.lastQuoteAssetTransacted,
    order.Y
  );
  if (
    lastQuoteAmount &&
    (!lastExecutedQty || compareDecimal(lastExecutedQty, deltaQty) === 0)
  ) {
    return {
      deltaQuoteAmount: lastQuoteAmount,
      cumulativeQuoteAmount: cumulativeQuoteAmount || (
        isPositiveDecimal(previousQuoteAmount)
          ? addDecimal(previousQuoteAmount, lastQuoteAmount)
          : !isPositiveDecimal(previousQty) ? lastQuoteAmount : null
      ),
    };
  }

  const executionPrice = firstPositiveDecimal(
    order.lastExecutedPrice,
    order.L,
    averagePrice,
    order.price,
    order.p
  );
  const deltaQuoteAmount = executionPrice
    ? multiplyDecimal(deltaQty, executionPrice)
    : null;
  return {
    deltaQuoteAmount,
    cumulativeQuoteAmount: cumulativeQuoteAmount || (
      deltaQuoteAmount && isPositiveDecimal(previousQuoteAmount)
        ? addDecimal(previousQuoteAmount, deltaQuoteAmount)
        : deltaQuoteAmount && !isPositiveDecimal(previousQty)
          ? deltaQuoteAmount
          : null
    ),
  };
}

function normalizeStoredRound(round, index) {
  const normalized = {
    ...round,
    longQty: String(round.longQty || "0"),
    shortQty: String(round.shortQty || "0"),
    creationSequence: Number.isSafeInteger(Number(round.creationSequence))
      ? Number(round.creationSequence)
      : index + 1,
  };
  for (const direction of ["long", "short"]) {
    const quantityField = `${direction}Qty`;
    const quoteAmountField = `${direction}QuoteAmount`;
    const averagePriceField = `${direction}AveragePrice`;
    const quantity = normalized[quantityField];
    const storedQuoteAmount = firstPositiveDecimal(round[quoteAmountField]);
    const storedAveragePrice = firstPositiveDecimal(round[averagePriceField]);
    const quoteAmount = storedQuoteAmount || (
      storedAveragePrice && isPositiveDecimal(quantity)
        ? multiplyDecimal(quantity, storedAveragePrice)
        : !isPositiveDecimal(quantity) ? "0" : null
    );
    normalized[quoteAmountField] = quoteAmount;
    normalized[averagePriceField] = calculateAveragePrice(
      quoteAmount,
      quantity
    );
  }
  return normalized;
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
    longQuoteAmount: "0",
    shortQuoteAmount: "0",
    longAveragePrice: "0",
    shortAveragePrice: "0",
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
      this.rounds = storedRounds.map(normalizeStoredRound);
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

  addExecutionToRound(
    round,
    action,
    quantity,
    quoteAmount,
    orderIdentity,
    time
  ) {
    const quantityField = getActionQuantityField(action);
    const direction = getActionDirection(action);
    round[quantityField] = addDecimal(round[quantityField], quantity);
    const directionQuantityField = direction === "LONG" ? "longQty" : "shortQty";
    const quoteAmountField = direction === "LONG"
      ? "longQuoteAmount"
      : "shortQuoteAmount";
    const averagePriceField = direction === "LONG"
      ? "longAveragePrice"
      : "shortAveragePrice";
    if (direction === "LONG") {
      round.longQty = addDecimal(round.longQty, quantity);
    } else {
      round.shortQty = addDecimal(round.shortQty, quantity);
    }
    round[quoteAmountField] =
      round[quoteAmountField] !== null && isPositiveDecimal(quoteAmount)
        ? addDecimal(round[quoteAmountField], quoteAmount)
        : null;
    round[averagePriceField] = calculateAveragePrice(
      round[quoteAmountField],
      round[directionQuantityField]
    );
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

  applyExecution(
    scope,
    action,
    quantity,
    quoteAmount,
    orderIdentity,
    time
  ) {
    let remaining = quantity;
    let remainingQuoteAmount = quoteAmount;
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
          remainingQuoteAmount,
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
      const matchedQuoteAmount = comparison <= 0
        ? remainingQuoteAmount
        : isPositiveDecimal(remainingQuoteAmount)
          ? multiplyDecimal(
            remainingQuoteAmount,
            divideDecimal(matchedQuantity, remaining, 30)
          )
          : null;
      this.addExecutionToRound(
        round,
        action,
        matchedQuantity,
        matchedQuoteAmount,
        orderIdentity,
        time
      );
      affectedRounds.push(round.id);
      remaining = comparison > 0
        ? subtractDecimal(remaining, matchedQuantity)
        : "0";
      remainingQuoteAmount = comparison > 0 && isPositiveDecimal(remainingQuoteAmount)
        ? subtractDecimal(remainingQuoteAmount, matchedQuoteAmount)
        : null;
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
    const previousQuoteAmount = this.executionCursors[cursorKey]
      ?.cumulativeQuoteAmount ?? null;
    const {
      deltaQuoteAmount,
      cumulativeQuoteAmount,
    } = getExecutionQuoteAmounts(order, {
      cumulativeQty,
      previousQty,
      previousQuoteAmount,
    });
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
      deltaQuoteAmount,
      orderIdentity,
      Number.isFinite(time) && time > 0 ? time : this.now()
    );
    this.executionCursors[cursorKey] = {
      cumulativeQty,
      cumulativeQuoteAmount,
      updatedAt: this.now(),
    };
    this.scheduleSave();
    return {
      action,
      direction: getActionDirection(action),
      delta,
      deltaQuoteAmount,
      cumulativeQty,
      affectedRoundIds,
    };
  }

  listMissingPricingOrderReferences({
    environment,
    accountFingerprints,
    marketType,
    symbol,
  } = {}) {
    const allowedAccounts = Array.isArray(accountFingerprints)
      ? new Set(accountFingerprints.filter(Boolean))
      : null;
    const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
    const references = new Map();
    for (const round of this.rounds) {
      if (environment && round.environment !== environment) continue;
      if (allowedAccounts && !allowedAccounts.has(round.accountFingerprint)) {
        continue;
      }
      if (marketType && round.marketType !== marketType) continue;
      if (normalizedSymbol && round.symbol !== normalizedSymbol) continue;
      const missingLong = isPositiveDecimal(round.longQty) &&
        !isPositiveDecimal(round.longQuoteAmount);
      const missingShort = isPositiveDecimal(round.shortQty) &&
        !isPositiveDecimal(round.shortQuoteAmount);
      if (!missingLong && !missingShort) continue;

      for (const orderIdentity of round.orderIds || []) {
        const [identityType, ...identityParts] = String(orderIdentity).split(":");
        const identityValue = identityParts.join(":");
        if (!identityValue || !["order", "algo", "client"].includes(identityType)) {
          continue;
        }
        const key = [
          round.environment,
          round.accountFingerprint,
          round.marketType,
          round.symbol,
          orderIdentity,
        ].join(":");
        const existing = references.get(key);
        const reference = {
          environment: round.environment,
          accountFingerprint: round.accountFingerprint,
          marketType: round.marketType,
          symbol: round.symbol,
          orderIdentity,
          orderId: identityType === "order" || identityType === "algo"
            ? identityValue
            : undefined,
          origClientOrderId: identityType === "client"
            ? identityValue
            : undefined,
          roundCreatedAt: Number(round.createdAt || 0),
          roundIds: [round.id],
        };
        if (!existing) {
          references.set(key, reference);
        } else {
          if (!existing.roundIds.includes(round.id)) {
            existing.roundIds.push(round.id);
          }
          existing.roundCreatedAt = Math.max(
            existing.roundCreatedAt,
            reference.roundCreatedAt
          );
        }
      }
    }
    return [...references.values()].sort(
      (left, right) => right.roundCreatedAt - left.roundCreatedAt
    );
  }

  backfillExecutionPricing(orders, context = {}) {
    const preparedOrders = [];
    for (const order of Array.isArray(orders) ? orders : [orders]) {
      if (!order || typeof order !== "object") continue;
      const scope = this.getScope(context, order);
      const orderIdentity = getExecutionIdentity(order);
      const action = scope && resolveExecutionAction(order, scope.marketType);
      const cumulativeQty = getCumulativeExecutedQuantity(order);
      if (
        !scope ||
        !orderIdentity ||
        !EXECUTION_ACTIONS.has(action) ||
        !isPositiveDecimal(cumulativeQty)
      ) {
        continue;
      }
      const { deltaQuoteAmount } = getExecutionQuoteAmounts(order, {
        cumulativeQty,
        previousQty: "0",
        previousQuoteAmount: null,
      });
      if (!isPositiveDecimal(deltaQuoteAmount)) continue;
      preparedOrders.push({
        order,
        scope,
        orderIdentity,
        action,
        cumulativeQty,
        quoteAmount: deltaQuoteAmount,
        time: Number(firstPresent(
          order.time,
          order.updateTime,
          order.T,
          order.E,
          order.transactTime,
          0
        )),
      });
    }
    preparedOrders.sort((left, right) => left.time - right.time);

    const roundsByScope = new Map();
    for (const round of this.rounds) {
      const scopeKey = [
        round.environment,
        round.accountFingerprint,
        round.marketType,
        round.symbol,
      ].join(":");
      if (!roundsByScope.has(scopeKey)) roundsByScope.set(scopeKey, []);
      roundsByScope.get(scopeKey).push(round);
    }
    for (const rounds of roundsByScope.values()) {
      rounds.sort(compareRoundsOldestFirst);
    }

    const remainingActionQuantity = new Map();
    const backfilled = new Map();
    const getBackfillDirection = (round, direction) => {
      if (!backfilled.has(round.id)) {
        backfilled.set(round.id, {
          LONG: { quantity: "0", quoteAmount: "0" },
          SHORT: { quantity: "0", quoteAmount: "0" },
        });
      }
      return backfilled.get(round.id)[direction];
    };

    for (const prepared of preparedOrders) {
      const scopeKey = [
        prepared.scope.environment,
        prepared.scope.accountFingerprint,
        prepared.scope.marketType,
        prepared.scope.symbol,
      ].join(":");
      const rounds = roundsByScope.get(scopeKey) || [];
      let remainingQuantity = prepared.cumulativeQty;
      let remainingQuoteAmount = prepared.quoteAmount;
      for (const round of rounds) {
        if (!round.orderIds?.includes(prepared.orderIdentity)) continue;
        const capacityKey = `${round.id}:${prepared.action}`;
        if (!remainingActionQuantity.has(capacityKey)) {
          remainingActionQuantity.set(
            capacityKey,
            String(round[getActionQuantityField(prepared.action)] || "0")
          );
        }
        const capacity = remainingActionQuantity.get(capacityKey);
        if (!isPositiveDecimal(capacity) || !isPositiveDecimal(remainingQuantity)) {
          continue;
        }
        const allocationQuantity = compareDecimal(
          remainingQuantity,
          capacity
        ) <= 0 ? remainingQuantity : capacity;
        const allocationQuoteAmount = compareDecimal(
          allocationQuantity,
          remainingQuantity
        ) === 0
          ? remainingQuoteAmount
          : multiplyDecimal(
            remainingQuoteAmount,
            divideDecimal(allocationQuantity, remainingQuantity, 30)
          );
        const direction = getActionDirection(prepared.action);
        const directionBackfill = getBackfillDirection(round, direction);
        directionBackfill.quantity = addDecimal(
          directionBackfill.quantity,
          allocationQuantity
        );
        directionBackfill.quoteAmount = addDecimal(
          directionBackfill.quoteAmount,
          allocationQuoteAmount
        );
        remainingActionQuantity.set(
          capacityKey,
          subtractDecimal(capacity, allocationQuantity)
        );
        remainingQuantity = subtractDecimal(
          remainingQuantity,
          allocationQuantity
        );
        remainingQuoteAmount = isPositiveDecimal(remainingQuantity)
          ? subtractDecimal(remainingQuoteAmount, allocationQuoteAmount)
          : "0";
      }
    }

    const affectedRoundIds = [];
    for (const round of this.rounds) {
      const pricing = backfilled.get(round.id);
      if (!pricing) continue;
      let changed = false;
      for (const direction of ["LONG", "SHORT"]) {
        const quantityField = direction === "LONG" ? "longQty" : "shortQty";
        const quoteAmountField = direction === "LONG"
          ? "longQuoteAmount"
          : "shortQuoteAmount";
        const averagePriceField = direction === "LONG"
          ? "longAveragePrice"
          : "shortAveragePrice";
        if (
          round[quoteAmountField] !== null ||
          !isPositiveDecimal(round[quantityField]) ||
          compareDecimal(pricing[direction].quantity, round[quantityField]) !== 0 ||
          !isPositiveDecimal(pricing[direction].quoteAmount)
        ) {
          continue;
        }
        round[quoteAmountField] = pricing[direction].quoteAmount;
        round[averagePriceField] = calculateAveragePrice(
          pricing[direction].quoteAmount,
          round[quantityField]
        );
        changed = true;
      }
      if (changed) affectedRoundIds.push(round.id);
    }
    if (affectedRoundIds.length) this.scheduleSave();
    return { affectedRoundIds };
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
