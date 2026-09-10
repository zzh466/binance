(function exposePositionSafety(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.PositionSafety = api;
  }
})(typeof window !== "undefined" ? window : globalThis, () => {
  const REQUIRED_FLAT_CONFIRMATIONS = 2;
  const POSITION_SNAPSHOT_STALE_MS = 8_000;
  const MARKET_LABELS = Object.freeze({
    spot: "现货",
    futures: "U 本位",
  });
  const POSITION_DISPLAY_MARKETS = Object.freeze(["futures", "spot"]);

  function normalizeSource(source, fallbackComplete) {
    if (!source || typeof source !== "object") {
      return {
        configured: true,
        ok: fallbackComplete === true,
        updatedAt: null,
        error: null,
      };
    }
    return {
      configured: source.configured === true,
      ok: source.ok === true,
      updatedAt: Number(source.updatedAt) || null,
      error: source.error || null,
    };
  }

  function normalizeSources(snapshot = {}) {
    const fallbackComplete = snapshot.complete === true;
    return Object.fromEntries(
      Object.keys(MARKET_LABELS).map((marketType) => [
        marketType,
        normalizeSource(snapshot.sources?.[marketType], fallbackComplete),
      ])
    );
  }

  function buildPositionSnapshot(metrics, {
    environment = "production",
    accountName = "",
  } = {}) {
    return {
      positions: Array.isArray(metrics?.positions) ? metrics.positions : [],
      environment: metrics?.environment || environment,
      accountName,
      updatedAt: Number(metrics?.updatedAt) || null,
      complete: Boolean(metrics && metrics.positionsComplete === true),
      knownOpenOrderCount: Math.max(
        0,
        Math.floor(Number(metrics?.orderVolume) || 0)
      ),
      sources: metrics?.positionSources || null,
      warnings: Array.isArray(metrics?.warnings) ? metrics.warnings : [],
    };
  }

  function getSourceFailures(sources) {
    return Object.entries(sources).flatMap(([marketType, source]) => {
      if (!source.configured) {
        return [`${MARKET_LABELS[marketType]}凭证未配置`];
      }
      if (!source.ok) {
        const message = source.error?.message;
        return [message
          ? `${MARKET_LABELS[marketType]}查询失败（${message}）`
          : `${MARKET_LABELS[marketType]}查询失败`];
      }
      return [];
    });
  }

  function isSamePositionScope(previous = {}, next = {}) {
    if (
      previous.environment &&
      next.environment &&
      previous.environment !== next.environment
    ) {
      return false;
    }
    if (
      previous.accountName &&
      next.accountName &&
      previous.accountName !== next.accountName
    ) {
      return false;
    }
    return true;
  }

  function mergePositionSnapshots(previous, next = {}) {
    if (!previous || !isSamePositionScope(previous, next)) return next;
    const nextSources = normalizeSources(next);
    const nextPositions = Array.isArray(next.positions) ? next.positions : [];
    const previousPositions = Array.isArray(previous.positions)
      ? previous.positions
      : [];
    const positions = [];

    for (const marketType of POSITION_DISPLAY_MARKETS) {
      const freshRows = nextPositions.filter((row) => row?.marketType === marketType);
      if (nextSources[marketType].ok) {
        positions.push(...freshRows.map((row) => ({
          ...row,
          _positionSnapshotStale: false,
        })));
        continue;
      }
      const lastKnownRows = previousPositions.filter(
        (row) => row?.marketType === marketType
      );
      positions.push(...lastKnownRows.map((row) => ({
        ...row,
        _positionSnapshotStale: true,
      })));
    }

    positions.push(...nextPositions.filter((row) =>
      !Object.hasOwn(MARKET_LABELS, row?.marketType)
    ));
    return { ...next, positions };
  }

  function evaluatePositionSafety(snapshot = {}, {
    now = Date.now(),
    staleMs = POSITION_SNAPSHOT_STALE_MS,
    requiredConfirmations = REQUIRED_FLAT_CONFIRMATIONS,
    previousFlatConfirmations = 0,
    previousConfirmedAt = null,
  } = {}) {
    const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
    const sources = normalizeSources(snapshot);
    const sourceFailures = getSourceFailures(sources);
    const updatedAt = Number(snapshot.updatedAt);
    const validUpdatedAt = Number.isFinite(updatedAt) && updatedAt > 0
      ? updatedAt
      : null;
    const ageMs = validUpdatedAt === null
      ? null
      : Math.max(0, Number(now) - validUpdatedAt);
    const stale = ageMs === null || ageMs > staleMs;
    const complete = snapshot.complete === true && sourceFailures.length === 0;
    const count = positions.length;
    const knownOpenOrderCount = Math.max(
      0,
      Math.floor(Number(snapshot.knownOpenOrderCount) || 0)
    );
    const spotCount = positions.filter((row) => row?.marketType === "spot").length;
    const futuresCount = positions.filter((row) => row?.marketType === "futures").length;
    const required = Math.max(1, Math.floor(Number(requiredConfirmations) || 1));

    if (count > 0) {
      const incompleteSuffix = complete && !stale
        ? ""
        : "；同时存在查询异常，列表可能还不完整";
      return {
        level: "danger",
        flatConfirmed: false,
        flatConfirmations: 0,
        confirmedAt: null,
        positions,
        sources,
        complete,
        stale,
        ageMs,
        spotCount,
        futuresCount,
        knownOpenOrderCount,
        message: `存在 ${count} 项持仓（现货 ${spotCount} / U 本位 ${futuresCount}）${incompleteSuffix}`,
        emptyMessage: "当前已查到持仓，请先处理并重新确认。",
      };
    }

    if (knownOpenOrderCount > 0) {
      return {
        level: "danger",
        flatConfirmed: false,
        flatConfirmations: 0,
        confirmedAt: null,
        positions,
        sources,
        complete,
        stale,
        ageMs,
        spotCount,
        futuresCount,
        knownOpenOrderCount,
        message: `当前未查到持仓，但程序已知仍有 ${knownOpenOrderCount} 笔未成交订单；之后成交可能重新建立持仓`,
        emptyMessage: "当前快照未发现持仓，但仍有未成交订单，不能作为休息前安全状态。",
      };
    }

    const failureReasons = [...sourceFailures];
    if (snapshot.error?.message) {
      failureReasons.push(`最近一次刷新失败（${snapshot.error.message}）`);
    }
    if (stale) {
      failureReasons.push(validUpdatedAt === null
        ? "尚未获得有效快照"
        : `数据已超过 ${Math.round(staleMs / 1000)} 秒未更新`);
    }
    if (!complete || stale || snapshot.error) {
      return {
        level: "unknown",
        flatConfirmed: false,
        flatConfirmations: 0,
        confirmedAt: null,
        positions,
        sources,
        complete,
        stale,
        ageMs,
        spotCount,
        futuresCount,
        knownOpenOrderCount,
        message: `无法确认是否空仓：${[...new Set(failureReasons)].join("；") || "持仓快照不完整"}`,
        emptyMessage: "当前快照未返回持仓，但查询结果不完整，不能据此判断空仓。",
      };
    }

    const priorAt = Number(previousConfirmedAt);
    const isNewSnapshot = !Number.isFinite(priorAt) || validUpdatedAt > priorAt;
    const flatConfirmations = isNewSnapshot
      ? Math.max(0, Number(previousFlatConfirmations) || 0) + 1
      : Math.max(0, Number(previousFlatConfirmations) || 0);
    const flatConfirmed = flatConfirmations >= required;

    return {
      level: flatConfirmed ? "safe" : "checking",
      flatConfirmed,
      flatConfirmations,
      confirmedAt: validUpdatedAt,
      positions,
      sources,
      complete,
      stale,
      ageMs,
      spotCount,
      futuresCount,
      knownOpenOrderCount,
      message: flatConfirmed
        ? `已连续 ${flatConfirmations} 次确认无持仓（现货与 U 本位均已核验）`
        : `首次确认无持仓，正在等待第 ${flatConfirmations + 1} 次复核`,
      emptyMessage: flatConfirmed
        ? "已确认：当前账户在现货和 U 本位永续中均无持仓。"
        : "本次查询未发现持仓，等待下一次完整快照复核。",
    };
  }

  return {
    MARKET_LABELS,
    POSITION_SNAPSHOT_STALE_MS,
    REQUIRED_FLAT_CONFIRMATIONS,
    buildPositionSnapshot,
    evaluatePositionSafety,
    mergePositionSnapshots,
    normalizeSources,
  };
});
