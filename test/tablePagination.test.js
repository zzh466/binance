const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PAGE_SIZE,
  getPaginationModel,
} = require("../src/tablePagination");

test("所有列表固定每页展示十行", () => {
  assert.equal(PAGE_SIZE, 10);
  assert.deepEqual(getPaginationModel(0, 1), {
    totalItems: 0,
    pageSize: 10,
    currentPage: 1,
    totalPages: 1,
    startIndex: 0,
    endIndex: 0,
  });
  assert.equal(getPaginationModel(10, 1).totalPages, 1);
  assert.equal(getPaginationModel(11, 1).totalPages, 2);
});

test("分页范围每页最多十行并自动修正越界页码", () => {
  const middlePage = getPaginationModel(25, 2);
  assert.equal(middlePage.startIndex, 10);
  assert.equal(middlePage.endIndex, 20);
  assert.equal(middlePage.endIndex - middlePage.startIndex, 10);

  const lastPage = getPaginationModel(25, 99);
  assert.equal(lastPage.currentPage, 3);
  assert.equal(lastPage.startIndex, 20);
  assert.equal(lastPage.endIndex, 25);
});

test("登录账号选择列表也接入统一的十条分页控件", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "login.html"),
    "utf8"
  );
  assert.match(html, /id="accountList"[^>]*data-paginated-list/);
  assert.equal(
    html.indexOf('src="tablePagination.js"') <
      html.indexOf('src="loginRenderer.js"'),
    true
  );
});
