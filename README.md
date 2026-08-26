# Electron Binance 统一交易测试台

本工程通过 Electron 主进程连接 Binance Spot 与 USDⓈ-M Futures，Secret 不会暴露给渲染页面。东京出口由操作系统的 WireGuard 路由负责，工程不包含代理配置。

## 已实现功能

- REST 连通性和服务器时间同步。
- 根据唯一的“全局合约”自动识别 Spot / USDⓈ-M，并将行情、普通下单、撤单和查询路由到对应市场；只存在于 Futures 的 `SKHYUSDT` 无需手动选择市场。
- `exchangeInfo` 交易规则与过滤器展示。
- 最新价、最优买卖、平均价、24 小时行情、最近成交、聚合成交和 K 线。
- REST 深度快照 + WebSocket 增量维护本地订单簿。
- `LIMIT`、`MARKET`、`LIMIT_MAKER`、止盈止损类普通订单。
- 普通下单可选择“按数量”或“按总价”：现货 `MARKET` 直接发送 `quoteOrderQty`；现货其他类型和 USDⓈ-M 按委托价、触发价或最新成交价换算并按 `stepSize` 修正数量。USDⓈ-M 总价表示名义价值，不是保证金金额。
- 所有普通委托、撤单重报和 Spot OCO/OTO/OTOCO 固定携带 `selfTradePreventionMode=EXPIRE_MAKER`。账户信息会显示当前市场账户接口返回的 `tradeGroupId`：跨子账号现货 STP 只有在各账号属于相同且非 `-1` 的交易组时生效。USDⓈ-M 官方只保证该模式在 `IOC/GTC/GTD` 下有效，因此 `MARKET` 和映射为 `GTX` 的 `LIMIT_MAKER` 不应被视为具有同等保护。
- 正式环境支持为当前 U 本位 API Key 所属子账号签署 TradFi-Perps 协议；可在“账户信息”中主动签署，下单收到 `Please sign TradFi-Perps agreement contract fapi` 时也会弹出二次确认并在签署成功后重试原委托。协议不会在程序启动时静默签署，Testnet 不调用该正式环境接口。
- `/api/v3/order/test` 测试下单（只校验，不进入撮合引擎）。
- 下单前按 `PRICE_FILTER`、`LOT_SIZE`、`MIN_NOTIONAL/NOTIONAL`、`PERCENT_PRICE(_BY_SIDE)` 校验，并按 tickSize/stepSize 修正精度。
- 单笔撤单、全部撤单、当前挂单、单笔订单、全部订单、减量改单、撤单重报。
- 账户信息、成交历史、手续费率和下单限频。
- OCO、OTO、OTOCO 创建；组合订单历史、当前组合挂单、单笔查询和撤销。
- Spot 与 USDⓈ-M User Data Stream 实时接收订单、成交和账户事件，永续订单事件会转换为页面统一使用的 `executionReport`，断线自动重连。
- Spot 与 USDⓈ-M 分别维护独立的交易 WebSocket API 持久连接；官方支持的下单、撤单、改单、订单及账户查询优先走 WebSocket，连接不可用时自动回退到 HTTPS Keep-Alive，并在后台指数退避重连。若真实下单已经写入 WebSocket 但响应丢失，程序不会用 HTTP 盲目重报，以避免重复委托，而是返回 `UNKNOWN` 提醒查询订单状态。
- 报单和撤单只在收到 Binance 成功响应或 `executionReport` 后更新行情图，不使用本地乐观状态；确认后立即重绘。
- 页面顶部提供“系统 / 配置”菜单；“配置 → 快捷键”以列表维护按键、动作、方向、超价和手数，支持新增、编辑、删除与恢复默认。设置保存在本机的 `~/Library/Application Support/Binance统一交易台/shortcut-settings.json`。
- 行情图上方只保留一个“全局合约”输入框；行情、下单、撤单、订单与成交查询、手续费和组合订单等功能统一读取该合约，点击“切换行情”或按 Enter 可重连行情。
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
BINANCE_TESTNET_FUTURES_API_KEY=你的_Futures_Testnet_API_Key
BINANCE_TESTNET_FUTURES_API_SECRET=你的_Futures_Testnet_API_Secret
BINANCE_PRODUCTION_FUTURES_API_KEY=你的_Futures_正式环境_API_Key
BINANCE_PRODUCTION_FUTURES_API_SECRET=你的_Futures_正式环境_API_Secret
BINANCE_PREFLIGHT_BALANCE_CHECK=false
```

`BINANCE_TESTNET` 决定程序启动时的默认环境。页面最上方的“环境切换”开关可以在当前运行期间切换 Testnet 和正式环境：程序会关闭旧环境的 Spot / USDⓈ-M 连接，清空页面中的旧环境状态，再自动识别并重连当前合约。切换到正式环境前会弹出确认提示。

Testnet 和正式环境的 API Key 不通用，因此推荐分别配置。USDⓈ-M Testnet 通常还需要单独申请 Futures Demo Key；未填写 Futures 专用变量时，程序会尝试复用同环境凭证。为兼容旧版，`BINANCE_API_KEY` 和 `BINANCE_API_SECRET` 仍可使用，但只会应用于 `BINANCE_TESTNET` 指定的启动默认环境。未配置目标市场密钥时仍能查看公开行情，但不能查询私有账户、下单或撤单。

仅凭 `BTCUSDT` 这样的文本无法区分同名 Spot 与永续市场。为保持现有交易行为，symbol 同时存在于两个市场时默认选择 Spot；只存在于 USDⓈ-M 的 symbol 会自动选择 Futures。Futures Testnet 的合约列表不保证与正式环境一致，因此 `SKHYUSDT` 可能只能在正式环境查看。

所有连接直接使用系统网络，因此 WireGuard 必须在操作系统层面处于可用状态。页面切换只在当前程序运行期间生效；重新启动后仍以 `BINANCE_TESTNET` 的值作为默认环境。

低延迟模式默认关闭逐笔余额预查，余额和动态价格过滤器仍由 Binance 撮合引擎在接单时校验。服务器时间在后台刷新，静态交易规则在连接行情时预热。若更看重提交前的中文余额提示，可将 `BINANCE_PREFLIGHT_BALANCE_CHECK` 设为 `true`，代价是每笔报单多一次账户查询。

## 运行与测试

```bash
npm install
npm test
npm start
```

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
- 不包含 COIN-M、杠杆账户和持仓模式/杠杆倍数配置界面；永续下单沿用账户当前的持仓模式和杠杆设置。
- 没有数据库持久化、跨进程审计日志和多账户管理。
- 未实现 SOR、OPO/OPOCO、批量订单、FIX/SBE 等专业接口。
- 页面提供 OCO/OTO/OTOCO 常用参数组合；更复杂的追踪止损、冰山及挂钩价格参数仍需扩展表单。
