# AC-0 接管方式声明（供验收）

对应 `DSH-XRAY-PROXY-ACCEPTANCE-TEST-PLAN.md` 的闸门 0：实现方必须先声明接管层级，否则 F 组用例无法判定。本实现选择：

## 接管层级：M2（运行期策略安装，进程级）

```
插件 apply()
  └─ 启动 xray 子进程
       └─ TCP 就绪 + 功能探测通过
            └─ 调用 @deepseek-ai/dsh-http-proxy 的 installProxyFromEnvironment()
                 （合成 env：http_proxy=https_proxy=http://127.0.0.1:<port>）
                 → 安装进程级 dispatcher + 更新 active policy
  └─ ctx.effect 清理：先调 disposer 恢复策略，再 terminate 子进程
```

- **不是** M1（启动期 env 注入）：插件无法在 launcher 安装前运行；但通过调用同一个策略安装函数，效果与启动物理注入一致，且 `proxyRouteFor()` 与 dispatcher 同源。
- **不是** M2 的「逐调用点注入」：没有修改任何调用点（模型、web_fetch、搜索都未改）。
- **不是** M3（进程外前置代理）。

## 覆盖声明

| 流量 | 覆盖 | 证据 |
|---|---|---|
| `globalThis.fetch`（模型 API、搜索、MCP HTTP、插件 fetch、账号） | ✅ | `scripts/probe-routing.mjs`：absolute-form 请求行到达假代理 |
| `web_fetch` | ✅（harness 模式） | 走 `proxyRouteFor()` 同一策略；未实抓验证 |
| 回环（DSH Web UI、本地服务） | ❌ 强制直连 | 探针：origin-form 请求行 |
| `noProxy` / 内网 IP | ❌ | Xray routing + 策略 bypass |
| `ws`、Electron 更新、OTel、worker | ❌ | 不在 undici dispatcher 路径上 |
| 子进程（bash/curl） | ⚠️ 取决于程序是否读 `HTTP_PROXY` | 由 DSH 的 `proxyEnvironmentForChild()` 派生，非本插件写 env |

## 观测点对照（相对验收计划的硬要求）

| 要求字段 | 现状 |
|---|---|
| `state`（区分 degraded / failed） | ✅ `status.json` |
| `reason` code | ✅ 见 README 原因码表 |
| `functionalProbe` | ✅ `pass` / `fail:<status\|error>` / `skipped` / `pending` |
| `sentinelId` | ✅ `route.sentinel`（`harness-N`）/ 同时给 `route.dispatcherIsOurs` |
| `jobObject` | ❌ `ctx.subprocess` 不暴露 Job 句柄参数 → E-04 按计划「以缺席证明」：强杀 DSH 后 `xray.exe` 必须消失 |
| `generation` | ✅ |
| `restarts.totalSinceReady` | ✅ `restarts`（自进程启动累计） |
| `portSource` | ⚠️ 固定为 `config`（插件不自动选端口） |
| `configHash` | ✅ 生成配置的 sha256 |
| `processAlive` 与 `pid` 分离 | ✅ |

## 控制面（v0.2 新增）

- 接管层级不变：仍是「运行期策略安装」，控制面只负责节点切换与统计，不改变流量入口。
- 节点切换通过 `RoutingService.OverrideBalancerTarget`（balancer 预置全部 outbound），**不**使用 `HandlerService.AddOutbound`，因此不需要在 Node 侧编码 `OutboundHandlerConfig`。
- 需要 Xray 2024-09+（v1.8.24+/v24.9+）；更老版本上 `control.reachable=false`，工具返回明确错误，代理本身继续工作。
- 工具（`xray_status` / `xray_switch_node` / `xray_stats`）是可选能力：`tools` 服务缺失时静默跳过，不影响代理。
- 设置页写入仍未实现：切换结果不持久化，重启回落到 `activeNode`。

## 与计划不一致而需要调整的用例

1. **设置页写入相关用例**：v1 没有客户端 UI，也没有 `ctx.settings` 集成；这类用例本期标 N/A（配置只走 `cordis.patch.yml`）。
2. **C 组端口自动分配**：本实现明确「占用即失败、不静默换端口」，用例预期应改为 `failed(port-busy)`。
3. **D 组重启**：退出码 23 / 端口占用 / 上游不可达均不重启；仅意外崩溃与连续健康失败重启（指数退避，上限 `maxRestarts`）。
4. **E 组优雅退出**：Windows 上不可得；判据为进程消失、端口可重新绑定、`status.json` 为 `stopped`。
