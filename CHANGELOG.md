# Changelog

## 0.3.0 — 2026-10-29

### 更新中心

- 设置页「检测更新 / 立即更新 / 自动更新」：npm registry 检测、sha512 校验、tarball 原子替换、重启生效；自动更新默认关闭。
- Host 鉴权接口 `GET/POST /api/xray/update`，状态并入 `xray_status.update`。

### 分流与内核

- 路由模式 global / cn-direct / whitelist，cn-direct 使用 `IPIfNonMatch` + geodata 自动复制。
- 黑名单最优先并并入 `noProxy`；白名单仅 whitelist 模式生效。
- 按平台内核包（`optionalDependencies`，已发布 win32-x64）+ 官方 zip 构建脚本 + CI workflow。
- macOS 发现路径、特权端口回落、探测 URL 修复。

### 界面

- 三卡片面板、节点切换、日志默认展开、设置页 2Xray 标签页、VLESS 链接/本地二维码/屏幕扫码导入。

## 0.2.10 — 2026-10-29

### 更新

- 设置页新增「检测更新 / 立即更新 / 自动更新」。
- 检测：读取 npm registry 的 `latest` 并做 semver 比较。
- 立即更新：下载 tarball、校验 sha512（或 sha1）、解压并以 rename + 回滚方式替换插件目录；返回「重启 DSH 生效」。
- 自动更新：`updates.auto` 开启后，启动 5 秒检查并安装；默认关闭，不自动重启应用。
- 新增鉴权接口 `GET/POST /api/xray/update`，状态同时出现在 `xray_status.update`。

## 0.2.9 — 2026-10-29

### 内核分发

- 新增按平台拆分的可选内核包（`@twinsearth/dsh-2xray-core-<os>-<arch>`），主包通过 `optionalDependencies` 引用，npm 只装当前平台。
- `resolveBinary()` 新增 `core-package` 来源；未安装时继续回退到插件 `bin/`、数据目录、v2rayN 发现与 PATH。
- 新增 `tools/build-core-packages.mjs`（官方 zip → npm 包）与 `.github/workflows/core-packages.yml`（下载、`.dgst` 校验、发布；无 `NPM_TOKEN` 时只上传 artifact）。

### 验证

- 真机 xray 26.9.30 对 global / cn-direct / whitelist 三种配置执行 `run -test` 全部通过（含 geodata 与 IPIfNonMatch）。

## 0.2.8 — 2026-10-29

### 修复

- `cn-direct` 模式设置 `routing.domainStrategy: IPIfNonMatch`：未被 `geosite:cn` 命中的域名会解析为 IP 再匹配 `geoip:cn`，国内站点不再漏判。
- `XRAY_LOCATION_ASSET` 显式传入 `run` 与 `run -test` 的 spawn 环境：服务启动器会清理环境，之前 geodata 路径可能丢失，导致 `geoip:cn`/`geosite:cn` 静默失效。
- 启动与 `xray_validate_config` 前都先复制 `geoip.dat`/`geosite.dat` 到数据目录；缺失时日志明确告警。

## 0.2.7 — 2026-10-29

### 新增

- **路由模式**：`global` / `cn-direct`（国内 IP、域名直连）/ `whitelist`（仅白名单走 2Xray）。
- **黑白名单**：白名单默认 github.com、google.com、youtube.com、x.com、facebook.com；黑名单默认 deepseek.com、api.deepseek.com。黑名单优先，并并入 `noProxy`。
- **内核安装脚本** `tools/install-xray-core.mjs`：官方 release + `.dgst` SHA2-256 校验 + 解压到数据目录。
- 侧边栏「实时连接信息」默认展开日志。

### 修复

- macOS 自动发现补充 `~/Library/Application Support/v2rayN`、`/Applications` 等路径。
- 路由验证 URL 改为保留域 `dsh-2xray-verify.invalid`，不再被 `noProxy: deepseek.com` 绕过（route-instance-mismatch 根因）。
- 非 Windows 下入站端口 <1024 自动回落到 20808（避免把远端 556 当本地端口导致 EACCES）。

## 0.2.6 — 2026-10-29

### 内置浏览器支持

- 新增 `tools/launch-with-browser-proxy.cmd`：以 `--proxy-server=http://127.0.0.1:20808` 启动 DSH，让内置 Chromium 浏览器也走插件的 xray。
- 设置页与插件页卡片增加说明：Node 插件无法在运行时修改 Chromium 的 session 代理，必须带启动参数重启；系统代理/TUN 是另一条全机路径。
- 保留边界：插件仍只接管 DSH 进程内的 undici fetch。

## 0.2.5 — 2026-10-29

### 修复

- **binary-missing 自动恢复**：未配置 `binary.path` 时，会按 `V2RAYN_HOME/V2RAYN_PATH`、`%LOCALAPPDATA%`、桌面/下载、Program Files、盘符根目录做有界搜索（只进入名字含 v2ray 的目录，3s 预算），识别 v2rayN 7.x 的 `bin/xray/xray.exe` 并直接借用。
- 找不到时错误信息仍列出显式候选与 PATH，便于诊断。

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
