(function exposeDepthAggregation(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DepthAggregation = api;
  }
})(typeof window !== "undefined" ? window : globalThis, () => {
  const DECIMAL_PATTERN =
    /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i;
  const VALID_SCALES = Object.freeze([1, 5, 10]);

  function pow10(exponent) {
    return 10n ** BigInt(exponent);
  }

  function parseDecimal(value, name) {
    const text = String(value ?? "").trim();
    const match = DECIMAL_PATTERN.exec(text);
    if (!match) {
      throw new TypeError(`${name}不是有效的十进制数：${text || "空值"}`);
    }

    const sign = match[1] === "-" ? -1n : 1n;
    const whole = match[2] || "0";
    const fraction = match[3] ?? match[4] ?? "";
    const exponent = Number(match[5] || 0);
    let coefficient = sign * BigInt(`${whole}${fraction}` || "0");
    let decimalScale = fraction.length - exponent;
    if (decimalScale < 0) {
      coefficient *= pow10(-decimalScale);
      decimalScale = 0;
    }

    return { coefficient, scale: decimalScale };
  }

  function scaleCoefficient(decimal, targetScale) {
    return decimal.coefficient * pow10(targetScale - decimal.scale);
  }

  function formatDecimal(coefficient, scale, minimumScale = 0) {
    const negative = coefficient < 0n;
    let digits = (negative ? -coefficient : coefficient).toString();

    if (scale > 0) {
      digits = digits.padStart(scale + 1, "0");
      const whole = digits.slice(0, -scale);
      let fraction = digits.slice(-scale);
      while (fraction.length > minimumScale && fraction.endsWith("0")) {
        fraction = fraction.slice(0, -1);
      }
      digits = fraction ? `${whole}.${fraction}` : whole;
    }

    return `${negative ? "-" : ""}${digits}`;
  }

  function compareDecimals(left, right) {
    const leftDecimal = parseDecimal(left, "价格");
    const rightDecimal = parseDecimal(right, "价格");
    const commonScale = Math.max(leftDecimal.scale, rightDecimal.scale);
    const leftInteger = scaleCoefficient(leftDecimal, commonScale);
    const rightInteger = scaleCoefficient(rightDecimal, commonScale);
    if (leftInteger === rightInteger) return 0;
    return leftInteger < rightInteger ? -1 : 1;
  }

  function normalizeScale(scale) {
    const numeric = Number(scale);
    if (!Number.isInteger(numeric) || !VALID_SCALES.includes(numeric)) {
      throw new RangeError("行情缩放级别只能是 1、5 或 10。");
    }
    return numeric;
  }

  function createBucketDefinition(baseStep, scale) {
    const parsedStep = parseDecimal(baseStep, "行情基础步长");
    if (parsedStep.coefficient <= 0n) {
      throw new RangeError("行情基础步长必须大于 0。");
    }

    const normalizedScale = normalizeScale(scale);
    const bucket = {
      coefficient: parsedStep.coefficient * BigInt(normalizedScale),
      scale: parsedStep.scale,
    };

    return {
      baseStep: formatDecimal(
        parsedStep.coefficient,
        parsedStep.scale,
        parsedStep.scale
      ),
      bucket,
      bucketStep: formatDecimal(
        bucket.coefficient,
        bucket.scale,
        parsedStep.scale
      ),
      minimumPriceScale: parsedStep.scale,
      scale: normalizedScale,
    };
  }

  function resolveBucketPrice(price, definition) {
    const parsedPrice = parseDecimal(price, "行情价格");
    if (parsedPrice.coefficient <= 0n) {
      throw new RangeError("行情价格必须大于 0。");
    }

    const commonScale = Math.max(parsedPrice.scale, definition.bucket.scale);
    const priceInteger = scaleCoefficient(parsedPrice, commonScale);
    const bucketInteger = scaleCoefficient(definition.bucket, commonScale);
    let bucketIndex = priceInteger / bucketInteger;
    if (priceInteger % bucketInteger !== 0n) bucketIndex += 1n;

    return formatDecimal(
      bucketIndex * bucketInteger,
      commonScale,
      definition.minimumPriceScale
    );
  }

  function addQuantity(current, quantity) {
    const parsedQuantity = parseDecimal(quantity, "行情手数");
    if (parsedQuantity.coefficient < 0n) {
      throw new RangeError("行情手数不能小于 0。");
    }
    if (!current) return parsedQuantity;

    const commonScale = Math.max(current.scale, parsedQuantity.scale);
    return {
      coefficient:
        scaleCoefficient(current, commonScale) +
        scaleCoefficient(parsedQuantity, commonScale),
      scale: commonScale,
    };
  }

  function aggregateSide(levels, definition, direction, sideName) {
    if (!Array.isArray(levels)) {
      throw new TypeError(`${sideName}行情必须是数组。`);
    }

    const buckets = new Map();
    levels.forEach((level, index) => {
      if (!level || typeof level !== "object" || Array.isArray(level)) {
        throw new TypeError(`${sideName}行情第 ${index + 1} 档必须是对象。`);
      }

      const price = resolveBucketPrice(level.price, definition);
      buckets.set(price, addQuantity(buckets.get(price), level.quantity));
    });

    return Array.from(buckets, ([price, quantity]) => ({
      price,
      quantity: formatDecimal(quantity.coefficient, quantity.scale),
    })).sort((left, right) => direction * compareDecimals(left.price, right.price));
  }

  function bucketPrice(price, {
    baseStep = "0.01",
    scale = 1,
  } = {}) {
    return resolveBucketPrice(
      price,
      createBucketDefinition(baseStep, scale)
    );
  }

  /**
   * Aggregate the currently received bid/ask levels into exact decimal buckets.
   * Price buckets use (previousBoundary, boundary], so an exact boundary remains
   * in that bucket while any amount above it advances to the next boundary.
   */
  function aggregateDepth({
    bids = [],
    asks = [],
    baseStep = "0.01",
    scale = 1,
  } = {}) {
    const definition = createBucketDefinition(baseStep, scale);
    return {
      bids: aggregateSide(bids, definition, -1, "买盘"),
      asks: aggregateSide(asks, definition, 1, "卖盘"),
      baseStep: definition.baseStep,
      scale: definition.scale,
      bucketStep: definition.bucketStep,
    };
  }

  return {
    VALID_SCALES,
    aggregateDepth,
    bucketPrice,
  };
});
