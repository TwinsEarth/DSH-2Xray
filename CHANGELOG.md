# Changelog

## 0.1.1 — 2026-10-29

### 修复

- 插件启用时报 `cannot get property "subprocess" without inject`：Cordis 会拦截未声明 `inject` 的服务属性读取。改为 `ctx.get('subprocess')` 反射查询，并把 launcher 改为首次 spawn 时惰性解析；服务晚挂载或缺失时分别使用服务 / `child_process` 兜底，不再阻断启用。

## 0.1.0 — 2026-10-29

首个发布版本（npm：`@twinsearth/dsh-2xray`）。

### 核心能力

- **xray-core 进程托管**：优先 `ctx.subprocess`（Windows Job Object），缺失时退化为 `child_process`；固定端口、占用即失败、不静默换端口。
- **进程内流量接管**：调用 DSH 的 `@deepseek-ai/dsh-http-proxy` 策略入口 `installProxyFromEnvironment()`，让全局 `fetch` 与 `web_fetch` 读取同一份策略；不可用时退回内置 undici dispatcher 并显式标记 `web_fetch` 未覆盖。
- **就绪门禁**：TCP 可连 → 经代理 204 功能探测 → 才安装 dispatcher；停止时先摘路由再 terminate。
- **状态机**：`idle/resolving/starting/ready/degraded/backoff/failed/stopped`，写入 `status.json`（0600，不含密钥）；退出码 23 与端口占用不自动重启。
- **VLESS + XTLS Vision + REALITY**：字段级校验（flow×security 组合、shortId、base64url 公钥、回环入站），`connIdle=600` 避免干净 FIN 导致的 `STREAM_CLOSED`。
- **多节点与运行时切换**：预置全部 outbound + balancer，切换走 `RoutingService.OverrideBalancerTarget`，不重启进程；零依赖 gRPC（`node:http2` + 手写 protobuf）。
- **模型工具**：`xray_status`、`xray_validate_config`、`xray_switch_node`、`xray_stats`（`ctx.inject(['tools'])` 可选注册）。
- **配置导入**：`vless://` 分享链接（`shareLink` / `shareLinks`）解析，支持二维码里同样的文本；`vmess/trojan/ss` 明确报不支持。

### 验证

- 单元测试 96/96（`node --test --test-isolation=none test/*.test.js`）。
- 真实 DSH 运行时：`fetch` 经代理（absolute-form）、回环直连（origin-form）、恢复后回到直连。
- 真实 xray 1.4.5：`StatsService.QueryStats` 调用成功；`RoutingService` 返回 `12 unknown service`（版本边界，需 2024-09+）。

### 已知限制

- 未与 Xray v26 真实二进制、真实服务端做过端到端验收；REALITY 字段靠源码规格保证。
- 设置页（含扫码导入）未实现；配置通过 `cordis.patch.yml`。
- 不下载 xray 二进制；可由发布物自带 `bin/xray`，但受 MPL-2.0 约束。
- builtin/SOCKS 模式下 `web_fetch` 不在接管范围。
