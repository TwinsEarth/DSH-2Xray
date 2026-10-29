# DSH-2Xray

一个 DSH bundle 插件，扮演 **xray-core 进程管理者 + 进程内流量路由者** 的双重角色：

1. 生成 xray-core 客户端配置，启动并守护 `xray` 子进程；
2. 在 xray 本地入站**通过真实探测之后**，把 DSH 进程的全局 HTTP(S) 出口接到该入站；
3. 可选：通过零依赖 gRPC 控制面做多节点运行时切换与流量统计。

```
apply(ctx, config)
   │
   ├─ config.js        配置归并 + 字段级校验（失败不进 failed 以外的状态）
   ├─ xray-config.js   纯函数：多节点 outbound + balancer + VLESS Vision REALITY
   ├─ supervisor.js    状态机：启动 → 探活 → 接管 → 守护 → 回收/退避
   │    ├─ binary.js   解析 xray（插件 bin/ → 数据目录 → PATH）、探测版本
   │    ├─ process.js  ctx.subprocess（Windows Job Object）/ child_process 兜底
   │    ├─ health.js   TCP 探活 + 经代理的功能探测
   │    ├─ route.js    与 DSH 代理策略层协作，或内置 undici dispatcher 兜底
   │    └─ control/    零依赖 gRPC 控制面（HTTP/2 + 手写 protobuf）
   ├─ tools.js         xray_status / xray_switch_node / xray_stats（可选）
   └─ paths.js         数据目录、原子写、哈希（只记录配置哈希，不记录密钥）
```

## 关键设计决策（以及为什么不是骨架里的写法）

| 主题 | 结论 | 原因（已在 DSH 0.2.1-rc.3 上核实） |
|---|---|---|
| 全局接管方式 | **调用 `@deepseek-ai/dsh-http-proxy` 的 `installProxyFromEnvironment()`**，不自己 `setGlobalDispatcher()` | DSH 在第一个插件挂载前就装好了策略 dispatcher；`web_fetch` 只问 `proxyRouteFor()`。裸装 dispatcher 会造成「模型 API 进代理、web_fetch 仍直连」的双源真值分裂。 |
| 入站协议 | 默认 **HTTP**，SOCKS 只作为可选附加 | DSH 代理策略明确拒绝 `socks5://` URL（诊断为 “connecting directly”）。SOCKS 只能靠内置 dispatcher，且失去 `web_fetch` 覆盖。 |
| 清理钩子 | `ctx.effect(() => disposer)`，`apply` 返回它 | Cordis 没有 `ctx.on('dispose')`；`ctx.effect` 与 `apply` 返回值才是生命周期 seam。 |
| 子进程 | 优先 `ctx.subprocess` | Windows 上是 Job Object（`KILL_ON_JOB_CLOSE`）。Electron 关闭时对运行时发 `SIGTERM` ≈ `TerminateProcess`，cordis dispose 可能根本不执行；没有 Job Object 就会留下孤儿 xray 占着端口。 |
| 就绪顺序 | **先起进程 → TCP 探活 → 功能探测 → 才接管** | 反过来会出现「dispatcher 指向尚未监听的端口」，整个 DSH 的 fetch 全部 `ECONNREFUSED`。 |
| 停止顺序 | **先摘路由 → 再 terminate → 等退出** | 反过来存在「进程已死、dispatcher 还指着它」的窗口。 |
| 端口 | 固定端口 + 占用即失败，**不静默换端口** | 换端口后 DSH 仍指向旧端口，表现为持续 `ECONNREFUSED`，且用户无从判断。 |
| 多节点切换 | 预置全部 outbound + balancer + `RoutingService.OverrideBalancerTarget` | `HandlerService.AddOutbound` 要传 protobuf 编码的 `OutboundHandlerConfig`（TypedMessage sender/proxy settings）；override 只传两个字符串，是最小可靠面。 |
| 控制面实现 | 零依赖：`node:http2` + 手写 protobuf 编解码 | 为一个 balancer 切换 + 统计查询给每个 profile 装 `@grpc/grpc-js` + proto-loader 不划算，也扩大供应链面。 |
| 重启 | 只对「意外崩溃」退避重启 | 退出码 23（配置错）不重启；端口占用不重启；上游不可达不重启 xray（进程是健康的）。 |
| 工具注册 | `ctx.inject(['tools'])` 可选注册 | 若声明 `inject = ['tools','settings']`，缺少任一服务的 profile 会整行不激活；代理本身不应该被工具可用性拖累。 |

