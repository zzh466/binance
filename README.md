# Electron Binance 统一交易测试台

本工程通过 Electron 主进程连接 Binance Spot 与 USDⓈ-M Futures，Secret 不会暴露给渲染页面。东京出口由操作系统的 WireGuard 路由负责，工程不包含代理配置。

## 已实现功能

- 启动时先登录新期管理端，客户端版本固定为 `990812b`；登录请求自动选择本机网卡 MAC，Windows 优先“以太网/以太网 2”，macOS 优先 `en0/en1` 并避开 WireGuard 等虚拟网卡。
- 管理端只返回一个 Binance 账号时直接进入主窗口；返回多个账号时只向选择窗口展示 `futureUserName`，用户确认后才创建 Binance 客户端。API Key/Secret 只保存在主进程内存，不下发页面、不写入本地配置。
- 登录成功后立即调用管理端 `/user/info`，并按 `futureInvestorId`（兼容 `/user/info` 的 `futureUserID` 字段名）与登录结果合并账号。管理端负责账号 `id`、名称、API Key/Secret、状态和交易配置；资金数值不采用管理端缓存。合并后的账号用于账号选择和运行时凭证，但页面不会接收密钥或授权码。
- 现货和 U 本位 LinkID 从管理端系统配置 `BINANCE_SPOT_LINK_ID`、`BINANCE_FUTURES_LINK_ID` 动态读取。
- 当前账号的动态交易指标全部以 Binance 为数据源：静态权益为现货资产 USDT 估值加 U 本位钱包余额，动态权益为现货资产 USDT 估值加 U 本位保证金余额，可用资金来自两类市场的可用余额，占用保证金由现货锁定资产估值和 U 本位初始保证金组成，持仓盈亏由现货成本账本与 U 本位未实现盈亏组成。近 24 小时平仓盈亏、实际盈亏和已支付手续费来自现货成交与 U 本位收益流水；U 本位实际盈亏包含已实现盈亏、手续费和资金费。
- 登录后每 2 秒执行一次轻量 Binance 账户快照，并通过管理端 `PATCH /future/futureAccountTradingInfo` 回写当前账号的 `id`、静态权益、动态权益、可用资金、保证金、持仓盈亏、平仓盈亏、实际盈亏、手续费、开仓量和报单量。开仓量按当前持仓品种数、报单量按 Binance 已确认的未完成订单数统计，避免把不同币种的小数数量直接相加。同步请求复用登录 Cookie、禁止并发重叠，失败时保留本地交易功能并在下一周期重试；成交/收益历史按 30 秒周期及账户事件对账。
- 现货持仓盈亏使用持久化的平均成本账本，只由真实成交更新，撤单不产生盈亏。首次跟踪时按当时市价把已有持仓设为成本基线；现货实际盈亏和手续费另行从 Binance `myTrades` 重建最近 24 小时的成交，程序启动前已经完整闭合的买卖也会纳入。对于窗口开始前已经持有、窗口内只有卖出而查不到原始成本的部分，程序会标记为不完整卖出且不会臆造盈利。
- REST 连通性和服务器时间同步。
- 根据唯一的“全局合约”自动识别 Spot / USDⓈ-M，并将行情、普通下单、撤单和查询路由到对应市场；只存在于 Futures 的 `SKHYUSDT` 无需手动选择市场。
- `exchangeInfo` 交易规则与过滤器展示。
- 最新价、最优买卖、平均价、24 小时行情、最近成交、聚合成交和 K 线。
- 行情深度使用 Binance 原生 `@depth10@100ms` 十档部分深度流，不再维护默认 1000 档订单簿；最新成交价使用独立逐笔成交流更新。
- `LIMIT`、`MARKET`、`LIMIT_MAKER`、止盈止损类普通订单。
- 普通下单可选择“按数量”或“按总价”：现货 `MARKET` 直接发送 `quoteOrderQty`；现货其他类型和 USDⓈ-M 按委托价、触发价或最新成交价换算并按 `stepSize` 修正数量。USDⓈ-M 总价表示名义价值，不是保证金金额。
- 所有普通委托、撤单重报和 Spot OCO/OTO/OTOCO 固定携带 `selfTradePreventionMode=EXPIRE_MAKER`。账户信息会显示当前市场账户接口返回的 `tradeGroupId`：跨子账号现货 STP 只有在各账号属于相同且非 `-1` 的交易组时生效。USDⓈ-M 官方只保证该模式在 `IOC/GTC/GTD` 下有效，因此 `MARKET` 和映射为 `GTX` 的 `LIMIT_MAKER` 不应被视为具有同等保护。
- 正式环境支持为当前 U 本位 API Key 所属子账号签署 TradFi-Perps 协议；可在“账户信息”中主动签署，下单收到 `Please sign TradFi-Perps agreement contract fapi` 时也会弹出二次确认并在签署成功后重试原委托。协议不会在程序启动时静默签署，Testnet 不调用该正式环境接口。
- `/api/v3/order/test` 测试下单（只校验，不进入撮合引擎）。
- 下单前按 `PRICE_FILTER`、`LOT_SIZE`、`MIN_NOTIONAL/NOTIONAL`、`PERCENT_PRICE(_BY_SIDE)` 校验，并使用十进制定点运算按 tickSize/stepSize 修正精度，避免 JavaScript 浮点误差改变价格、数量或名义价值。
- 单笔撤单、全部撤单、当前挂单、单笔订单、全部订单、减量改单、撤单重报。
- 账户信息、成交历史、手续费率和下单限频。
- OCO、OTO、OTOCO 创建；组合订单历史、当前组合挂单、单笔查询和撤销。
- Spot 与 USDⓈ-M User Data Stream 实时接收订单、成交和账户事件，永续普通订单、Algo 条件单及轻量成交事件会转换为页面统一使用的订单状态；断线重连后自动执行最近 24 小时全账户快照对账，补齐断线期间的事件。
- 当前账户最近 24 小时订单统一保存在本地状态库：U 本位补齐普通订单及 Algo 条件单，现货从全市场挂单发现合约，再并发补查本地已知合约的历史订单；查询达到单次上限时按时间区间继续拆分，避免静默截断。
- “交易回合”按实际成交增量持久化：开多与平空计入多向，开空与平多计入空向；同一合约两向成交量相等时结束当前回合，反向超出的成交量自动进入下一回合。多、空方向分别累计成交总价，并以成交总价除以成交总手数实时计算加权平均成交价。部分成交按累计成交量和累计成交额差值记账，重复 WebSocket 事件、手动刷新和程序重启不会重复累计。旧版回合缺少成交金额时会按保存的订单 ID 查询 Binance 回填；跨回合订单优先使用逐笔成交明细，避免把整张订单的均价误套到不同回合。
- U 本位止损、止盈和追踪止损使用 Binance Algo Order 接口，页面查询与撤单会自动识别普通订单或 Algo Order。
- Spot 与 USDⓈ-M 分别维护独立的交易 WebSocket API 持久连接；官方支持的下单、撤单、改单、订单及账户查询优先走 WebSocket，连接不可用时自动回退到 HTTPS Keep-Alive，并在后台指数退避重连。若真实下单已经写入 WebSocket 但响应丢失，程序不会用 HTTP 盲目重报，以避免重复委托，而是返回 `UNKNOWN` 提醒查询订单状态。
- 报单和撤单只在收到 Binance 成功响应或 `executionReport` 后更新行情图，不使用本地乐观状态；确认后立即重绘。
- 页面顶部提供“系统 / 配置”菜单；“配置 → 快捷键”以列表维护按键、动作、方向、超价和手数，支持新增、编辑、删除与恢复默认。设置保存在系统应用数据目录的 `Binance统一交易台/shortcut-settings.json`（macOS 为 Application Support，Windows 为 AppData）。
- 行情图上方只保留一个“全局合约”输入框；行情、下单、撤单、订单与成交查询、手续费和组合订单等功能统一读取该合约，点击“切换行情”或按 Enter 可重连行情。
- 所有请求在“执行结果与错误”展示毫秒级耗时。
- 多开实例通过系统应用数据目录中的独立快照共享 Binance 请求权重和订单频率计数；接近上限时只暂缓非关键查询，为下单与撤单预留容量，收到 418/429 时按 `Retry-After` 统一暂停请求。
- U 本位可选“断线自动撤单”：程序周期续期 `/fapi/v1/countdownCancelAll`，网络或进程停止后由 Binance 在倒计时到期时撤销指定合约挂单。

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
BINANCE_TESTNET_FUTURES_API_KEY=你的_Futures_Testnet_API_Key
BINANCE_TESTNET_FUTURES_API_SECRET=你的_Futures_Testnet_API_Secret
BINANCE_PRODUCTION_FUTURES_API_KEY=你的_Futures_正式环境_API_Key
BINANCE_PRODUCTION_FUTURES_API_SECRET=你的_Futures_正式环境_API_Secret
BINANCE_PREFLIGHT_BALANCE_CHECK=false
BINANCE_SPOT_EXPECTED_TRADE_GROUP_ID=
BINANCE_FUTURES_EXPECTED_TRADE_GROUP_ID=
```

`BINANCE_TESTNET` 决定程序启动时的默认环境。页面最上方的“环境切换”开关可以在当前运行期间切换 Testnet 和正式环境：程序会关闭旧环境的 Spot / USDⓈ-M 连接，清空页面中的旧环境状态，再自动识别并重连当前合约。切换到正式环境前会弹出确认提示。

Testnet 和正式环境的 API Key 不通用，因此推荐分别配置。USDⓈ-M Testnet 通常还需要单独申请 Futures Demo Key；未填写 Futures 专用变量时，程序会尝试复用同环境凭证。为兼容旧版，`BINANCE_API_KEY` 和 `BINANCE_API_SECRET` 仍可使用，但只会应用于 `BINANCE_TESTNET` 指定的启动默认环境。未配置目标市场密钥时仍能查看公开行情，但不能查询私有账户、下单或撤单。多子账号使用 STP 时，可填写两个 `EXPECTED_TRADE_GROUP_ID`，程序会将账户接口返回值与预期交易组核对；这只能发现配置问题，不能替代 Binance 后台为子账号配置相同交易组。

正常启动必须先通过新期管理端登录。登录成功后，所选管理端账号在当前会话中覆盖本地全部 Binance 凭证，管理端系统配置覆盖本地两个 LinkID；切换 Testnet/正式环境只改变服务地址，不会暗中切换回 `.env` 中的其他账号。不属于目标环境的 Key 会由 Binance 明确拒绝。当前管理端地址为 HTTP，用户名、密码和返回的交易密钥在传输链路上没有 HTTPS 加密，生产使用前应由服务端升级为 HTTPS。

仅凭 `BTCUSDT` 这样的文本无法区分同名 Spot 与永续市场。为保持现有交易行为，symbol 同时存在于两个市场时默认选择 Spot；只存在于 USDⓈ-M 的 symbol 会自动选择 Futures。Futures Testnet 的合约列表不保证与正式环境一致，因此 `SKHYUSDT` 可能只能在正式环境查看。

所有连接直接使用系统网络，因此 WireGuard 必须在操作系统层面处于可用状态。页面切换只在当前程序运行期间生效；重新启动后仍以 `BINANCE_TESTNET` 的值作为默认环境。

低延迟模式默认关闭逐笔余额预查，余额和动态价格过滤器仍由 Binance 撮合引擎在接单时校验。服务器时间在后台刷新，静态交易规则在连接行情时预热。若更看重提交前的中文余额提示，可将 `BINANCE_PREFLIGHT_BALANCE_CHECK` 设为 `true`，代价是每笔报单多一次账户查询。

## 运行与测试

```bash
npm install
npm test
npm start
```

`npm start` 默认启用开发热更新，并在登录窗口和主窗口加载完成后自动打开独立的前端调试控制台。修改页面、样式、preload 或渲染逻辑时只刷新对应窗口，并保留主进程中的登录会话；修改 `main.js`、Binance 客户端、管理端服务等后台代码时自动重启 Electron。`.env` 和 `package.json` 保存后也会自动重启。需要关闭监听、只启动一次且不自动打开调试控制台时使用 `npm run start:once`。打包后的正式应用不会启用代码监听或自动打开调试控制台。

运行时代码支持 macOS 和 Windows。正式环境 USDⓈ-M 的公共 REST 行情会依次尝试 Electron Chromium 网络栈、Node HTTPS 和可选 curl 后备，并缓存当前机器已验证可用的传输；Windows 不要求安装 curl。需要显式指定后备 curl 时，可在 `.env` 设置 `BINANCE_CURL_PATH=C:\\完整路径\\curl.exe`。打包后的 macOS 应用从 `.app` 同级读取 `.env`，Windows 应用从 `.exe` 同级读取 `.env`。

## 生成桌面应用与三开

### macOS

在 Apple Silicon Mac 上执行：

```bash
npm run build:mac
```

产物位于 `dist/mac-arm64/Binance统一交易台.app`，可直接双击运行。构建脚本不会把密钥封装进 `.app`，而是把当前 `.env` 以 `600` 权限放在应用旁边；移动应用时需要同时移动该 `.env`，或在目标目录按 `.env.example` 重新配置。

### Windows

在 Windows 10/11 上安装 Node.js 22.12 或更高版本，然后在 PowerShell 或命令提示符中执行：

```powershell
npm install
npm run build:win
```

`build:win` 为主流 Intel/AMD 电脑生成 x64 版本；Windows ARM 电脑可执行 `npm run build:win:arm64`，需要同时生成两个架构时执行 `npm run build:win:all`。只想快速验证不生成安装程序时，可执行 `npm run build:win:dir`。

正式构建会在 `dist` 目录同时生成以下两类产物：

- `Binance统一交易台-1.0.0-Windows-x64.exe`：可选择安装目录的 NSIS 安装程序。
- `Binance统一交易台-1.0.0-Windows-x64.zip`：解压后直接运行的版本。

构建不会把真实 `.env` 或 API Secret 打进 Windows 包，只会附带 `.env.example`。安装或解压后，把配置保存为主程序 `Binance统一交易台.exe` 同目录下的 `.env`；也可以保存到 `%APPDATA%\Binance统一交易台\.env`。当前未配置 Windows 代码签名证书，因此首次运行时 Windows SmartScreen 可能显示“未知发布者”，确认文件来自本仓库后可选择继续运行。

启动第一份后，点击“系统 → 打开另外两份”，程序会再启动两个使用独立 Chromium 数据目录的实例，避免多实例锁冲突。三份实例共享外部 `.env` 和快捷键 JSON 配置，其他页面本地设置彼此独立。

建议先点击“测试连通性”和“刷新交易规则”，再使用“仅测试参数”验证委托。Spot `/api/v3/order/test` 与 USDⓈ-M `/fapi/v1/order/test` 成功都不会生成订单，因此不会出现在订单历史和当前挂单中。

“提交真实委托”、组合订单以及撤单操作即使在 Testnet 也会改变测试账户状态；正式环境则会涉及真实资产和永续仓位。正式环境使用前请为 API Key 设置 IP 白名单，只开放需要的读取、现货或 Futures 权限，禁止提现权限。

## 当前边界

- USDⓈ-M 已覆盖行情、普通下单、测试下单、撤单、当前挂单、订单历史、成交历史、账户与手续费；OCO、OTO、OTOCO 仍为 Spot 专属功能。
- 不包含 COIN-M、杠杆账户和杠杆倍数配置界面；U 本位交易固定使用单向持仓模式，下单窗口可明确选择开仓或只减仓平仓。
- 最近 24 小时订单、交易回合、快捷键和跨实例限流快照会保存为本地 JSON；仍没有长期数据库、完整审计日志和应用内多账户切换管理。
- 未实现 SOR、OPO/OPOCO、批量订单、FIX/SBE 等专业接口。
- 页面提供 OCO/OTO/OTOCO 常用参数组合；更复杂的追踪止损、冰山及挂钩价格参数仍需扩展表单。
