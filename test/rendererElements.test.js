const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ELEMENT_SELECTORS,
  collect,
} = require("../src/rendererElements");

test("页面元素选择器集中注册并保持关键控件名称", () => {
  assert.equal(ELEMENT_SELECTORS.environmentSwitch, "#environmentSwitch");
  assert.equal(ELEMENT_SELECTORS.chartSymbolInput, "#chartSymbolInput");
  assert.equal(ELEMENT_SELECTORS.quantity, "#quantity");
  assert.equal(ELEMENT_SELECTORS.output, "#output");
  assert.ok(Object.keys(ELEMENT_SELECTORS).length > 100);
});

test("页面元素注册表一次性收集全部控件", () => {
  const calls = [];
  const fakeDocument = {
    querySelector(selector) {
      calls.push(selector);
      return { selector };
    },
  };

  const elements = collect(fakeDocument);
  assert.equal(calls.length, Object.keys(ELEMENT_SELECTORS).length);
  assert.deepEqual(elements.orderId, { selector: "#orderId" });
});

test("页面缺少必要控件时立即给出明确错误", () => {
  assert.throws(
    () => collect({ querySelector: () => null }),
    /页面缺少必要控件：.*environmentSwitch/
  );
});
