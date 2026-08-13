# Electron Binance Spot 交易测试台

本工程通过 Electron 主进程直接连接 Binance Spot，Secret 不会暴露给渲染页面。东京出口由操作系统的 WireGuard 路由负责，工程不包含代理配置。

## 已实现功能

- REST 连通性和服务器时间同步。
- `exchangeInfo` 交易规则与过滤器展示。
- 最新价、最优买卖、平均价、24 小时行情、最近成交、聚合成交和 K 线。
- REST 深度快照 + WebSocket 增量维护本地订单簿。
- `LIMIT`、`MARKET`、`LIMIT_MAKER`、止盈止损类普通订单。
- `/api/v3/order/test` 测试下单（只校验，不进入撮合引擎）。
- 下单前按 `PRICE_FILTER`、`LOT_SIZE`、`MIN_NOTIONAL/NOTIONAL`、`PERCENT_PRICE(_BY_SIDE)` 校验，并按 tickSize/stepSize 修正精度。
- 单笔撤单、全部撤单、当前挂单、单笔订单、全部订单、减量改单、撤单重报。
- 账户信息、成交历史、手续费率和下单限频。
- OCO、OTO、OTOCO 创建；组合订单历史、当前组合挂单、单笔查询和撤销。
- User Data Stream 实时接收订单、成交、余额和组合订单事件，断线自动重连。
- 所有请求在“执行结果与错误”展示毫秒级耗时。

## 配置

复制模板并填写当前环境的 API Key 和 Secret：

```bash
cp .env.example .env
```

```dotenv
BINANCE_TESTNET=true
BINANCE_API_KEY=你的当前环境_API_Key
BINANCE_API_SECRET=你的当前环境_API_Secret
```

`BINANCE_TESTNET=true` 时，REST、行情流、WebSocket API、下单和账户查询均连接 Spot Testnet；设置为 `false` 时全部连接正式环境。所有连接直接使用系统网络，因此 WireGuard 必须在操作系统层面处于可用状态。

Testnet 和正式环境的 API Key 不通用。切换环境时必须同步更换 Key/Secret。

## 运行与测试

```bash
npm install
npm test
npm start
```

建议先点击“测试连通性”和“刷新交易规则”，再使用“仅测试参数”验证委托。`/api/v3/order/test` 成功不会生成订单，因此不会出现在订单历史和当前挂单中。

“提交真实委托”、组合订单以及撤单操作即使在 Testnet 也会改变测试账户状态；正式环境则会涉及真实资产。正式环境使用前请为 API Key 设置 IP 白名单，只开放读取和现货交易权限，禁止提现权限。

## 当前边界

- 仅覆盖 Binance Spot；不包含 U 本位/币本位合约和杠杆账户。
- 没有数据库持久化、跨进程审计日志和多账户管理。
- 未实现 SOR、OPO/OPOCO、批量订单、FIX/SBE 等专业接口。
- 页面提供 OCO/OTO/OTOCO 常用参数组合；更复杂的追踪止损、冰山及挂钩价格参数仍需扩展表单。