## 安装

插件是一个 **Host-only bundle**，无需构建；除控制面外无运行时依赖。

1. 安装：`npm i @twinsearth/dsh-2xray` 后由插件管理器启用；或在 DSH 插件页选择「从目录安装」，指向 `E:\GPT\dsh-2xray`。
2. 把 xray 可执行文件放到下面任一位置（按解析优先级）：
   - 插件自己的 `bin/xray(.exe)`（随 bundle 分发时用；见 [bin/README.md](bin/README.md) 的 MPL-2.0 说明）
   - 配置 `binary.path`
   - 环境变量 `DSH_XRAY_BIN`
   - `<DSH_HOME>\xray-proxy\bin\xray.exe`（`DSH_HOME` 默认 `%USERPROFILE%\.dsh`）
   - 放进 `PATH`
3. 编辑 profile 的 `cordis.patch.yml`（或 bundle 默认配置），填入 `server.*` 或 `nodes[]`，把 `enabled` 改成 `true`，重启 profile。

bundle 自带的 `cordis.patch.yml` 默认 `enabled: false`，避免安装即报错；它是**整块配置**，profile 层覆盖时必须重述要保留的字段。注册行的 `name` 必须等于包名（`@twinsearth/dsh-2xray`），否则 patch 会按「name mismatch」跳过。

```yaml
- id: xray-proxy
  name: '@twinsearth/dsh-2xray'
  config:
    enabled: true
    server:
      address: example.com
      port: 443
      uuid: 00000000-0000-0000-0000-000000000000
      flow: xtls-rprx-vision
      serverName: www.example.com
      password: REPLACE_WITH_43_CHAR_BASE64URL_X25519_PUBLIC_KEY
      shortId: ''
      fingerprint: chrome
      spiderX: /
    inbound:
      protocol: http
      host: 127.0.0.1
      port: 20808
    takeover: auto
```

## 配置参考

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关 |
| `server.address` | — | 服务端域名或 IP（旧版单节点写法；多节点用 `nodes`） |
| `server.port` | `443` | 服务端端口 |
| `server.uuid` | — | VLESS uuid；非标准 UUID 但 ≤30 字节也可 |
| `server.flow` | `xtls-rprx-vision` | `""` / `xtls-rprx-vision` / `xtls-rprx-vision-udp443`；非空时 network 必须是 raw/tcp 且 security 必须是 reality/tls（`-test` 不校验，插件静态拦截） |
| `server.serverName` | — | REALITY/TLS 的 SNI |
| `server.password` | — | REALITY 公钥（当前字段名），43 字符 base64url |
| `server.publicKey` | — | REALITY 公钥旧字段名；与 `password` 同时写可跨版本，至少提供一个 |
| `server.shortId` | `""` | 偶数长度 hex，≤16 字符 |
| `server.fingerprint` | `chrome` | uTLS 指纹 |
| `server.spiderX` | `/` | 以 `/` 开头 |
| `server.network` | `raw` | `raw` / `tcp`（后者归一为 raw） |
| `server.security` | `reality` | `reality` / `tls` / `none` |
| `nodes` | `[]` | 节点数组；与 `server.*` 二选一。每项支持 `id`/`tag` 与全部 `server.*` 字段 |
| `shareLink` | `""` | 粘贴一条 `vless://` 分享链接（二维码里就是这段文本），解析后追加为节点 |
| `shareLinks` | `[]` | 多条分享链接；优先于 `shareLink`，与显式 `nodes` 合并（显式节点在前） |
| `activeNode` | 第一个节点 | 启动时钉住的 node id 或 outbound tag |
| `inbound.protocol` | `http` | `http` 或 `socks`；socks 只建议给非 Node 客户端 |
| `inbound.host` | `127.0.0.1` | 只允许回环地址 |
| `inbound.port` | `20808` | 本地入站端口 |
| `inbound.socks.enabled` | `false` | 额外开 SOCKS 入站 |
| `inbound.socks.port` | `20809` | 不能与 HTTP 入站相同 |
| `inbound.socks.udp` | `false` | undici 只实现 SOCKS CONNECT，开启只服务其它程序 |
| `takeover` | `auto` | `auto`：已有代理策略时不覆盖；`force`：强制覆盖；`off`：只起 xray 不接管 |
| `control.enabled` | `false` | 开启 gRPC 控制面（`api` 入站 + services） |
| `control.host` / `control.port` | `127.0.0.1` / `10085` | 只允许回环；端口不能与任何入站冲突 |
| `control.services` | Handler/Stats/Routing | 传给 xray 的 `api.services` |
| `control.stats` | `true` | 打开 `stats` 与 `policy.system` 流量计数 |
| `control.balancerTag` | `active` | 多节点 balancer 的 tag，也是切换目标 |
| `control.timeoutMs` | `3000` | 每次 gRPC 调用超时 |
| `noProxy` | `""` | 追加的 bypass 列表（回环由 DSH 强制加入）；不支持 CIDR |
| `routing.bypassDomains` | 内网后缀 | 直连域名后缀列表，数组或逗号串 |
| `routing.blockAds` | `false` | 加 `geosite:category-ads-all` → block |
| `routing.geositeCn` | `false` | 国内域名直连（需要 geosite 数据） |
| `binary.path` | `""` | 显式 xray 路径 |
| `binary.dataDir` | `""` | 数据目录；默认 `<DSH_HOME>/xray-proxy` |
| `lifecycle.startTimeoutMs` | `15000` | 端口就绪预算 |
| `lifecycle.stopGraceMs` | `3000` | 终止宽限（也是 `ctx.subprocess` 的 graceMs） |
| `lifecycle.maxRestarts` | `5` | 崩溃重启上限，超过进 `restart-exhausted` |
| `lifecycle.backoffMs` / `backoffMaxMs` | `500` / `30000` | 指数退避 |
| `lifecycle.healthIntervalMs` | `30000` | 周期健康探测；`0` 关闭 |
| `lifecycle.unhealthyThreshold` | `3` | 连续失败后回收进程 |
| `functionalProbe.enabled` | `true` | 经本地入站请求一次 204；这是唯一能证明 uuid/flow/SNI/REALITY 全链路可用的检查 |
| `functionalProbe.url` | `http://www.gstatic.com/generate_204` | 探测目标 |
| `functionalProbe.timeoutMs` | `5000` | 探测超时 |
| `log.level` | `warning` | 传给 xray 的 `loglevel`；访问日志固定 `none` |

