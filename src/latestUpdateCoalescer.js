function createLatestUpdateCoalescer({
  intervalMs = 32,
  send,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (typeof send !== "function") {
    throw new TypeError("send 必须是函数。");
  }

  let latestValue;
  let timer = null;

  const flush = () => {
    timer = null;
    if (latestValue === undefined) return;
    const value = latestValue;
    latestValue = undefined;
    send(value);
  };

  return {
    push(value) {
      latestValue = value;
      if (timer !== null) return;
      timer = schedule(flush, intervalMs);
      timer?.unref?.();
    },
    flush,
    close() {
      if (timer !== null) cancel(timer);
      timer = null;
      latestValue = undefined;
    },
  };
}

module.exports = {
  createLatestUpdateCoalescer,
};
