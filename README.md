# Electron Binance Spot 后台示例

这是一个最小可运行项目：

- Electron 主进程保存 API Key/Secret。
- Binance Spot WebSocket 接收 `bookTicker` 最优买卖价。
- Binance Spot REST API 执行限价/市价下单。
- Binance Spot REST API 按 `orderId` 撤单。
- 渲染进程只通过白名单 IPC 调用主进程。
- 默认启用 Spot Testnet。

## 1. 安装

```bash
npm install
```

## 2. 配置 Testnet 密钥

复制环境变量模板：

### macOS / Linux

```bash
cp .env.example .env
```

### Windows PowerShell

```powershell
Copy-Item .env.example .env
```

编辑 `.env`：

```dotenv
BINANCE_TESTNET=true
BINANCE_SOCKS5_PROXY=socks5h://139.224.34.110:1080
BINANCE_API_KEY=你的_Testnet_API_Key
BINANCE_API_SECRET=你的_Testnet_API_Secret
```

程序中的 Binance REST 请求（时间同步、深度快照、下单、撤单）和 WebSocket 行情连接都会使用同一个 SOCKS5 隧道。`socks5h` 会让域名由代理端解析；如果你的隧道地址不同，只需修改 `BINANCE_SOCKS5_PROXY`。

如果你的隧道只允许访问你给出的正式环境地址（`stream.binance.com`），请将 `BINANCE_TESTNET=false`；保持 `true` 时会访问 `testnet.binance.vision`，两套环境的连通性是分开的。

行情订阅不需要密钥；下单和撤单需要密钥。

## 3. 启动

```bash
npm start
```

## 4. 建议验证顺序

1. 启动后确认环境显示 `Spot Testnet`。
2. 连接 `BTCUSDT` 行情，确认 Bid/Ask 持续变化。
3. 使用明显偏离市场的 LIMIT 价格下一个小数量挂单。
4. 记录返回的 `orderId`。
5. 使用同一交易对和 `orderId` 撤单。
6. 确认撤单响应状态正常。

## 5. 切换正式环境

把 `.env` 改为：

```dotenv
BINANCE_TESTNET=false
```

正式环境执行真实资金交易。切换前至少补充：

- 交易对过滤器校验，包括 `PRICE_FILTER`、`LOT_SIZE`、`MIN_NOTIONAL/NOTIONAL`。
- User Data Stream，用于确认成交、拒单、撤单和部分成交。
- 订单状态查询与超时后的幂等恢复。
- 限频、重试、熔断和审计日志。
- 操作系统密钥链或独立交易后端，不要把真实 Secret 明文打进安装包。
- API Key 限制交易权限并配置 IP 白名单，禁止提现权限。

## 6. 当前边界

示例仅实现 Spot 的 `LIMIT` 和 `MARKET`，没有实现：

- U 本位/币本位合约。
- 杠杆、止盈止损、OCO。
- 深度增量本地订单簿。
- 用户数据流和成交回报。
- 自动读取交易规则并修正价格、数量精度。
- 数据落库与断线补偿。