## 多节点与 gRPC 控制面

`nodes[]` 与 `server.*` 二选一：前者为每个节点生成一个 outbound + 一个 balancer；后者保持单节点旧行为，配置字节不变。

```yaml
- id: xray-proxy
  name: '@twinsearth/dsh-2xray'
  config:
    enabled: true
    activeNode: hk-01            # node id 或 outbound tag
    nodes:
      - id: hk-01
        address: hk.example.com
        port: 443
        uuid: 11111111-2222-4333-8444-555555555555
        flow: xtls-rprx-vision
        serverName: www.example.com
        password: REPLACE_WITH_43_CHAR_BASE64URL_X25519_PUBLIC_KEY
        shortId: ''
      - id: jp-01
        address: jp.example.com
        port: 443
        uuid: 11111111-2222-4333-8444-555555555555
        flow: xtls-rprx-vision
        serverName: www.example.com
        password: REPLACE_WITH_43_CHAR_BASE64URL_X25519_PUBLIC_KEY
        shortId: ''
    control:
      enabled: true
      port: 10085
      stats: true
```

启动顺序：写配置 → 起进程 → TCP 就绪 → 204 功能探测 → 接管 dispatcher → `OverrideBalancerTarget(activeNode)` 钉住出口。切换节点只改 balancer override，进程、入站、dispatcher 都不动。

模型可调用的工具（`ctx.tools.register` + 从安装目录加载 `@deepseek-ai/dsh-tools` 的 `defineTool`）：

| 工具 | 作用 | 依赖 |
|---|---|---|
| `xray_status` | 与 `status.json` 相同的状态快照 | 无 |
| `xray_validate_config` | 用 `xray run -test` 预检当前配置；不启动/不重启进程；返回 { ok, reason, detail, configHash } | 无 |
| `xray_switch_node` | `{node}` → 钉住指定 outbound | `control` + `RoutingService` |
| `xray_stats` | 每节点累计上下行字节；`{reset:true}` 读后清零 | `control` + `StatsService` + `stats` |

**版本要求：Xray 2024-09 之后的版本（v1.8.24+ / v24.9+）。** 本机 1.4.5 实测 `RoutingService` 返回 `12 unknown service`，而 `StatsService` 在 1.4.5 已可用。版本过老时插件仍正常启动，切换工具会给出可读诊断并把 `status.control.reachable` 置为 `false`。

