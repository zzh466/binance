const assert = require("node:assert/strict");
const test = require("node:test");
const {
  addDecimal,
  alignDecimalToStep,
  compareDecimal,
  divideDecimalToStep,
  multiplyDecimal,
  parseDecimal,
  subtractDecimal,
} = require("../src/binance/decimalMath");

test("价格和数量按 Binance 步长进行精确十进制对齐", () => {
  assert.equal(alignDecimalToStep("50000.19", "0.10"), "50000.10");
  assert.equal(alignDecimalToStep("0.000000019", "0.00000001"), "0.00000001");
  assert.equal(alignDecimalToStep("1.2e-7", "0.00000001"), "0.00000012");
  assert.equal(alignDecimalToStep(".0019", ".001"), "0.001");
});

test("按总价换算直接落到数量 stepSize 而不经过浮点数", () => {
  assert.equal(divideDecimalToStep("100", "333.3", "0.001"), "0.300");
  assert.equal(divideDecimalToStep("0.00000003", "0.1", "0.00000001"), "0.00000030");
});

test("名义金额乘法和边界比较保持十进制精度", () => {
  assert.equal(addDecimal("0.1", "0.2"), "0.3");
  assert.equal(subtractDecimal("15", "10"), "5");
  assert.equal(multiplyDecimal("333.3", "0.300"), "99.99");
  assert.equal(compareDecimal("0.100000000000000001", "0.1"), 1);
  assert.deepEqual(parseDecimal("1e3"), { coefficient: 1000n, scale: 0 });
});
