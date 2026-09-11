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
  const FUTURES_MARKET_LABEL = "U 本位";

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
    return {
      futures: normalizeSource(
        snapshot.sources?.futures,
        snapshot.complete === true
      ),
    };
  }

  function futuresPositions(positions) {
    return (Array.isArray(positions) ? positions : [])
      .filter((position) => position?.marketType === "futures");
  }

  function buildPositionSnapshot(metrics, {
    environment = "production",
    accountName = "",
    accountFingerprint = "",
    futureAccountId = "",
    positionEvidenceVersion = 0,
  } = {}) {
    const positionsUpdatedAt = Number(
      metrics?.positionsUpdatedAt ??
      metrics?.positionSources?.futures?.updatedAt
    ) || null;
    return {
      positions: futuresPositions(metrics?.positions),
      environment: metrics?.environment || environment,
      accountName,
      accountFingerprint:
        metrics?.accountFingerprint || accountFingerprint || "",
      futureAccountId:
        metrics?.futureAccountId || futureAccountId || "",
      // 收益、余额等信息会独立更新，不能借用它们的时间把旧持仓
      // 快照伪装成一份新的空仓确认。
      updatedAt: positionsUpdatedAt,
      positionsUpdatedAt,
      positionEvidenceVersion: Math.max(
        0,
        Math.floor(Number(
          metrics?.positionEvidenceVersion ?? positionEvidenceVersion
        ) || 0)
      ),
      complete: Boolean(metrics && metrics.positionsComplete === true),
      knownOpenOrderCount: Math.max(
        0,
        Math.floor(Number(metrics?.orderVolume) || 0)
      ),
      sources: {
        futures: metrics?.positionSources?.futures || null,
      },
      warnings: Array.isArray(metrics?.warnings) ? metrics.warnings : [],
    };
  }

  function getSourceFailures(source) {
    if (!source.configured) {
      return [`${FUTURES_MARKET_LABEL}凭证未配置`];
    }
    if (!source.ok) {
      const message = source.error?.message;
      return [message
        ? `${FUTURES_MARKET_LABEL}查询失败（${message}）`
        : `${FUTURES_MARKET_LABEL}查询失败`];
    }
    return [];
  }

  function isSamePositionScope(previous = {}, next = {}) {
    if (
      previous.environment &&
      next.environment &&
      previous.environment !== next.environment
    ) {
      return false;
    }
    if (previous.accountFingerprint || next.accountFingerprint) {
      if (
        !previous.accountFingerprint ||
        !next.accountFingerprint ||
        previous.accountFingerprint !== next.accountFingerprint
      ) {
        return false;
      }
    }
    if (previous.futureAccountId || next.futureAccountId) {
      if (
        !previous.futureAccountId ||
        !next.futureAccountId ||
        String(previous.futureAccountId) !== String(next.futureAccountId)
      ) {
        return false;
      }
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

    const source = normalizeSources(next).futures;
    const nextRows = futuresPositions(next.positions);
    const previousRows = futuresPositions(previous.positions);
    const previousInvalidationVersion = Math.max(
      0,
      Math.floor(Number(previous.positionInvalidationVersion) || 0)
    );
    const nextInvalidationVersion = Math.max(
      previousInvalidationVersion,
      Math.floor(Number(next.positionInvalidationVersion) || 0)
    );
    const nextEvidenceVersion = Math.max(
      0,
      Math.floor(Number(next.positionEvidenceVersion) || 0)
    );
    const confirmationRequired = next.positionConfirmationRequired === true || (
      previous.positionConfirmationRequired === true &&
      nextEvidenceVersion < previousInvalidationVersion
    );
    const rows = nextRows.length > 0 || (source.ok && !confirmationRequired)
      ? nextRows
      : previousRows;
    const effectiveSource = confirmationRequired
      ? {
          ...source,
          ok: false,
          error: next.invalidationError || previous.invalidationError || {
            name: "PositionConfirmationRequiredError",
            message: "成交后正在复核 U 本位持仓",
          },
        }
      : source;
    return {
      ...next,
      complete: confirmationRequired ? false : next.complete === true,
      positionConfirmationRequired: confirmationRequired,
      positionInvalidationVersion: nextInvalidationVersion,
      positionEvidenceVersion: nextEvidenceVersion,
      sources: { futures: effectiveSource },
      positions: rows.map((position) => ({
        ...position,
        _positionSnapshotStale: !effectiveSource.ok,
      })),
    };
  }

  function invalidatePositionSnapshot(snapshot = {}, {
    environment,
    accountName,
    accountFingerprint,
    futureAccountId,
    invalidationVersion = 0,
    invalidatedAt = Date.now(),
    reason = "成交后正在复核 U 本位持仓",
  } = {}) {
    const source = normalizeSources(snapshot).futures;
    const invalidationError = {
      name: "PositionConfirmationRequiredError",
      message: reason,
    };
    return {
      ...snapshot,
      environment: environment || snapshot.environment || "production",
      accountName: accountName || snapshot.accountName || "",
      accountFingerprint:
        accountFingerprint || snapshot.accountFingerprint || "",
      futureAccountId: futureAccountId || snapshot.futureAccountId || "",
      complete: false,
      positionConfirmationRequired: true,
      positionInvalidationVersion: Math.max(
        0,
        Math.floor(Number(invalidationVersion) || 0)
      ),
      invalidatedAt: Number(invalidatedAt) || Date.now(),
      invalidationError,
      sources: {
        futures: {
          ...source,
          ok: false,
          error: invalidationError,
        },
      },
    };
  }

  function evaluatePositionSafety(snapshot = {}, {
    now = Date.now(),
    staleMs = POSITION_SNAPSHOT_STALE_MS,
    requiredConfirmations = REQUIRED_FLAT_CONFIRMATIONS,
    previousFlatConfirmations = 0,
    previousConfirmedAt = null,
  } = {}) {
    const positions = futuresPositions(snapshot.positions);
    const sources = normalizeSources(snapshot);
    const sourceFailures = getSourceFailures(sources.futures);
    const updatedAt = Number(snapshot.updatedAt);
    const validUpdatedAt = Number.isFinite(updatedAt) && updatedAt > 0
      ? updatedAt
      : null;
    const ageMs = validUpdatedAt === null
      ? null
      : Math.max(0, Number(now) - validUpdatedAt);
    const stale = ageMs === null || ageMs > staleMs;
    const complete = snapshot.complete === true && sourceFailures.length === 0;
    const knownOpenOrderCount = Math.max(
      0,
      Math.floor(Number(snapshot.knownOpenOrderCount) || 0)
    );
    const required = Math.max(1, Math.floor(Number(requiredConfirmations) || 1));

    if (positions.length > 0) {
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
        knownOpenOrderCount,
        message: `存在 ${positions.length} 项 U 本位永续持仓${incompleteSuffix}`,
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
        knownOpenOrderCount,
        message: `无法确认是否空仓：${[
          ...new Set(failureReasons),
        ].join("；") || "持仓快照不完整"}`,
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
      knownOpenOrderCount,
      message: flatConfirmed
        ? `已连续 ${flatConfirmations} 次确认 U 本位永续无持仓`
        : `首次确认无持仓，正在等待第 ${flatConfirmations + 1} 次复核`,
      emptyMessage: flatConfirmed
        ? "已确认：当前账户没有 U 本位永续持仓。"
        : "本次查询未发现持仓，等待下一次完整快照复核。",
    };
  }

  return {
    FUTURES_MARKET_LABEL,
    POSITION_SNAPSHOT_STALE_MS,
    REQUIRED_FLAT_CONFIRMATIONS,
    buildPositionSnapshot,
    evaluatePositionSafety,
    invalidatePositionSnapshot,
    mergePositionSnapshots,
    normalizeSources,
  };
});
