function resolveDefaultTestnet(environment = {}) {
  return String(environment.BINANCE_TESTNET || "")
    .trim()
    .toLowerCase() === "true";
}

module.exports = { resolveDefaultTestnet };
