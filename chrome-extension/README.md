# 2Xray for Chrome

自 **0.7.0** 起与 [DSH-2Xray](https://github.com/TwinsEarth/DSH-2Xray) 同版本发布（双版本）；0.8.0 起与 DSH **0.2.2-rc.1** 对齐。它是 DSH-2Xray 的浏览器伴侣扩展（Manifest V3），把 **Chrome 的流量**接到本地 Xray 的 HTTP/SOCKS 入站，并提供与 DSH 插件一致的三卡片视图、路由分流、VLESS 链接/二维码导入和 Xray 配置生成。

> 扩展只接管 **Chrome 浏览器**的流量。Xray 进程本身仍由 [DSH-2Xray](https://github.com/TwinsEarth/DSH-2Xray) 插件、v2rayN 或其他客户端提供——浏览器扩展没有启动/停止本机进程的权限。

```
Chrome  ──PAC/fixed proxy──▶  127.0.0.1:20808 (Xray HTTP inbound)
                                   │
                            VLESS + REALITY / TLS
                                   │
                              远端节点
```

## 功能

| 模块 | 说明 |
|---|---|
| ① 连接状态 | 开关、本地入站、分流模式、延迟、出口 IP/地区、最近检测时间 |
| ② 当前节点 | 解析 `vless://`、展示 REALITY/TLS 字段、生成分享二维码、一键复制 |
| ③ 路由与日志 | 全局 / 白名单 / CN 直连三种 PAC 模式、黑白名单、最近 100 条事件日志 |
| 二维码 | 从图片解码（BarcodeDetector + jsQR 兜底）、摄像头扫码、显示当前节点二维码 |
| 配置生成 | 生成独立 xray-core JSON（VLESS outbound + 本地 inbound + 与 PAC 一致的路由），可下载/复制 |
| 数据 | 设置导出/导入（JSON）、恢复默认、定时探测 |
| 快捷键 | `Alt+Shift+X` 开关代理；工具栏图标显示 ON / ! 徽章 |

## 安装（未上架 Web Store）

1. 打开 `chrome://extensions`；
2. 右上角开启「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择本目录 `chrome-extension/`；
4. 在扩展菜单里固定 2Xray，点击图标打开三卡片面板。

扩展在 `manifest.json` 里内置了固定公钥，因此 **扩展 ID 固定为 `jcalgojagadmmjeolgahhmnhnmhdkecna`**，移动源码目录不会丢设置，也便于后续接入 Native Messaging。

打包分发（生成可上传/归档的 zip）：

```bash
node scripts/build-extension.mjs
# dist/2xray-chrome-v0.8.0.zip
```

> Chrome 只能直接加载解压目录；zip 用于备份、审核或转 CRX。若上架 Chrome Web Store，请移除 `manifest.json` 的 `key` 字段，由商店分配身份。

## 没有 DSH 时（独立版）

不想安装 DSH / DSH-2Xray 插件时，使用仓库的 **2Xray 独立版**（Windows）：

1. 解压发布资产 `2xray-standalone-win64-v0.8.0.zip`；
2. 双击 `install.cmd`，粘贴 `vless://` 链接；
3. 安装器会拉起本地 Xray（`127.0.0.1:20808`）、创建可选登录启动项，并把本扩展解压到安装目录 `extension/`；
4. 在 `chrome://extensions` 加载该目录即可。

也可以把本扩展指向任何监听 `127.0.0.1:20808` 的本地 Xray / v2rayN，不依赖 DSH。详见 [../standalone/windows/README.md](../standalone/windows/README.md)。

## 快速开始

1. **先准备本地 Xray 入站。** 用 DSH-2Xray 插件（`inbound.port` 默认 `20808`）或 v2rayN 提供 `127.0.0.1:20808`；
2. 打开扩展设置页（右键图标 →「选项」，或面板里的「设置」）；
3. 粘贴 `vless://` 链接 →「解析并保存」；
4. 回到面板，打开右上角开关。徽章变成绿色 `ON`、出口 IP 与节点地区一致即成功。

如果内核是你自己启动的，也可以用「Xray 配置」页生成 `config.json`，然后：

```bash
xray run -c config.json
```

## 三种分流模式

| 模式 | PAC 行为 |
|---|---|
| 全局代理 | 除内网/本机/黑名单外全部走代理 |
| 白名单模式 | 只有白名单域名（含子域）走代理，其余直连 |
| CN 直连 | `.cn` 与内置常见国内站点直连，其余走代理 |

规则细节：

- **黑名单永远直连**，优先级高于白名单，也高于三种模式；默认带 `deepseek.com` 系列与 `registry.npmjs.org`（避免模型 API / npm 被绕进代理）。
- 本机名（无点主机名）、`localhost`、RFC1918 / 链路本地 / CGNAT 地址、`.local`、`.lan` 等后缀始终直连。
- 状态探测域名（`www.google.com`、`www.gstatic.com`、`ipinfo.io`、`api.ipify.org`）在代理开启时总是走代理，保证延迟/出口 IP 反映隧道而不是直连；若把它们加入黑名单则黑名单优先。
- 条目支持完整 URL、`*.example.com`、裸域名，保存时归一化为小写主机名去重。
- **CN 直连是浏览器侧近似**：Chrome PAC 不能读 `geoip/geosite`。需要完整分流时，让 Xray 内核使用 `cn-direct` 路由（DSH-2Xray 已支持），浏览器保持全局即可。

## 二维码

- 面板与设置页会为当前节点实时生成二维码，手机客户端可直接扫；
- 「从二维码图片导入」：支持截图/相册图片，先试 `BarcodeDetector`，失败回退内置 jsQR；
- 「摄像头扫码」：首次点击时由浏览器弹窗请求摄像头权限（不占用 manifest 权限），适合直接扫屏幕上的节点二维码；
- 解码出的文本必须是 `vless://`；其他协议会给出明确错误。

## 生成的 Xray 配置

设置页「Xray 配置 → 生成配置」输出单节点 `xray-core` JSON：

- inbound 与扩展代理协议/端口一致（HTTP 或 SOCKS5）；
- outbound：VLESS（REALITY/TLS/none，Vision flow），`direct`、`block`；
- routing：黑名单直连 → 白名单（whitelist 模式）→ 私网直连 → 后缀直连 → `geosite:cn`/`geoip:cn`（cn-direct）→ 兜底；
- `cn-direct` 模式依赖 `geosite.dat` / `geoip.dat`（Xray 官方发行包通常自带；DSH-2Xray 会自动下载）。
- 扩展不替你重启内核：修改节点后请让 Xray 使用新配置（重新加载插件或重启内核进程）。

## 权限与隐私

| 权限 | 用途 |
|---|---|
| `proxy` | 安装/清除 Chrome 代理（PAC） |
| `storage` | 本地保存设置与日志 |
| `alarms` | 定时探测隧道 |
| `host_permissions`（仅 4 个探测域名） | `www.google.com`、`www.gstatic.com`、`ipinfo.io`、`api.ipify.org` |

> 摄像头扫码通过 `navigator.mediaDevices.getUserMedia` 在运行时申请权限；`videoCapture` 是 Chrome App 专用清单权限，扩展不能声明（Chrome 会报 “only allowed for packaged apps”）。

- 不读取网页内容、不注入 content script、不上传设置或节点、不加载远程代码；
- 所有 JS/二维码库随扩展打包，CSP 为 `script-src 'self'`；
- 导出设置包含 VLESS 链接与 UUID，请按密钥保管。

## 故障排查

| 现象 | 处理 |
|---|---|
| 开关打开但徽章 `!`、面板「内核未响应」 | 本地入站没起来：确认 `127.0.0.1:20808` 有监听（DSH-2Xray 是否启用、v2rayN 是否启动） |
| 出口 IP 还是本机 | 模式是 whitelist 且探测域名刚被黑名单覆盖，或本地入站把流量直连了；检查 Xray 路由 |
| 「代理设置被其他扩展接管」 | 关闭其他代理类扩展（Proxy SwitchyOmega 等）后重开 2Xray |
| 白名单站点仍直连 | 域名是否包含在白名单、是否被黑名单覆盖；子域自动匹配，`notgithub.com` 不会误匹配 `github.com` |
| 国内网站变慢 | CN 直连列表是近似值，把该域名加入「黑名单 / 强制直连」 |
| 摄像头扫码不可用 | 用「从二维码图片导入」；部分企业策略禁用摄像头 |
| 修改节点后网页仍走旧节点 | 扩展只保存链接；需要同步更新内核配置并重启内核 |

## 开发与测试

```bash
node --test test/extension-*.test.js    # PAC vm 求值、链接解析、配置生成、QR 编解码、manifest
node scripts/build-extension.mjs        # 校验 + 打包
```

目录：

```
chrome-extension/
  manifest.json         MV3 清单（固定 key / 权限 / CSP）
  background.js         代理安装、PAC、探测、徽章、消息 API
  popup.html/css/js     三卡片面板
  options.html/css/js   设置、扫码、配置生成、导入导出
  lib/                  可测试的纯逻辑（链接、配置、PAC、Xray 配置、QR 渲染）
  vendor/               qrcode.js (MIT) + jsQR (Apache-2.0) + 许可证
  icons/                16/32/48/128 图标（与 DSH 插件 icon.svg 同源）
```

## 已知限制

- **不能启动/停止 Xray 进程**（浏览器沙箱限制）；需要原生进程管理时用 DSH-2Xray，或另加 Native Messaging host；
- 不能接管系统全局流量 / TUN；系统级代理请用 DSH-2Xray 的 `tun.enabled` 或系统代理；
- PAC 只看主机名：无法按 IP 地理库分流，CN 直连为近似；
- 自定义探测域名需要额外 host 权限，本版本固定探测域名；
- Chrome Web Store 上架需补充隐私政策与 `proxy` 权限说明。

## 许可证

扩展代码与 DSH-2Xray 相同：MIT。第三方组件：

- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — MIT，`vendor/qrcode.js`
- [jsQR](https://github.com/cozmo/jsQR) — Apache-2.0，`vendor/jsQR.js`，许可证见 `vendor/JSQR-LICENSE.txt`