注意：

- override 只存在于 xray 进程内存，重启后由插件按 `activeNode` 重新钉住；切换结果不写回配置（持久化需要设置页 `ctx.settings`，尚未实现）。
- API 入站只绑 `127.0.0.1`，但**无认证**：本机任意进程可查统计或切节点。需要更强隔离时用随机端口，或关闭 `control.enabled` 只保留静态多出站。
- `stats` 计数器是**自进程启动以来的累计值**，不是速率；速率需要调用方自行差分。

## 界面入口：设置页 + 左侧 2Xray 面板

v0.2.0 提供两个入口，互不替代：

1. **插件设置页**（设置 → 插件 → Xray 代理）：Schemastery 表单，可编辑
   `启用`、`分享链接 (vless://)`、`xray 路径`、`本地端口`、`takeover`、`功能探测`、`控制面`。
   保存后写入 profile patch，**重启 DSH 生效**。
2. **左侧菜单「2Xray」**（插件标签下方，黑色地球图标）：内含
   二维码图片识别、屏幕共享扫码、链接复制；识别后复制到设置页的「分享链接」保存。

```
设置 → 插件 → Xray 代理    ← 粘贴 / 保存 / 开关
左侧 2Xray（地球图标）     ← 扫码 / 复制
```

> 浏览器没有 `BarcodeDetector` 时（部分 Windows Chrome），左侧面板会提示；
> 可改用插件目录里的 `tools/scanner.html`（内置 jsQR 兜底），再把链接粘回设置页。

## 配置导入：分享链接 / 二维码

三种入口最终都归约为同一段 `vless://` 文本，所以解析器只有一份（[lib/share-link.js](lib/share-link.js)），UI 只负责把文本拿到手。

| 方式 | 状态 | 实现 |
|---|---|---|
| 粘贴分享链接 | ✅ Host 侧已实现 | `shareLink: "vless://..."`，或 `node scripts/parse-share-link.mjs "<link>"` 生成 `nodes` JSON |
| 扫描屏幕二维码 | ⏳ 待设置页 | 浏览器 `getDisplayMedia()` 取帧 + `BarcodeDetector`（Chromium）或 jsQR 兜底 |
| 扫描图片二维码 | ⏳ 待设置页 | `<input type="file">` + `createImageBitmap()` + 同一个解码器 |

```yaml
- id: xray-proxy
  name: '@twinsearth/dsh-2xray'
  config:
    enabled: true
    # 支持标准 Xray/v2rayN 导出格式：
    # vless://uuid@host:443?security=reality&sni=...&fp=chrome&pbk=...&sid=...&spx=%2F&flow=xtls-rprx-vision#Hong%20Kong
    shareLink: "vless://11111111-2222-4333-8444-555555555555@hk.example.com:443?security=reality&sni=www.example.com&fp=chrome&pbk=REPLACE_43_CHARS&sid=ab12&spx=%2F&flow=xtls-rprx-vision&type=tcp#Hong%20Kong"
    control:
      enabled: true
```

解析规则：

- `#` 片段名 → 节点 `id`（如 `Hong Kong` → outbound tag `proxy-Hong_Kong`），可用作 `activeNode`。
- `sni` → `serverName`；`pbk` → `password` 与 `publicKey` 双写（跨版本兼容）；`sid` → `shortId`；`fp` → `fingerprint`；`spx` → `spiderX`。
- `security=none` 时清空 flow/SNI/shortId；`type=tcp` 归一为 `raw`。
- `vmess://` / `trojan://` / `ss://` 会明确报「暂不支持」，而不是生成一个 Xray 会拒绝的配置——当前 builder 只产出 VLESS 出站。

**订阅分组（订阅 URL 拉取多节点）未实现。** 它是独立的网络动作（SSRF、重定向、离线缓存、订阅格式），建议单独设计，不与本地导入混在一起。

扫码能力依赖浏览器设置页（`dsh.client` + `configForms`/`slots`），当前仓库是 Host-only，所以只有链接字段与 CLI 可用。

## 状态机与失败原因码

对外状态：`idle` → `resolving` → `starting` → `ready`；异常路径为 `degraded` / `backoff` / `failed` / `stopped`。

状态快照写入 `<dataDir>/status.json`（0600，不含密钥），字段包括：

