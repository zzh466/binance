class LocalOrderBook {
  constructor() {
    this.clear();
  }

  clear() {
    this.symbol = null;
    this.lastUpdateId = null;
    this.bids = new Map();
    this.asks = new Map();
  }

  loadSnapshot({ symbol, lastUpdateId, bids = [], asks = [] }) {
    const updateId = Number(lastUpdateId);

    if (!Number.isSafeInteger(updateId) || updateId < 0) {
      throw new TypeError(`非法的深度快照 lastUpdateId：${lastUpdateId}`);
    }

    this.symbol = symbol || null;
    this.lastUpdateId = updateId;
    this.bids = this.createSide(bids);
    this.asks = this.createSide(asks);
  }

  createSide(levels) {
    const side = new Map();

    for (const level of levels) {
      this.setPriceLevel(side, level);
    }

    return side;
  }

  setPriceLevel(side, level) {
    if (!Array.isArray(level) || level.length < 2) {
      throw new TypeError(`非法的深度价位：${JSON.stringify(level)}`);
    }

    const price = String(level[0]);
    const quantity = String(level[1]);

    if (!price || !quantity) {
      throw new TypeError(`深度价位缺少价格或数量：${JSON.stringify(level)}`);
    }

    if (Number(quantity) === 0) {
      side.delete(price);
    } else {
      side.set(price, quantity);
    }
  }

  applyEvent(event) {
    if (this.lastUpdateId === null) {
      return {
        applied: false,
        reason: "not-initialized",
      };
    }

    const firstUpdateId = Number(event.U);
    const finalUpdateId = Number(event.u);

    if (
      !Number.isSafeInteger(firstUpdateId) ||
      !Number.isSafeInteger(finalUpdateId)
    ) {
      throw new TypeError(
        `非法的深度更新序号：U=${event.U}, u=${event.u}`
      );
    }

    // 重复事件或已经包含在当前本地订单簿中的旧事件。
    if (finalUpdateId <= this.lastUpdateId) {
      return {
        applied: false,
        reason: "stale",
      };
    }

    // 下一个事件的起始序号越过 lastUpdateId + 1，说明中间发生丢包。
    if (firstUpdateId > this.lastUpdateId + 1) {
      return {
        applied: false,
        reason: "sequence-gap",
        expectedMaxFirstUpdateId: this.lastUpdateId + 1,
        actualFirstUpdateId: firstUpdateId,
      };
    }

    for (const level of event.b || []) {
      this.setPriceLevel(this.bids, level);
    }

    for (const level of event.a || []) {
      this.setPriceLevel(this.asks, level);
    }

    this.lastUpdateId = finalUpdateId;

    return {
      applied: true,
      reason: "applied",
    };
  }

  getTopLevels(limit = 10) {
    const normalizedLimit = Math.max(1, Math.floor(Number(limit) || 10));

    return {
      bids: this.sortSide(this.bids, true).slice(0, normalizedLimit),
      asks: this.sortSide(this.asks, false).slice(0, normalizedLimit),
    };
  }

  sortSide(side, descending) {
    return [...side.entries()]
      .sort(([leftPrice], [rightPrice]) => {
        const difference = Number(leftPrice) - Number(rightPrice);
        return descending ? -difference : difference;
      })
      .map(([price, quantity]) => ({ price, quantity }));
  }
}

module.exports = {
  LocalOrderBook,
};
