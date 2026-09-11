# Electron Binance U 本位永续交易台

本工程通过 Electron 主进程连接 Binance USDⓈ-M Futures。程序不再创建、查询或交易现货客户端，API Secret 不会暴露给渲染页面。网络代理由操作系统的 WireGuard 路由负责，工程不包含代理配置。

代码模块职责和修改边界见 [架构说明](docs/ARCHITECTURE.md)。运行时代码同时支持 macOS 和 Windows。

## 已实现功能

- 启动时登录新期管理端，自动选择本机物理网卡 MAC；管理端返回多个 Binance 账号时先选择账号，再进入主窗口。
- 所选管理端账号的 API Key/Secret 仅保存在主进程内存，不下发页面、不写入本地配置。
- 从管理端读取 `BINANCE_FUTURES_LINK_ID`，在最底层生成带经纪商 Code 的 `newClientOrderId`。
- 页面顶部可切换 Binance Futures Testnet 与正式环境；行情、账户、订单和交易始终使用 U 本位接口。
- 使用唯一的全局合约输入框切换 U 本位永续合约。
- 行情使用 Binance 原生部分深度流，可在页面顶部切换 5/10/20 档，默认 `@depth20@100ms`；最新成交价使用独立逐笔成交流。
- 原行情下方提供只读“缩放行情”：按 1/5/10 级聚合当前已经收到的 5/10/20 档数据，不额外订阅更深行情；基础刻度为 `0.01`，区间采用左开右闭并归入上边界。
- 支持交易规则、最新价、最优买卖、平均价、24 小时行情、公开成交、聚合成交和 K 线查询。
- 支持 `LIMIT`、`MARKET`、`STOP`、`STOP_MARKET`、`TAKE_PROFIT`、`TAKE_PROFIT_MARKET` 和 `TRAILING_STOP_MARKET`；条件单使用 Binance Algo Order 接口，Post Only 使用 `timeInForce=GTX`。
- 支持按数量和按名义总价下单。按总价时程序按委托价、触发价或最新成交价换算数量，并按 `stepSize` 精确修正。
- 下单固定使用单向持仓模式；可选择开仓或 `reduceOnly` 平仓。
- 普通委托和撤单重报使用 `selfTradePreventionMode=EXPIRE_MAKER`，并校验 U 本位 `tradeGroupId`。
- 正式环境可为当前 U 本位子账号签署 TradFi-Perps 协议。
- 下单、撤单、改单、订单与账户查询优先使用交易 WebSocket API，失效后回退到 HTTPS Keep-Alive。
- 真实订单写入 WebSocket 后若响应丢失，不会通过 HTTP 盲目重报，避免重复委托。
- 支持单笔撤单、全部撤单、当前挂单、单笔订单、最近 24 小时全账户订单、成交历史、手续费率和下单限频。
- User Data Stream 实时维护普通订单、Algo 条件单、成交和账户状态；断线重连后自动执行最近 24 小时对账。
- 当前账号的 U 本位钱包余额、保证金余额、可用资金、初始保证金、持仓盈亏及近 24 小时收益流水由 Binance 获取，并每 2 秒同步到新期管理端。
- 成交事件通过 WebSocket 的已实现盈亏、手续费字段即时更新，完整收益历史每 5 分钟对账纠偏；接口短暂失败时保留最后一次有效数据。
- “当前持仓”只展示 `positionAmt != 0` 的 U 本位合约。连续两次取得完整零持仓快照且没有已知未成交订单后，才显示“已确认无持仓”。
- “一键平所有”先撤销全部 U 本位挂单，再用 `reduceOnly` 市价单平掉全部持仓，并向 Binance 连续复核结果。
- “交易回合”按 Binance 已确认的实际成交增量持久化，分别计算多、空方向的累计手数、成交总价和加权平均成交价。
- 快捷键支持下单、按总价下单、撤销全部未成交订单和一键平所有；配置保存为跨平台 JSON 文件。
- 多实例共享 Binance 请求权重和订单频率计数，接近上限时暂缓非关键查询，为下单和撤单预留容量。
- 支持 U 本位断线自动撤单 `/fapi/v1/countdownCancelAll`。
- 所有接口调用延迟统一显示在窗口底部。

## 配置

macOS 复制模板并填写 U 本位凭证：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

```dotenv
BINANCE_TESTNET=false
BINANCE_TESTNET_FUTURES_API_KEY=你的_Futures_Testnet_API_Key
BINANCE_TESTNET_FUTURES_API_SECRET=你的_Futures_Testnet_API_Secret
BINANCE_PRODUCTION_FUTURES_API_KEY=你的_Futures_正式环境_API_Key
BINANCE_PRODUCTION_FUTURES_API_SECRET=你的_Futures_正式环境_API_Secret
BINANCE_FUTURES_LINK_ID=tdk3UjFd
BINANCE_FUTURES_EXPECTED_TRADE_GROUP_ID=
BINANCE_PREFLIGHT_BALANCE_CHECK=false
BINANCE_DEPTH_SPEED=100ms
```

正常使用时，登录后所选管理端账号会覆盖本地 U 本位凭证，管理端系统配置会覆盖本地 Futures LinkID。Testnet 和正式环境凭证不通用。

低延迟模式默认关闭逐笔余额预查，余额和动态价格过滤器仍由 Binance 在接单时校验。若更看重提交前提示，可将 `BINANCE_PREFLIGHT_BALANCE_CHECK` 设为 `true`，代价是每笔报单增加一次账户查询。

所有连接直接使用系统网络。如果需要 WireGuard，应在操作系统层配置路由。

## 运行与测试

```bash
npm install
npm test
npm start
```

`npm start` 默认启用开发热更新并打开调试控制台。页面代码变化时刷新窗口，后台代码变化时重启 Electron。只启动一次可使用：

```bash
npm run start:once
```

正式环境 U 本位公共 REST 行情依次尝试 Electron 网络栈、Node HTTPS 和可选 curl 后备。Windows 不要求安装 curl。

## 打包

macOS Apple Silicon：

```bash
npm run build:mac
```

Windows x64：

```powershell
npm install
npm run build:win
```

Windows ARM64 使用 `npm run build:win:arm64`；同时生成两个架构使用 `npm run build:win:all`。构建不会把真实 `.env` 或 API Secret 打进安装包。

## 当前边界

- 只支持 Binance USDⓈ-M Futures，不支持现货、COIN-M、杠杆账户或现货组合订单。
- U 本位交易固定使用单向持仓模式。
- 最近 24 小时订单、交易回合、快捷键和跨实例限流快照保存在本地 JSON；没有长期数据库。
- 未实现 SOR、批量订单、FIX/SBE 等专业接口。