`state`、`reason`、`detail`、`generation`、`restarts`、`port`、`binary{path,source,version}`、`process{pid,alive,exitCode,stderrTail}`、`route{installed,mode,proxy,webFetchCovered,sentinel,dispatcherIsOurs}`、`nodes[]`、`activeNode`、`control{enabled,reachable,activeTarget,lastError}`、`functionalProbe`、`configHash`、`startedAt`、`updatedAt`。

原因码：

| reason | 含义 | 是否自动重启 |
|---|---|---|
| `disabled` | `enabled: false` | — |
| `config-invalid` | 字段校验失败（detail 带字段名） | 否，改配置后重载 |
| `binary-missing` / `binary-unusable` | 找不到 xray，或 `xray version` 不能运行 | 否 |
| `config-write-failed` | 数据目录不可写 | 否 |
| `port-busy` | 入站端口被占用 | 否（不换端口） |
| `config-rejected` | `xray run -test` 失败，或运行中以退出码 23 退出 | 否 |
| `start-timeout` | 进程活着但端口未监听 | 否 |
| `functional-probe-failed` | 入站通了但经代理的请求失败 | 否 |
| `route-install-failed` | xray 健康，但策略安装失败 → `degraded` | 进程保留 |
| `external-proxy-active` | `takeover: auto` 检测到启动器已有代理 → `degraded` | — |
| `crashed` | 运行中意外退出 → `backoff` | 是，指数退避 |
| `unhealthy` | 连续健康探测失败，回收后重启 | 是 |
| `restart-exhausted` | 超过 `maxRestarts` | 否 |
| `disposed` | 插件卸载/DSH 退出 | — |

## 覆盖矩阵

| 流量 | 是否经 xray |
|---|---|
| 模型 API（`globalThis.fetch`，含 SSE） | ✅ |
| `web_fetch` | ✅（harness 模式）；❌ builtin/SOCKS 模式（已知缺口） |
| `web_search`、MCP HTTP、账号登录、第三方插件 fetch | ✅ |
| 回环地址（DSH Web UI、本地服务） | ❌ 强制直连（DSH 策略内置，插件不重复实现） |
| `noProxy` 命中的域名 | ❌ |
| 内网 IP / `geoip:private` | ❌ 由 Xray routing 直连 |
| Electron 更新检查、内嵌视图（Chromium 网络栈） | ❌ |
| `ws` 远程访问 / api-gateway | ❌ 自行建连，不走 undici |
| OTLP 遥测（`node:http`） | ❌ |
| worker / PTC 脚本 | ❌ 宿主刻意不注入 |
| bash/curl/git 子进程 | ⚠️ 接管后，DSH 从当前策略派生子进程 overlay，新起的子进程会拿到无认证的 `http://127.0.0.1:<port>`；是否生效取决于该程序是否读 `HTTP_PROXY` |

## 安全

- 生成的 xray 配置含 uuid 与 REALITY 公钥，写入 `<dataDir>/conf/xray-config.json`，POSIX 权限 0600、目录 0700；Windows 上 ACL 继承用户目录，插件不做 `icacls` 收紧（已知边界）。
- 只记录 `configHash`，不记录配置内容；错误信息只带 stderr 尾部。
- 入站只允许回环地址；`inbound.host: 0.0.0.0` 会被校验拒绝。
- 凭据不写进 `process.env`：`installProxyFromEnvironment` 收到的代理 URL 是无认证的 `http://127.0.0.1:<port>`。
- 控制面 API 无认证（仅回环）；高隔离场景请关闭或换随机端口。

## 已知限制

1. **builtin/SOCKS 模式不覆盖 `web_fetch`**（它会自建 pinned-IP Agent）。默认 HTTP + harness 模式没有这个缺口。
2. **没有设置页 UI**：v1 通过 `cordis.patch.yml` 配置。要做表单需走 `ctx.settings` + Schemastery + `configForms`，且可编辑字段必须是 volatile。
3. **不下载 xray**：插件可以携带 `bin/xray`，但从不联网下载；供应链（版本、哈希、签名）留给发布流程。
4. **重启会打断在途流**：Windows 上 `taskkill /F` 无法 drain；DSH 会看到 `TRANSPORT` 重试，或干净 FIN 导致的 `STREAM_CLOSED`（默认不重试）。xray `connIdle` 已设为 600s，尽量让 DSH 的 300s 空闲看门狗先触发。
5. **端口变化必须重启 DSH**：插件不改端口，也不在运行中重装策略。
6. **多实例**：每个 DSH profile 独立端口/配置；没有跨实例锁，端口冲突会明确报 `port-busy`。
7. **控制面依赖较新 Xray**：`RoutingService` 需要 2024-09 之后的版本；更老的版本只有 `StatsService`。失败时插件不崩溃，但切换工具不可用。
8. **API 无认证**：只绑回环，但本机任意进程都能调用。高隔离场景请关闭 `control.enabled` 或换随机端口。
9. **切换不持久化**：`xray_switch_node` 只改进程内 override，重启后回到 `activeNode`；写回配置需要设置页/`ctx.settings`（未实现）。

