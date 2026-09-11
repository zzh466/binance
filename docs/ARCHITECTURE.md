# 工程架构说明

## 运行入口

- `src/main.js`：Electron 主进程编排，负责登录会话、Binance 客户端生命周期、IPC 注册、后台同步任务和窗口创建。
- `src/preload.js`、`src/loginPreload.js`：主进程与页面之间的最小安全桥接，不向页面暴露 API Secret。
- `src/renderer.js`、`src/loginRenderer.js`：主窗口和登录窗口的页面交互编排。
- `scripts/dev.js`：跨 macOS、Windows 的开发启动与热更新入口。

## 页面模块

- `src/chart.js`：自定义行情图 `Chart`，只负责行情、成交与自有挂单的绘制。
- `src/depthAggregation.js`：将当前收到的有限档位按 1/5/10 级精确聚合；买卖盘分别计算，不发起任何额外行情订阅。
- `src/chartOrderSelection.js`：把画布坐标转换为明确的买卖方向、价格和档位，不负责发送订单。
- `src/rendererElements.js`：主页面必要控件的统一选择器注册表；页面缺少控件时在初始化阶段直接报错。
- `src/openOrderState.js`：页面内未完成订单 Map 的统一键和状态更新规则。
- `src/shortcutSettings.js`：快捷键配置的数据结构、校验、迁移和展示名称。

`src/index.html` 中页面脚本必须先加载上述独立模块，最后加载 `renderer.js`。模块同时兼容浏览器全局对象和 Node `require`，以便不引入打包工具也能进行单元测试。

## 后台业务模块

- `src/binance/binanceClientBase.js`：U 本位客户端共用的 HTTP、时间同步、精度校验、交易 WebSocket API 和可切换的 5/10/20 档行情传输基础能力，不包含任何现货端点。
- `src/binance/binanceUsdMClient.js`：U 本位行情、交易、账户事件和跨平台网络降级。
- `src/binance/binanceUnifiedClient.js`：U 本位客户端门面、最近订单对账和一键平仓编排。
- `src/binanceAccountMetricsService.js`：账户资金、持仓和近 24 小时盈亏指标。
- `src/recentOrderStore.js`：最近 24 小时订单的统一持久化状态。
- `src/tradingRoundStore.js`：交易回合、成交增量和多空平均成交价。
- `src/managerClientService.js`：新期管理端登录、账号合并、配置读取和指标同步。
- `src/sharedRateLimitCoordinator.js`：多个客户端实例共享 Binance 限流状态。
- `src/windowLifecycle.js`、`src/platformSupport.js`：Electron 窗口生命周期和 macOS/Windows 差异。

## 必须保持的交易安全边界

1. API Key 和 Secret 只能存在于 Electron 主进程，不得写入页面、日志或提交到 Git。
2. 程序只允许 U 本位永续订单，页面不直接拼接 Binance 请求，也不得恢复现货自动路由。
3. 真实订单在网络结果不明确时不得盲目改走另一个传输重报，应保留 `UNKNOWN` 并按 `clientOrderId` 查询确认。
4. 行情图和快捷键只有在收到 Binance 确认后才能更新挂单展示。
5. 行情双击必须同时满足“事件来自画布、坐标位于有效买卖档位、没有订单正在提交、未进入防重复间隔”。
6. 所有共享运行代码必须同时支持 macOS 和 Windows；新增路径、进程或网络分支时需要覆盖 `darwin` 与 `win32` 测试。

## 修改与验证

纯计算逻辑优先放入独立模块并通过依赖注入测试，`main.js` 和 `renderer.js` 只负责连接模块及应用生命周期。每次修改至少执行：

```bash
npm test
git diff --check
```

涉及页面脚本时还应确认 `index.html` 的脚本加载顺序；涉及窗口、路径、子进程或网络传输时必须同时验证 macOS 和 Windows 分支。
