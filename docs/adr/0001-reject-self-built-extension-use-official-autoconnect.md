# ADR 0001：不做自研浏览器扩展，日常 Chrome 统一走官方 chrome-devtools-mcp --autoConnect

- 日期：2026-11-15
- 状态：已接受（Accepted，2026-11-15，随 PR #5 合入 main）。

> 扩展方向由 [ADR 0002](0002-extension-daily-chrome.md) 的 v0.4.0 实现提案取代；本文保留历史决策及 autoConnect 授权边界。

## 背景

日常浏览器 PoC 的目标是复用用户正在使用的 Chrome profile 登录态，避免在专用自动化 profile 中重新登录。从 Chrome 136 起，默认 Chrome 数据目录不再接受 `--remote-debugging-port` / `--remote-debugging-pipe`，使用这些开关必须指定非默认 `--user-data-dir`。这个限制是探索 MV3 扩展加 native host 路线的动机，见 [Chrome 官方说明](https://developer.chrome.com/blog/remote-debugging-port)。

[PR #1](https://github.com/Tsutomu-miku/cdp-browser-mcp/pull/1) 因此实现了自研 MV3 扩展和 native host，以操作日常 profile 的标签页。现在已锁定的官方 `chrome-devtools-mcp@1.13.0` 提供 `--autoConnect`，可以在 Chrome 144+ 上连接已运行的浏览器，满足这项登录态复用需求。

## 决策

- 停做自研浏览器扩展 backend。PR #1 关闭、不合并；保留 `extension-backend-poc` 分支供历史查阅。
- 日常 Chrome 的接入方向统一采用官方 `chrome-devtools-mcp --autoConnect`，只做必要的薄适配，不再维护 MV3、native host 或自动回退的第二套 backend。
- 多泳道和 CI 继续采用 main 现有的专用 CDP 实例及独立于日常浏览器的 profile。需要账号或租户隔离时使用不同 profile/实例，不把标签页归属当作租户隔离。
- 本 ADR 只记录架构决策，不实现新的 autoConnect 接入，不修改现有代码、依赖、配置或 CI。

## 被否决的方案

继续产品化 PR #1 的自研 MV3 + native host 方案。该 PR 新增 3,523 行，意味着同时维护扩展与 CDP 两套操作链、生命周期、权限和安装升级流程；继续分发还需承担扩展商店审核与 native host 部署的成本。PoC 定位为单泳道登录态复用，共享 profile 本来也不能隔离账号或租户。官方能力已经覆盖原始硬需求，继续维护重复双轨没有足够收益。

## 后果与边界

- 日常浏览器 autoConnect 路径要求 Chrome 144+，且 Chrome 必须已由用户启动；不为旧版本追加兼容 backend。
- 首次需在 `chrome://inspect/#remote-debugging` 完成一次手动启用/授权，并批准 Chrome 的连接对话框。是否再次提示由 Chrome 控制，不承诺永久免确认或无人值守授权。
- 连接采用 Chrome 确定的默认 profile，可复用其登录态并访问该 profile 的所有窗口。它不提供租户隔离；不能把日常 profile 当作不互信任务的安全边界。
- Linux 无头和 CI 路径不受本决策影响，继续使用现有专用实例流程，不依赖日常 Chrome 的界面授权。本 ADR 不改变其实现或支持范围。
- 扩展 PoC 的源码和验证历史保留在原分支；main 不引入该实现。

## 官方证据

核验日期为 2026-11-15：本仓 [package.json](../../package.json) 锁定 `chrome-devtools-mcp` 为 `1.13.0`，本机安装包的 `--version` 也输出 `1.13.0`。核验命令（先按锁文件安装依赖）：

```zsh
node node_modules/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js --version
node node_modules/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js --help
```

该版本 help 的 `--autoConnect` 条目明确要求 Chrome 144+，从所选 channel 的本地用户数据目录连接已运行的 Chrome，默认 channel 为 stable，并要求通过 `chrome://inspect/#remote-debugging` 启动远程调试。

- [官方 README：连接现有浏览器](https://github.com/ChromeDevTools/chrome-devtools-mcp#connect-to-an-existing-browser)。
- [官方 advanced usage：Connecting to a running Chrome instance](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#connecting-to-a-running-chrome-instance)，包含授权步骤、默认 profile 和所有窗口的访问范围。
- [Chrome 136 调试开关变更](https://developer.chrome.com/blog/remote-debugging-port)。