## 验证结果（诚实边界）

已执行：

| 项 | 结果 |
|---|---|
| 单元测试 `node --test --test-isolation=none test/*.test.js` | **96/96 通过**（配置校验、单/多节点配置生成、分享链接解析、二进制解析优先级、路由安装/回滚/幂等、状态机启动/崩溃重启/退出码 23/端口占用/停止顺序/启动竞态、protobuf 编解码、gRPC 客户端对 mock h2 服务、工具注册与调用） |
| 真实运行时加载（`ELECTRON_RUN_AS_NODE=1 "E:\DS\DeepSeek Harness.exe"`） | 插件入口可导入；`ctx.effect` 注册与 dispose 正常；`state=idle → stopped` |
| 真实运行时路由探针（`scripts/probe-routing.mjs`） | 通过 `createRequire` 解析到安装目录里的 `@deepseek-ai/dsh-http-proxy`；`installProxyFromEnvironment` 安装成功；`fetch` 实测经假代理（absolute-form 请求行）、回环地址直连（origin-form）、`restore()` 后回到直连（ENOTFOUND） |
| 工具层解析 | `@deepseek-ai/dsh-tools` 同样从安装目录解析成功，`defineTool` 生成合法参数 schema |
| 真实 xray gRPC 探针 | 启动本机 xray 1.4.5 的 API 入站后，插件的零依赖客户端成功调用 `StatsService.QueryStats` 并解码出 inbound 计数；`RoutingService` 按预期返回 `12 unknown service` |
| 多节点配置结构校验 | 2 节点 + balancer + API 入站 + stats 的配置，被本机 xray 1.4.5（降级 stream 后）判为 `Configuration OK.` |
| xray 配置结构校验 | 单节点同款做法通过，证明 inbound/outbound/routing/policy 骨架合法 |

**未验证（必须在目标机执行）**：

- 与 Xray v26.10.x 真实二进制的 `run -test`（REALITY `password`、`network: raw` 字段只能靠源码规格保证）；
- 多节点 `OverrideBalancerTarget` 在支持 `RoutingService` 的真实版本上的端到端切换（本机 1.4.5 没有该服务）；
- 真实服务端的端到端连通（uuid/flow/SNI/shortId/公钥）；
- Windows Job Object 在强杀 DSH 后的 xray 清理；
- `web_fetch` 实抓流量与 `proxyRouteFor()` 的一致性；
- 验收测试计划中的 83 条用例（见仓库根目录 `DSH-XRAY-PROXY-ACCEPTANCE-TEST-PLAN.md`）。

## 排障

| 现象 | 处理 |
|---|---|
| `binary-missing` | 把 `xray.exe` 放进插件 `bin/`、`<DSH_HOME>\xray-proxy\bin\`，或设 `binary.path` |
| `config-rejected`，detail 含 `encryption` | 检查生成的配置未被手工改坏；`users[0].encryption` 必须为 `"none"` |
| `config-rejected`，detail 含 `password` | 用 `xray x25519` 重新生成，确认 43 字符 base64url |
| `functional-probe-failed` | 先用 `curl -x http://127.0.0.1:20808 https://example.com -v` 手工验证；确认服务端参数；离线环境可临时设 `functionalProbe.enabled: false` |
| `port-busy` | 释放端口（可能有上次残留的 xray），或改 `inbound.port` 后重启 DSH |
| `external-proxy-active` | 启动环境里已有 `HTTP(S)_PROXY`；需要覆盖时设 `takeover: force` |
| 模型请求突然 `ECONNREFUSED` | 查看 `status.json` 的 `state/reason`；若 `backoff`，等待重启或修复配置 |
| 状态一直 `degraded` + `route-install-failed` | 查日志里的模块解析诊断；必要时确认 DSH 安装目录结构 |
| `xray_switch_node` 报 `unknown service ... RoutingService` | xray 版本早于 2024-09；升级二进制，或关闭 `control.enabled` 只用 `activeNode` |

