(function createTablePaginationModule(globalObject, factory) {
  const api = factory(globalObject);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (globalObject) {
    globalObject.TablePagination = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function tablePaginationFactory(globalObject) {
  const PAGE_SIZE = 10;

  function normalizeInteger(value, fallback, minimum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.floor(number));
  }

  function getPaginationModel(totalItems, requestedPage = 1, pageSize = PAGE_SIZE) {
    const total = normalizeInteger(totalItems, 0, 0);
    const size = normalizeInteger(pageSize, PAGE_SIZE, 1);
    const totalPages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(
      totalPages,
      normalizeInteger(requestedPage, 1, 1)
    );
    const startIndex = total === 0 ? 0 : (page - 1) * size;
    const endIndex = Math.min(total, startIndex + size);

    return {
      totalItems: total,
      pageSize: size,
      currentPage: page,
      totalPages,
      startIndex,
      endIndex,
    };
  }

  function isPlaceholderRows(rows) {
    return (
      rows.length === 1 &&
      rows[0].cells.length === 1 &&
      rows[0].cells[0].hasAttribute("colspan")
    );
  }

  function createButton(documentObject, text, label) {
    const button = documentObject.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    return button;
  }

  function initializeCollection(
    owner,
    {
      itemsElement = owner,
      getItems = () => Array.from(itemsElement.children),
      hasPlaceholderOnly = () => false,
      insertionTarget = owner,
      pageSize = PAGE_SIZE,
    } = {}
  ) {
    if (!owner || owner.dataset.listPaginationInitialized === "true") {
      return owner?.listPaginationController || null;
    }

    const documentObject = owner.ownerDocument;
    if (!itemsElement || !documentObject || !insertionTarget) return null;

    const pager = documentObject.createElement("nav");
    pager.className = "table-pagination";
    pager.setAttribute("aria-label", "列表分页");

    const firstButton = createButton(documentObject, "首页", "前往第一页");
    const previousButton = createButton(documentObject, "上一页", "前往上一页");
    const pageSelect = documentObject.createElement("select");
    pageSelect.setAttribute("aria-label", "选择页码");
    const nextButton = createButton(documentObject, "下一页", "前往下一页");
    const lastButton = createButton(documentObject, "末页", "前往最后一页");
    const status = documentObject.createElement("span");
    status.className = "table-pagination-status";
    status.setAttribute("aria-live", "polite");

    pager.append(
      firstButton,
      previousButton,
      pageSelect,
      nextButton,
      lastButton,
      status
    );

    insertionTarget.insertAdjacentElement("afterend", pager);

    let requestedPage = 1;
    let lastTotalPages = 0;
    let refreshQueued = false;

    function rebuildPageOptions(totalPages) {
      if (totalPages === lastTotalPages) return;
      pageSelect.replaceChildren();
      for (let page = 1; page <= totalPages; page += 1) {
        const option = documentObject.createElement("option");
        option.value = String(page);
        option.textContent = `第 ${page} 页`;
        pageSelect.append(option);
      }
      lastTotalPages = totalPages;
    }

    function refresh() {
      refreshQueued = false;
      const items = getItems();
      const placeholderOnly = hasPlaceholderOnly(items);
      const dataItems = placeholderOnly ? [] : items;
      const model = getPaginationModel(dataItems.length, requestedPage, pageSize);
      requestedPage = model.currentPage;

      if (placeholderOnly) {
        items[0].hidden = false;
      } else {
        items.forEach((item, index) => {
          item.hidden =
            index < model.startIndex || index >= model.endIndex;
        });
      }

      rebuildPageOptions(model.totalPages);
      pageSelect.value = String(model.currentPage);
      firstButton.disabled = model.currentPage <= 1;
      previousButton.disabled = model.currentPage <= 1;
      nextButton.disabled = model.currentPage >= model.totalPages;
      lastButton.disabled = model.currentPage >= model.totalPages;
      status.textContent = `第 ${model.currentPage}/${model.totalPages} 页 · 共 ${model.totalItems} 条`;
      return model;
    }

    function scheduleRefresh() {
      if (refreshQueued) return;
      refreshQueued = true;
      const schedule =
        documentObject.defaultView?.queueMicrotask ||
        globalObject?.queueMicrotask ||
        ((callback) => Promise.resolve().then(callback));
      schedule(refresh);
    }

    function goToPage(page) {
      requestedPage = normalizeInteger(page, requestedPage, 1);
      return refresh();
    }

    firstButton.addEventListener("click", () => goToPage(1));
    previousButton.addEventListener("click", () => goToPage(requestedPage - 1));
    pageSelect.addEventListener("change", () => goToPage(pageSelect.value));
    nextButton.addEventListener("click", () => goToPage(requestedPage + 1));
    lastButton.addEventListener("click", () => goToPage(lastTotalPages));

    const MutationObserverClass =
      documentObject.defaultView?.MutationObserver || globalObject?.MutationObserver;
    const observer = MutationObserverClass
      ? new MutationObserverClass(scheduleRefresh)
      : null;
    observer?.observe(itemsElement, { childList: true });

    const controller = {
      refresh,
      goToPage,
      getState: () => {
        const items = getItems();
        return getPaginationModel(
          hasPlaceholderOnly(items) ? 0 : items.length,
          requestedPage,
          pageSize
        );
      },
      destroy() {
        observer?.disconnect();
        pager.remove();
        getItems().forEach((item) => {
          item.hidden = false;
        });
        delete owner.listPaginationController;
        delete owner.dataset.listPaginationInitialized;
      },
    };

    owner.dataset.listPaginationInitialized = "true";
    owner.listPaginationController = controller;
    refresh();
    return controller;
  }

  function initializeTable(table, { pageSize = PAGE_SIZE } = {}) {
    const tbody = table?.tBodies?.[0];
    if (!tbody) return null;
    return initializeCollection(table, {
      itemsElement: tbody,
      getItems: () => Array.from(tbody.rows),
      hasPlaceholderOnly: isPlaceholderRows,
      insertionTarget: table.closest(".table-scroll") || table,
      pageSize,
    });
  }

  function initializeList(container, { pageSize = PAGE_SIZE } = {}) {
    return initializeCollection(container, { pageSize });
  }

  function initializeAll(root = globalObject?.document) {
    if (!root?.querySelectorAll) return [];
    return [
      ...Array.from(root.querySelectorAll("table"), (table) =>
        initializeTable(table)
      ),
      ...Array.from(root.querySelectorAll("[data-paginated-list]"), (container) =>
        initializeList(container)
      ),
    ].filter(Boolean);
  }

  if (globalObject?.document) {
    if (globalObject.document.readyState === "loading") {
      globalObject.document.addEventListener(
        "DOMContentLoaded",
        () => initializeAll(globalObject.document),
        { once: true }
      );
    } else {
      initializeAll(globalObject.document);
    }
  }

  return {
    PAGE_SIZE,
    getPaginationModel,
    initializeAll,
    initializeList,
    initializeTable,
  };
});
