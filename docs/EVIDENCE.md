# 证据记录（本机实测）

> 目的：把「已验证」与「未验证」分开。下面每条都可用给定命令复跑；无法复跑的结论不写。
>
> **1.0.0 更新（2026-11-12）**：全面适配 DSH **0.2.2-rc.2**；新增 `engines.dsh: ">=0.2.2-rc.2"` 版本门；真机（`app.asar` 解包树）compat 探针 **13/13**（新增 engines.dsh 门一项），单测 **208/208**；rc.1→rc.2 升级指南逐条复核，无迁移项。
>
> **0.9.0 更新（2026-11-11）**：设置页保存即生效（`loader/volatile-update` → 重新归一化 → supervisor.applyConfig 热启动/热重启/停止）、新增 `xray_start` / `xray_stop` / `xray_restart` 工具、`port-busy` 附带占用进程 PID/镜像名；单测 **208/208**（新增 `test/reload.test.js`），compat 探针 12/12 保持。
>
> **0.8.0 更新（2026-11-05）**：设置页新增 jsQR 兜底（BarcodeDetector 不可用时图片/屏幕扫码仍可用）；单测 **199/199**，compat 探针 **12/12** 保持通过。文末 E1 的 96/96 是 0.7.0 基线记录，保留作为历史。
>
> **注意**：2026-11-05 清理 `E:\GPT\.tmp` 时丢失了部分一次性探针脚本（`.tmp/probe-*.mjs`）。仓库、reports、secrets 与 Release 资产未受影响；本文件引用的临时脚本可按命令重建。

## 环境

| 项 | 值 |
|---|---|
| DSH | 0.2.2-rc.2 桌面版（`E:\DSH\DS\DeepSeek Harness.exe`，实现打包在 `app.asar`；0.7.0 基线为 0.2.1-rc.3） |
| 运行时 | Node 24.21.0 / Electron 44.7.0（`ELECTRON_RUN_AS_NODE=1`） |
| 打包 undici | 8.11.2（`app.asar\dsh\node_modules\undici`） |
| 打包 schemastery / cordis | 3.19.0 / 4.1.0 |
| 本机 xray | 26.9.30（`C:\Users\fangw\.dsh\xray-proxy\bin\xray.exe`；0.7.0 基线为 1.4.5） |

## E1 单元测试

```powershell
cd E:\GPT\dsh-2xray
node --test --test-isolation=none test/*.test.js
```

结果：**96/96 通过**（0.7.0 基线；0.8.0 为 **199/199** + compat 12/12），覆盖：

- 配置归并/校验（缺字段、flow×security 组合、shortId、base64url 公钥、回环限制、端口冲突、多节点 tag 重复、activeNode 回退、control 端口冲突）
- xray 配置生成（单节点旧形状、多节点 outbound + balancer、API 入站 / services / stats / routing 首条规则）
- 分享链接（vless:// REALITY/none、IPv6、默认值、非法协议、与 nodes 合并、生成 outbound）
- 二进制解析优先级（config → DSH_XRAY_BIN → 插件 bin/ → 数据目录 → PATH，缺省时列出候选）
- 路由管理（harness 安装/幂等/回滚、已有策略不覆盖、`force`、实例不一致回滚、builtin 兜底、SOCKS 强制 builtin）
- 状态机（启动顺序、缺二进制、退出码 23 不重启、崩溃退避重启、重启上限、停止顺序、启动中停止、端口占用、启动时钉住 balancer、switchNode 不重启进程）
- 控制面（protobuf 编解码、gRPC unary over h2c、非零状态码、连接拒绝、QueryStats/OverrideBalancerTarget）
- 工具（四个工具注册、调用透传、validateConfig 预检、缺少 dsh-tools 时静默降级）
- 健康探测（TCP、晚到监听、预算耗尽、端口占用、204 功能探测、可取消等待）

> 沙箱内不能 `node --test test/`：它按文件 spawn 子进程并走管道，会被拒绝（EPERM）。`--test-isolation=none` 在进程内跑。

## E2 模块解析（M0 关键假设）

探针（`.tmp/probe-resolve.mjs`，一次性）：

```
import undici                       => FAIL ERR_MODULE_NOT_FOUND
import @deepseek-ai/dsh-http-proxy  => FAIL ERR_MODULE_NOT_FOUND
createRequire('E:/DS/resources/app.asar/dsh/package.json').resolve('@deepseek-ai/dsh-http-proxy')
  => E:\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-http-proxy\lib\index.js
dynamic import of resolved          => ok exports=clearedProxyEnv,installProxyFromEnvironment,proxyEnvironmentForChild,proxyRouteFor
```