### 平台内核包

`@twinsearth/dsh-2xray` 通过 `optionalDependencies` 引用按平台拆分的核心包（例如 `@twinsearth/dsh-2xray-core-win32-x64`），npm 只安装当前平台那一个。本地没有可用内核包时，仍按 `插件 bin/ → 数据目录 → v2rayN 发现 → PATH` 回退，或用 `tools/install-xray-core.mjs` 安装。

维护者用 `tools/build-core-packages.mjs` 从官方 zip 生成平台包；`.github/workflows/core-packages.yml` 会在具备 `NPM_TOKEN` secret 时自动下载、校验并发布各平台包。

## 健康检查

- 进程内（需 DSH 会话鉴权）：`GET /api/xray/healthz` → `{ "ok": true, "version": "v0.3.3", ... }`
- 发布物（公开、静态）：Release 资产 `healthz.json`，`version` 与 tag 一致，可用于部署流水线的健康探针。

## 更新

设置页 2Xray 里有三个入口：

- **检测更新**：查询 npm 上的 `latest`，显示当前/最新版本。
- **立即更新**：下载并校验 npm tarball（sha512），原子替换插件目录；**重启 DSH 后生效**。
- **自动更新**：启动 5 秒后检查并安装新版本（默认关闭；同样需要重启）。

Host API：`GET/POST /api/xray/update`（走 `ctx.connection.fetch` 鉴权围栏）。

## 路由模式与黑白名单

- `global`（默认）：全部流量走 2Xray。
- `cn-direct`：`geoip:cn` / `geosite:cn` 直连，其余走代理。插件会从 xray 二进制旁复制 `geoip.dat`/`geosite.dat` 到数据目录，并设置 `XRAY_LOCATION_ASSET`。
- `whitelist`：仅白名单域名走 2Xray，其余直连。

黑名单优先于白名单与分流，并会同时加入 DSH 的 `noProxy`（xray 重启时也不受影响）。默认白名单：github.com、google.com、youtube.com、x.com、facebook.com；默认黑名单：deepseek.com、api.deepseek.com。

## 内核安装（macOS / Linux）

npm 包不内嵌五平台内核。未找到内核时：

```bash
node tools/install-xray-core.mjs 26.9.30
```

脚本下载官方 release 资产、校验 `.dgst` 的 SHA2-256、解压到 `~/.dsh/xray-proxy/bin/`。GitHub 不可达时设置 `DSH_XRAY_MIRROR` 指向镜像。macOS 也会自动搜索 `~/Library/Application Support/v2rayN/bin/xray/xray`。

## 内置浏览器（Chromium）

DSH 内置浏览器走 Chromium 网络栈，不读 undici dispatcher，插件无法在运行时改它的代理。支持方式只有启动参数：

```powershell
& "E:\DS\DeepSeek Harness.exe" --proxy-server=http://127.0.0.1:20808
```

或运行 `tools/launch-with-browser-proxy.cmd`（自动查找 DSH 路径并透传 `--proxy-server`）。

**必须先完全退出 DSH**：单实例再次启动只会聚焦旧窗口，不会应用参数。系统代理/TUN（v2rayN）也能让 Chromium 生效，但那是全机代理，与本插件无关。

## 开发

```powershell
cd E:\GPT\dsh-2xray
node --test --test-isolation=none test/*.test.js
```

> 在受限沙箱里不要用 `node --test test/`：它按文件 `spawn` 子进程并使用管道，会被拒绝（EPERM）；`--test-isolation=none` 在进程内运行。

可复跑的验证脚本：

| 脚本 | 用途 |
|---|---|
| `scripts/check-config.mjs` | 用真实 xray 二进制校验生成的配置；`--legacy` 兼容 1.8 之前的 `tcp` 命名 |
| `scripts/probe-routing.mjs` | 在 DSH 运行时验证「fetch 被接管 / 回环直连 / restore 后恢复」 |

完整证据与未验证项见 [docs/EVIDENCE.md](docs/EVIDENCE.md)；验收闸门 0 的接管方式声明见 [docs/AC-0.md](docs/AC-0.md)。
