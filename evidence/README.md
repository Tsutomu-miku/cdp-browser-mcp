# 本机验收证据

所有请求均来自 loopback 合成站，Cookie 值为固定测试文本，未使用真实账号或外部站点。

环境：macOS（darwin）、Node 22.17.0、Playwright 1.65.1、Chrome 157.0.8103.51。

| 实测 | 请求数 | 携带 Agent 标记的请求 | header 串线 | 证据 |
| --- | ---: | ---: | ---: | --- |
| headless=new | 44 | 43 | 0 | [JSON](concurrent-headless.json) |
| headed | 44 | 43 | 0 | [JSON](concurrent-headed.json) |

每轮包括：两个真实 MCP stdio client 并发 7 类动作；两个额外独立 connectOverCDP client 检查同一 default context cookie；两 Agent 同 origin 不同 header；document/css/js/img/fetch/xhr/beacon/导航/同源与跨 origin iframe/DedicatedWorker/嵌套 worker；主 frame 与跨 origin iframe 下载分发；外部关 tab、租约到期、跨 Agent 拒绝、磁盘守卫、CDP 真断线后重启与 cookie 恢复。每条服务器请求保留 sequence/method/path/agent/lane/environment/identity/dest。events 给出请求 origin、tab、Agent、header 指纹，以及下载 GUID 归属。

## Spike（先于工程）

- [不设策略的基线](spike-baseline-headless.json)：两个独立 CDP client 共享一次 cookie、独立 page；page/iframe/DedicatedWorker/嵌套 worker 的 header 正确，SharedWorker/SW 自身 fetch 无 lane header。
- [阻断策略无头](spike-block-headless.json) / [阻断策略有头](spike-block-headed.json)：SharedWorker 不可用，SW 注册脚本被 abort；服务器收到的 shared/SW 脚本及后台 fetch 均为 0。
- 同 origin 的 SW/SharedWorker 没有 per-tab 身份；本版本固定阻断，未提供保留共享 worker 后多泳道并发的模式。

## 生命周期与打包

- [CLI 生命周期](cli-lifecycle.json)：后台启动、重复启动复用、0600 socket/管理员文件、0700 stateDir、强杀 supervisor 后核验并关闭遗留专用 Chrome、清理 socket/lock/进程。
- [包清单](pack.json)：npm pack 生成的实际文件清单、大小与 integrity。包安装后 bin --help 已运行；未执行 npm publish。
- npm run build、npm test、npm run test:headed 均通过；每轮 2 个真实浏览器场景，无 mock 网络和浏览器。npm audit（公共 npm registry）0 已知漏洞。

已实测：Mac 有头关闭唯一启动页后，下载没有遵循先前已确认成功的 GUID 暂存策略；保留受管 anchor tab 后两模式验收通过。推断：最后窗口关闭改变了下载管理的生命周期，未对 Chromium 内部对象做插桩确认。工程持续保留 anchor tab；Chrome 默认下载偏好也锁入专用 stateDir，终态文件路径必须符合 GUID 暂存契约。最初误落系统 Downloads 的固定合成文本已逐一核对并删除。

## 仅文档 / 未验

Linux 实机、Xvfb、跨主机登录态迁移、MCP IDE 内接入、远程浏览器服务 属于文档或后续设计，未声称已验收。外部真实站点未验。macOS 上 headless=new 的实测不等于 Linux 实机测试。