同样的解析方式也用于工具层：

```
dsh-tools resolved: E:\DS\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js
defineTool works: xray_probe {"type":"object","properties":{"node":{"type":"string","description":"node"}},"required":["node"]}
```

结论：插件**不能**用裸 `import('undici')` / `import('@deepseek-ai/dsh-http-proxy')`；必须用 `createRequire(<安装目录>/dsh/package.json)` 解析后按 file URL 动态 import。`lib/route.js` 的 `installationAnchors()` 按此实现，失败时退回 builtin。

## E3 路由安装/恢复与真实 egress

```powershell
ELECTRON_RUN_AS_NODE=1 "E:\DS\DeepSeek Harness.exe" scripts/probe-routing.mjs
```

输出：

```
PASS route installed through the harness policy
PASS proxied fetch got the proxy answer
PASS proxy saw an absolute-form request line      # "http://probe.invalid/x"
PASS loopback traffic bypassed the proxy          # "/direct"
PASS post-restore fetch is direct again (ENOTFOUND)
all routing checks passed
```

这同时证明了三件事：`installProxyFromEnvironment` 装的是**同一个**模块实例（否则 `proxyRouteFor` 不会同意）；全局 `fetch` 确实被接管；回环与恢复语义正确。

## E4 插件入口在真实运行时加载

`ELECTRON_RUN_AS_NODE=1 "E:\DS\DeepSeek Harness.exe" .tmp\probe-index.mjs`（最小 cordis 形状的 ctx）：

```
effect registered: dsh-2xray/xray-supervisor
[info] state=idle reason=disabled
plugin name: dsh-2xray dispose type: function
[info] state=stopped reason=disposed
disposed cleanly
```

结论：ESM 图可加载；`ctx.effect` 注册与 disposer 正常；禁用时不动进程与网络。

## E5 xray 配置结构校验（降级）

本机二进制太旧（1.4.5，不支持 REALITY、也不认 `raw` 传输名），用 `--legacy` 把 stream 降级为 `tcp/none` 后：

```powershell
node scripts/check-config.mjs --config examples/config.downgrade.json --xray "E:\20221120\BaiduNetdiskDownload\v2rayN-Core\xray.exe" --legacy
```

输出：`Reading config ... Configuration OK.`

多节点（2 节点 + balancer + API 入站 + stats）同样通过：

```powershell
node scripts/check-config.mjs --config examples/config.multi.downgrade.json --xray "E:\20221120\BaiduNetdiskDownload\v2rayN-Core\xray.exe" --legacy
```

这证明 inbound/outbound/routing/policy/balancer/api 骨架合法；**不**证明 REALITY 字段与 `network: raw` 在 v26 上合法。

## E6 真实 xray 的 gRPC 控制面

用本机 xray 1.4.5 启动 `examples/config.multi.downgrade.json` 生成的配置（API 入站 10085），再用插件的零依赖客户端调用：

```
stats: [{"name":"inbound>>>api>>>traffic>>>uplink","value":188},
        {"name":"inbound>>>api>>>traffic>>>downlink","value":54},
        {"name":"inbound>>>http-in>>>traffic>>>uplink","value":0},
        {"name":"inbound>>>http-in>>>traffic>>>downlink","value":0}]
balancer failed: 12 unknown service xray.app.router.command.RoutingService
snapshot: {"reachable":false,"lastError":"12: unknown service xray.app.router.command.RoutingService",...}
```

结论：

- HTTP/2 分帧、gRPC 状态码、protobuf 编解码与真实 Xray 对得上（StatsService 是长期存在的服务）。
- `RoutingService`（`GetBalancerInfo` / `OverrideBalancerTarget`）在 1.4.5 不存在，返回 `UNIMPLEMENTED(12)`。该服务进入主线的时间是 2024-03（PR #3189 一带），因此多节点运行时切换要求 **2024-09 之后的版本（v1.8.24+ / v24.9+）**，并在更老版本上降级为「随机 balancer + 明确诊断」。
- 多节点配置骨架已被 1.4.5 判为 `Configuration OK.`，见 E5。

## E8 DSH 0.2.2-rc.2 兼容探针（1.0.0）

真实安装树（从 `app.asar` 解包，不经 fake ctx）：

```powershell
node tools/extract-dsh-app.mjs --asar "E:\DSH\DS\resources\app.asar" --out "$env:TEMP\dsh-2xray-compat"
$env:DSH_APP_ROOT="$env:TEMP\dsh-2xray-compat"
node --test --test-isolation=none test/compat/host.test.js test/compat/client.test.js
```

