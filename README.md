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
- 普通订单优先复用 User Data Stream 所在的 WebSocket API 持久连接，通过 `order.place` 报单；连接不可用时回退到 HTTPS Keep-Alive。
- 报单和撤单只在收到 Binance 成功响应或 `executionReport` 后更新行情图，不使用本地乐观状态；确认后立即重绘。
- 所有请求在“执行结果与错误”展示毫秒级耗时。

## 配置

复制模板并填写当前环境的 API Key 和 Secret：

```bash
cp .env.example .env
```

```dotenv
BINANCE_TESTNET=true
BINANCE_TESTNET_API_KEY=你的_Testnet_API_Key
BINANCE_TESTNET_API_SECRET=你的_Testnet_API_Secret
BINANCE_PRODUCTION_API_KEY=你的_正式环境_API_Key
BINANCE_PRODUCTION_API_SECRET=你的_正式环境_API_Secret
BINANCE_PREFLIGHT_BALANCE_CHECK=false
```

`BINANCE_TESTNET` 决定程序启动时的默认环境。页面最上方的“环境切换”开关可以在当前运行期间切换 Testnet 和正式环境：程序会关闭旧环境的 REST Keep-Alive、行情 WebSocket、账户事件和交易 WebSocket 连接，清空页面中的旧环境状态，再使用目标环境重连当前交易对。切换到正式环境前会弹出确认提示。

Testnet 和正式环境的 API Key 不通用，因此推荐分别配置 `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET` 与 `BINANCE_PRODUCTION_API_KEY` / `BINANCE_PRODUCTION_API_SECRET`。为兼容旧版，`BINANCE_API_KEY` 和 `BINANCE_API_SECRET` 仍可使用，但只会应用于 `BINANCE_TESTNET` 指定的启动默认环境，防止密钥被误发到另一个环境。未配置目标环境密钥时仍能查看公开行情，但不能查询私有账户、下单或撤单。

所有连接直接使用系统网络，因此 WireGuard 必须在操作系统层面处于可用状态。页面切换只在当前程序运行期间生效；重新启动后仍以 `BINANCE_TESTNET` 的值作为默认环境。

低延迟模式默认关闭逐笔余额预查，余额和动态价格过滤器仍由 Binance 撮合引擎在接单时校验。服务器时间在后台刷新，静态交易规则在连接行情时预热。若更看重提交前的中文余额提示，可将 `BINANCE_PREFLIGHT_BALANCE_CHECK` 设为 `true`，代价是每笔报单多一次账户查询。

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
