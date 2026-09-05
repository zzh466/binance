const DECIMAL_PATTERN =
  /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i;

function pow10(exponent) {
  return 10n ** BigInt(exponent);
}

function parseDecimal(value, name = "数值") {
  const text = String(value ?? "").trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new TypeError(`${name} 不是有效的十进制数：${text || "空值"}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] || "0";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] || 0);
  let coefficient = sign * BigInt(`${whole}${fraction}` || "0");
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= pow10(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function scaleCoefficient(decimal, scale) {
  return decimal.coefficient * pow10(scale - decimal.scale);
}

function formatScaled(coefficient, scale, minimumScale = 0) {
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    let fraction = digits.slice(-scale);
    const whole = digits.slice(0, -scale);
    while (fraction.length > minimumScale && fraction.endsWith("0")) {
      fraction = fraction.slice(0, -1);
    }
    digits = fraction ? `${whole}.${fraction}` : whole;
  }
  return `${negative ? "-" : ""}${digits}`;
}

function compareDecimal(left, right) {
  const parsedLeft = parseDecimal(left);
  const parsedRight = parseDecimal(right);
  const scale = Math.max(parsedLeft.scale, parsedRight.scale);
  const leftValue = scaleCoefficient(parsedLeft, scale);
  const rightValue = scaleCoefficient(parsedRight, scale);
  return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
}

function addDecimal(left, right) {
  const parsedLeft = parseDecimal(left);
  const parsedRight = parseDecimal(right);
  const scale = Math.max(parsedLeft.scale, parsedRight.scale);
  return formatScaled(
    scaleCoefficient(parsedLeft, scale) + scaleCoefficient(parsedRight, scale),
    scale
  );
}

function subtractDecimal(left, right) {
  const parsedLeft = parseDecimal(left);
  const parsedRight = parseDecimal(right);
  const scale = Math.max(parsedLeft.scale, parsedRight.scale);
  return formatScaled(
    scaleCoefficient(parsedLeft, scale) - scaleCoefficient(parsedRight, scale),
    scale
  );
}

function isPositiveDecimal(value) {
  try {
    return parseDecimal(value).coefficient > 0n;
  } catch {
    return false;
  }
}

function alignDecimalToStep(value, step, mode = "floor", origin = "0") {
  const parsedValue = parseDecimal(value, "待对齐数值");
  const parsedStep = parseDecimal(step, "步长");
  const parsedOrigin = parseDecimal(origin, "步长起点");
  if (parsedStep.coefficient <= 0n) return String(value);

  const scale = Math.max(
    parsedValue.scale,
    parsedStep.scale,
    parsedOrigin.scale
  );
  const valueInteger = scaleCoefficient(parsedValue, scale);
  const stepInteger = scaleCoefficient(parsedStep, scale);
  const originInteger = scaleCoefficient(parsedOrigin, scale);
  const delta = valueInteger - originInteger;
  if (delta < 0n) return formatScaled(valueInteger, scale, parsedStep.scale);

  let steps = delta / stepInteger;
  if (mode === "ceil" && delta % stepInteger !== 0n) steps += 1n;
  const aligned = originInteger + steps * stepInteger;
  return formatScaled(aligned, scale, parsedStep.scale);
}

function multiplyDecimal(left, right) {
  const parsedLeft = parseDecimal(left);
  const parsedRight = parseDecimal(right);
  return formatScaled(
    parsedLeft.coefficient * parsedRight.coefficient,
    parsedLeft.scale + parsedRight.scale
  );
}

function divideDecimalToStep(total, price, step, origin = "0") {
  const parsedTotal = parseDecimal(total, "订单总价");
  const parsedPrice = parseDecimal(price, "参考价格");
  const parsedStep = parseDecimal(step, "数量步长");
  const parsedOrigin = parseDecimal(origin, "数量起点");
  if (
    parsedTotal.coefficient <= 0n ||
    parsedPrice.coefficient <= 0n ||
    parsedStep.coefficient <= 0n
  ) {
    throw new TypeError("订单总价、参考价格和数量步长必须大于 0。");
  }

  // rawQuantity = total / price；直接计算可容纳的完整 step 数，避免先转
  // IEEE-754 浮点后在 tickSize/stepSize 边界产生少一档或多一档。
  const rawNumerator = parsedTotal.coefficient * pow10(parsedPrice.scale);
  const rawDenominator = pow10(parsedTotal.scale) * parsedPrice.coefficient;
  const deltaNumerator =
    rawNumerator * pow10(parsedOrigin.scale) -
    parsedOrigin.coefficient * rawDenominator;
  if (deltaNumerator < 0n) {
    throw new TypeError("按总价换算后的数量小于数量起点。");
  }
  const stepCount =
    (deltaNumerator * pow10(parsedStep.scale)) /
    (rawDenominator * parsedStep.coefficient);
  const outputScale = Math.max(parsedOrigin.scale, parsedStep.scale);
  const outputInteger =
    scaleCoefficient(parsedOrigin, outputScale) +
    stepCount * scaleCoefficient(parsedStep, outputScale);
  return formatScaled(outputInteger, outputScale, parsedStep.scale);
}

module.exports = {
  addDecimal,
  alignDecimalToStep,
  compareDecimal,
  divideDecimalToStep,
  formatScaled,
  isPositiveDecimal,
  multiplyDecimal,
  parseDecimal,
  subtractDecimal,
};
