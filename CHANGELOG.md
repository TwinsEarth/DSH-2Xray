# Changelog

## 0.2.4 — 2026-10-29

### 设置页与导入

- **设置页新增「2Xray」标签页**（`settings.section`）：VLESS 链接输入、本地二维码图片选择、屏幕扫码、启用/takeover/xray 路径/端口，保存后重启生效。
- 插件页卡片 `plugins.item` 的 id 改为 settings namespace（`xray-proxy`），并按页面真实契约使用 `{ state, mutate }`；写冲突（mutate=false）会显式报错，不再假装保存成功。
- 左侧「2Xray」面板保持三卡片（配置/实时信息/状态）。

### 兼容

- 路由直连规则从 `geoip:private` 改为显式私有网段（10/8、172.16/12、192.168/16、127/8、169.254/16、::1、fc00::/7、fe80::/10），不再依赖 xray 二进制旁的 `geoip.dat`——v2rayN 自带的 xray.exe 可 `-test` 通过。

## 0.2.3 — 2026-10-29

### 界面

- 主面板改为三卡片：①当前 VPN 配置（节点下拉、协议/安全/SNI、切换节点）②实时连接信息（运行时长、代理端口、Xray PID、入站类型，日志可折叠）③连接状态（状态点、延迟、出口 IP、节点名）。
- 新增 `POST /api/xray/switch`（鉴权围栏）驱动节点切换；切换依赖控制面与多节点，单节点会返回明确错误。
- 状态快照补充 `inbound`、`uptimeSec`、节点 `security/serverName/flow/network`。

## 0.2.2 — 2026-10-29

### 新增

- **界面三段式重做**：左侧「2Xray」面板改为「当前 VPN 配置 / 实时连接日志 / 状态栏（延迟 · VPN 名称 · 出口 IP）」。
- **设置页卡片**：客户端注册 `plugins.item` 卡片（分享链接、启用、takeover、xray 路径、端口），解决 DSH 不会自动渲染表单的问题；侧边栏面板与设置卡片共用同一配置。
- **Host 状态通道**：`/api/xray/status`（经 `ctx.connection.fetch` 鉴权围栏）返回快照 + 日志环 + 延迟/出口 IP；日志 1000 条环缓冲、按 cursor 增量拉取。
- **延迟/出口探测**：经本地入站 absolute-form 请求，仅接管后运行，30s/10min TTL，单飞。

### 修复

- 功能探测失败不再杀进程：改为 `degraded(probe-failed)`，健康循环重试并自动接管。
- 默认探测目标从 gstatic 改为 `cp.cloudflare.com/generate_204`，避免大陆网络误判。
- `xray_status` 增加 `settingsSchema`，可远程确认宿主是否加载了设置表单 schema。

## 0.2.1 — 2026-10-29

### 修复

- **设置页仍不显示**：Schemastery 改为优先通过 `createRequire(import.meta.url)` / profile 锚点解析文件后动态 import，绕开宿主模块加载器对裸 specifier 的受限解析；加载结果写入 `xray_status.settingsSchema`，可远程确认表单是否具备渲染条件。
- **侧边栏入口优先注册**：先注册 `sidebar.panellist`，再注册主面板；主面板失败不再连带隐藏入口。

## 0.2.0 — 2026-10-29

### 新增

- **插件设置页表单**：导出 Schemastery `Config`，在 DSH 插件页可直接编辑启用开关、vless 分享链接、xray 路径、本地端口、takeover、功能探测与控制面开关；保存后写入 profile patch，重启 DSH 生效。高级配置（`nodes`、`routing`、`noProxy` 等）由 Schemastery 原样保留。
- **左侧菜单「2Xray」**：插件标签下方新增黑色地球图标入口，主面板内置二维码图片识别、屏幕共享扫码与链接复制。
- **二维码导入工具** `tools/scanner.html`：浏览器打开后可粘贴/复制链接、选择二维码图片、或共享屏幕实时扫码；优先用 `BarcodeDetector`，不可用时回退到内置 jsQR。

### 说明

- `Config` 的字段全部为 volatile；volatile-only 变更不会重挂插件，插件会记录「重启 DSH 后生效」。
- 设置页内的原生扫码按钮仍待客户端半边，当前扫码入口是 `tools/scanner.html`（结果复制回设置页）。

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