结果：**13/13 通过**，`harness @deepseek-ai/dsh 0.2.2-rc.2`。逐项：

| # | 探针 | 断言的真实行为 |
|---|---|---|
| 1 | 0.2 线目标 | 被测树版本满足 `^0.2.` |
| 2 | node 引擎 | 插件 `engines.node` 不松于 DSH 的 `>=24.9.0` |
| 3 | **engines.dsh 门**（1.0.0 新增） | `engines.dsh` 在 `includePrerelease` 下接受 0.2.2-rc.2；市场索引声明同一范围 |
| 4 | `cordis.patch.yml` | cordis-plugin-include 应用后恰为 1 行，`id=xray-proxy`、`name` 等于包名、`config={enabled:false}` |
| 5 | settings schema | schemastery 3.19.0 构建 `Config`；16 个 `volatile` 路径（含嵌套 `binary.path`）；空配置归一为默认值 |
| 6 | 真实 fiber | 真 cordis 4.1.0 上挂载、注册 **4 条** `connection.fetch` 路由与 **7 个**工具；`loader/volatile-update` 即时应用并在日志环留下记录；dispose 后 4 条路由全部释放 |
| 7 | 代理策略 | `installProxyFromEnvironment` 安装 → `proxyRouteFor(sentinel)` 返回该代理；`restore()` 后不再代理 |
| 8 | 工具参数方言 | `validateArgs` 接受合法参数、拒绝缺必填 |
| 9 | 子进程规格 | `dsh-subprocess-local` 的启动规格校验接受 `lib/process.js` 的形状，拒绝 `graceMs:0`/空 `argv`；`spawn`/`resolveExecutable` 仍在 |
| 10 | client 声明 | `dsh.client={platform:'web',inject:[@deepseek-ai/dsh-client-locale]}`；注入的模块确实是 web client 模块 |
| 11 | 浏览器 bundle | `__ModuleLoader__.load` 恰好注册 1 个模块，id 为包名 |
| 12 | client 插件 | 在真 cordis Context 上 `inject=['slots']`，注册 `sidebar.panellist`/`main`/`settings.section`/`plugins.item` 四个 slot，`PANEL_ID=xray` |
| 13 | UI slot 存续 | 四个 slot 名仍出现在 0.2.2-rc.2 的 sidebar / settings-general / plugin-manager / settings 客户端包里 |

### 0.2.2-rc.1 → rc.2 升级指南复核

逐条读过 `docs/upgrade-guide/v0.2.2-rc.1/` 的 21 项，与本插件相关的判断：

| 条目 | 是否影响本插件 | 依据 |
|---|---|---|
| `plugin-update-method`（`BundleInfo.update`） | 否 | 插件不读 `listBundles()`/`BundleInfo`；自更新走 npm registry + tarball 校验（`lib/update.js`） |
| `window-drag-regions` | 否（macOS 专属） | 插件没有覆盖可拖动页头的自定义浮层；slot 内容位于面板体内 |
| 账号通知 / Forge / Session / Terminal / web-search 计费 / CUA | 否 | 插件不调用这些服务、不注册这些 slot、不读这些持久化数据 |

结论：rc.2 对本插件 **无破坏性变更**，1.0.0 只需声明版本门并复验。

## E9 未验证项（必须在目标机执行）

| 项 | 为什么没做 | 复跑方式 |
|---|---|---|
| v26.10.x `run -test` | 本机无新二进制 | 下载对应 release，`node scripts/check-config.mjs --config real.json --xray .../xray.exe` |
| 多节点切换端到端 | 本机 1.4.5 无 `RoutingService` | 用 v24.9+ 启动多节点配置，调用 `xray_switch_node`，对照 xray 日志/出站 |
| 真实服务端连通 | 无可用服务端参数 | 配好 `server.*` 启动 DSH，看 `status.json` 的 `functionalProbe` |
| Windows Job Object 清理 | 需要以插件方式装进 DSH 并强杀进程 | 装 bundle → 启动 → 任务管理器结束 DSH → 确认 `xray.exe` 消失 |
| `web_fetch` 实抓一致性 | 需要 DSH 内真实调用 web_fetch | 让模型抓一个只经代理可达的页面，对照 xray 日志 |
| 83 条验收用例 | 属验收阶段 | 见仓库根目录 `DSH-XRAY-PROXY-ACCEPTANCE-TEST-PLAN.md` |
