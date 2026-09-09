(function exposeChartOrderSelection(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ChartOrderSelection = api;
  }
})(typeof window !== "undefined" ? window : globalThis, () => {
  function finiteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function resolveChartOrderSelection({
    clientX,
    clientY,
    bounds,
    canvasWidth,
    canvasHeight,
    plotLeft,
    plotTop,
    plotBottom,
    barWidth,
    count,
    start,
    buyIndex,
    askIndex,
    data,
  } = {}) {
    const width = finiteNumber(bounds?.width);
    const height = finiteNumber(bounds?.height);
    const left = finiteNumber(bounds?.left);
    const top = finiteNumber(bounds?.top);
    const internalWidth = finiteNumber(canvasWidth);
    const internalHeight = finiteNumber(canvasHeight);
    const barSize = finiteNumber(barWidth);
    const visibleCount = Math.floor(finiteNumber(count) ?? -1);
    const firstDataIndex = Math.floor(finiteNumber(start) ?? -1);
    const bidIndex = finiteNumber(buyIndex);
    const offerIndex = finiteNumber(askIndex);

    if (
      !(width > 0) || !(height > 0) || !(internalWidth > 0) ||
      !(internalHeight > 0) || !(barSize > 0) || visibleCount < 0 ||
      firstDataIndex < 0 || bidIndex === null || offerIndex === null ||
      left === null || top === null || !Array.isArray(data)
    ) {
      return null;
    }

    const scaleX = internalWidth / width;
    const scaleY = internalHeight / height;
    const canvasX = (Number(clientX) - left) * scaleX;
    const canvasY = (Number(clientY) - top) * scaleY;
    const activeLeft = finiteNumber(plotLeft) ?? 0;
    const activeTop = finiteNumber(plotTop) ?? 0;
    const activeBottom = finiteNumber(plotBottom) ?? internalHeight;
    const activeRight = Math.min(
      internalWidth,
      activeLeft + (visibleCount + 1) * barSize
    );

    if (
      !Number.isFinite(canvasX) || !Number.isFinite(canvasY) ||
      canvasX < activeLeft || canvasX >= activeRight ||
      canvasY < activeTop || canvasY > activeBottom
    ) {
      return null;
    }

    const visibleIndex = Math.floor((canvasX - activeLeft) / barSize);
    const dataIndex = firstDataIndex + visibleIndex;
    const price = data[dataIndex]?.price;
    if (price === undefined || price === null || !(Number(price) > 0)) return null;

    let side = null;
    if (dataIndex <= bidIndex) side = "BUY";
    if (dataIndex >= offerIndex) side = "SELL";
    if (!side) return null;

    return {
      side,
      price: String(price),
      dataIndex,
      canvasX,
      canvasY,
      cssLeft: (activeLeft + visibleIndex * barSize) / scaleX,
      cssBarWidth: barSize / scaleX,
    };
  }

  return { resolveChartOrderSelection };
});
