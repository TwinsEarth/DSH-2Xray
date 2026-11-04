# 2Xray 独立版（Windows，无需 DSH）

把 **Xray 内核 + 配置生成 + 登录启动 + Chrome 扩展** 打成一个离线包：用户不需要安装 DSH / DSH-2Xray 插件，也能让 Chrome 通过本地 Xray 上外网。

## 适用环境

- Windows 10/11 x64
- Chrome / Edge 116+（Manifest V3）
- 无需管理员权限；只监听 `127.0.0.1`，不改系统代理、不装驱动、不装服务

## 包内容

```
2xray-standalone-win64-v0.8.0/
  install.cmd            双击安装（会提示粘贴 vless:// 链接）
  install.ps1            安装逻辑（可带参数静默安装）
  uninstall.cmd          卸载
  uninstall.ps1
  core/
    xray.exe             Xray-core 26.9.30（官方 release，未修改）
    geoip.dat
    geosite.dat
  2xray-chrome-v0.8.0.zip Chrome 扩展（安装时会解压到安装目录\extension）
  README.md
  THIRD-PARTY-NOTICES.txt
```

## 安装（3 步）

1. 解压整个目录（不要只复制 exe）；
2. 双击 **`install.cmd`**，粘贴标准 `vless://` 分享链接（与二维码内容一致），回车；
3. 打开 `chrome://extensions` → 右上角开启「开发者模式」→「加载已解压的扩展程序」→ 选择安装器提示的目录（默认 `%LOCALAPPDATA%\2Xray\extension`）。

安装器会：

- 校验并解析链接，生成 `%LOCALAPPDATA%\2Xray\config.json`；
- 复制内核与规则数据；
- 创建**登录启动项** `2Xray Core.lnk`（隐藏窗口启动 xray）；
- 立即启动内核并做一次真实 HTTP 204 探测；
- 解压扩展并打印加载路径。

装完打开扩展开关，面板应显示绿色 `ON` / 延迟数值。

## 默认行为

| 项 | 默认值 |
|---|---|
| 本地入站 | `http://127.0.0.1:20808` |
| 分流模式 | `cn-direct`（`.cn` + 常见国内站点直连，其余走节点） |
| 系统代理 | **不修改**（只改 Chrome，通过扩展 PAC） |
| 监听范围 | 仅回环地址 |
| 登录启动 | 默认创建（`-NoStartup` 可跳过） |

## 管理

安装目录（默认 `%LOCALAPPDATA%\2Xray`）里：

| 文件 | 用途 |
|---|---|
| `start.cmd` | 隐藏启动内核 |
| `stop.cmd` | 停止内核（按 exe 路径匹配，不会误杀其他 xray） |
| `config.json` | 生成的 Xray 配置 |
| `vless-link.txt` | 当前节点链接（可粘贴到扩展设置页，获得二维码/配置生成能力） |
| `uninstall.cmd` | 卸载（停止内核、删登录启动项、删除安装目录） |

**换节点**：重新运行包里的 `install.cmd` 并粘贴新链接；或带参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Link "vless://..." -Mode cn-direct
```

**换端口**：`-Port 20808`；改完后在扩展设置页把「本地入站端口」改成同一值。

静默安装示例：

```powershell
install.cmd -Link "vless://uuid@host:443?security=tls&sni=host&type=tcp#Node" -NoStartup
```

## 故障排查

| 现象 | 处理 |
|---|---|
| 安装后端口没监听 | 看安装窗口探测结果；手动运行 `start.cmd`，或 `run.cmd` 前台看 xray 报错 |
| 扩展显示“内核未响应” | 确认 `http://127.0.0.1:20808` 可访问；重开扩展开关或点“立即测试” |
| 端口被占用 | 先 `stop.cmd`，或安装时用 `-Port 20809` 并在扩展里同步端口 |
| 国内网站变慢 | 默认 `cn-direct` 是规则数据近似；可在扩展“强制直连”里追加域名 |
| 换节点后仍是旧节点 | 重新运行 `install.cmd`（会覆盖 config.json 并重启内核） |
| 不想开机启动 | 删除 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\2Xray Core.lnk`，或用 `-NoStartup` 重装 |
| 卸载 | 运行安装目录下 `uninstall.cmd`；扩展在 `chrome://extensions` 手动移除 |

## 安全与隐私

- 内核只监听 `127.0.0.1`，不会把代理暴露到局域网；
- 不修改系统代理、不安装服务/驱动、不提升权限；
- `config.json` 与 `vless-link.txt` 含节点 UUID/密钥，请按密码保管；
- 登录启动项可随时删除；卸载脚本不会删除未识别的目录；
- 本包不含遥测；Xray 与扩展均无远程代码加载。

## 与 DSH-2Xray 的关系

- 本独立版与 DSH 插件共用同一套 `xray.exe`、入站端口与路由语义；
- 区别：DSH 插件由 DSH 托管进程并接管 DSH 进程流量；独立版由 Windows 登录项托管进程，仅服务浏览器（通过扩展）；
- 两者不要同时占用 `20808`：装独立版前先停掉 DSH 插件或临时内核。

## 许可

- 安装脚本与 2Xray 扩展：MIT；
- Xray-core：MPL-2.0（官方二进制未修改），完整文本见 `THIRD-PARTY-NOTICES.txt`；
- 扩展内二维码库：qrcode-generator (MIT)、jsQR (Apache-2.0)，许可证随扩展包分发。
