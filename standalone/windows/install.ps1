<#
.SYNOPSIS
  Install the standalone 2Xray runtime: one local Xray core + config + optional
  login auto-start, no DSH required.

.DESCRIPTION
  The Chrome extension only needs an HTTP proxy at 127.0.0.1:20808. This script
  writes that proxy's Xray config from a standard vless:// link, copies the
  bundled Xray core, starts it, and (optionally) registers a hidden login
  startup entry. It never touches the system proxy or the registry.

.EXAMPLE
  .\install.ps1 -Link "vless://uuid@host:443?security=tls&sni=host&type=tcp#MyNode"

.EXAMPLE
  .\install.ps1 -Link "..." -Port 20808 -NoStartup
#>
[CmdletBinding()]
param(
  [string]$Link = '',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA '2Xray'),
  [int]$Port = 20808,
  [ValidateSet('global', 'whitelist', 'cn-direct')]
  [string]$Mode = 'cn-direct',
  [string]$CoreDir = '',
  [switch]$NoStartup,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) { Write-Host "[2Xray] $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "[2Xray] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "[2Xray] $Text" -ForegroundColor Yellow }

if ([string]::IsNullOrWhiteSpace($Link)) {
  Write-Step '请粘贴 vless:// 分享链接（与二维码内容一致）：'
  $Link = Read-Host
}
$Link = $Link.Trim()
if ($Link -notmatch '^vless://') {
  throw '只支持 vless:// 链接；vmess/trojan/ss 等请先用支持的客户端转换。'
}

# ---- parse link -----------------------------------------------------------
$uri = $null
if (-not [Uri]::TryCreate($Link, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'vless') {
  throw '不是合法的 vless:// URL。'
}
$uuid = [Uri]::UnescapeDataString($uri.UserInfo)
if ([string]::IsNullOrWhiteSpace($uuid)) { throw '链接缺少 uuid。' }
$address = $uri.Host
$serverPort = if ($uri.Port -gt 0) { $uri.Port } else { 443 }
if ([string]::IsNullOrWhiteSpace($address)) { throw '链接缺少服务器地址。' }

$query = @{}
if ($uri.Query.Length -gt 1) {
  foreach ($pair in $uri.Query.Substring(1).Split('&')) {
    if ([string]::IsNullOrEmpty($pair)) { continue }
    $kv = $pair.Split('=', 2)
    $key = [Uri]::UnescapeDataString($kv[0])
    $value = if ($kv.Length -gt 1) { [Uri]::UnescapeDataString($kv[1]) } else { '' }
    $query[$key] = $value
  }
}

$security = if ($query['security']) { $query['security'].ToLowerInvariant() } else { 'none' }
if (@('reality', 'tls', 'none') -notcontains $security) { throw "不支持的 security：$security" }
$network = if ($query['type'] -and $query['type'] -ne 'tcp') { $query['type'].ToLowerInvariant() } else { 'raw' }
if (@('raw', 'tcp') -notcontains $network) {
  throw "扩展/本安装器只生成 raw/tcp VLESS 出站，当前 type=$network；请在支持 ws/grpc 的客户端使用。"
}
$flow = $query['flow']
if ([string]::IsNullOrEmpty($flow) -and $security -ne 'none') { $flow = 'xtls-rprx-vision' }
$sni = $query['sni']
if ([string]::IsNullOrEmpty($sni)) { $sni = $query['host'] }
$fingerprint = if ($query['fp']) { $query['fp'] } else { 'chrome' }
$publicKey = if ($query['pbk']) { $query['pbk'] } else { $query['publicKey'] }
$shortId = if ($query['sid']) { $query['sid'] } else { '' }
$spiderX = if ($query['spx']) { $query['spx'] } else { '/' }
$nodeName = if ($uri.Fragment) { [Uri]::UnescapeDataString($uri.Fragment.TrimStart('#')) } else { 'VLESS 节点' }

if ($security -eq 'reality' -and (-not $sni -or -not $publicKey)) {
  throw 'REALITY 链接必须包含 sni 与 pbk。'
}
if ($security -eq 'tls' -and [string]::IsNullOrEmpty($sni)) { $sni = $address }

# ---- build xray config ----------------------------------------------------
$streamNetwork = if ($network -eq 'tcp') { 'raw' } else { $network }
$streamSettings = [ordered]@{
  network  = $streamNetwork
  security = $security
}
if ($security -eq 'reality') {
  $reality = [ordered]@{
    serverName  = $sni
    fingerprint = $fingerprint
    shortId     = $shortId
    spiderX     = $spiderX
    show        = $false
    password    = $publicKey
    publicKey   = $publicKey
  }
  $streamSettings['realitySettings'] = $reality
} elseif ($security -eq 'tls') {
  $streamSettings['tlsSettings'] = [ordered]@{
    serverName  = $sni
    fingerprint = $fingerprint
  }
}

$user = [ordered]@{ id = $uuid; encryption = 'none' }
if (-not [string]::IsNullOrEmpty($flow)) { $user['flow'] = $flow }
$outbound = [ordered]@{
  tag            = 'proxy'
  protocol       = 'vless'
  settings       = [ordered]@{ vnext = @([ordered]@{ address = $address; port = $serverPort; users = @($user) }) }
  streamSettings = $streamSettings
  mux            = [ordered]@{ enabled = $false }
}

$inbound = [ordered]@{
  tag      = 'http-in'
  listen   = '127.0.0.1'
  port     = $Port
  protocol = 'http'
  settings = [ordered]@{}
  sniffing = [ordered]@{ enabled = $false }
}

$direct = [ordered]@{
  tag            = 'direct'
  protocol       = 'freedom'
  settings       = [ordered]@{}
  streamSettings = [ordered]@{ sockopt = [ordered]@{ domainStrategy = 'AsIs' } }
}
$block = [ordered]@{ tag = 'block'; protocol = 'blackhole' }

$privateIps = @(
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8',
  '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'
)
$blacklist = @(
  'deepseek.com', 'chat.deepseek.com', 'api.deepseek.com', 'download.deepseek.com',
  'api-docs.deepseek.com', 'platform.deepseek.com', 'registry.npmjs.org'
)
$bypass = @('localhost', 'local', 'lan', 'internal', 'corp', 'home.arpa', 'home')
$whitelist = @(
  'github.com', 'google.com', 'youtube.com', 'x.com', 'facebook.com',
  'api.github.com', 'raw.githubusercontent.com'
)

$rules = New-Object System.Collections.ArrayList
[void]$rules.Add([ordered]@{
  type = 'field'; domain = @($blacklist | ForEach-Object { "domain:$_" }); outboundTag = 'direct'
})
if ($Mode -eq 'whitelist') {
  [void]$rules.Add([ordered]@{
    type = 'field'; domain = @($whitelist | ForEach-Object { "domain:$_" }); outboundTag = 'proxy'
  })
}
[void]$rules.Add([ordered]@{ type = 'field'; ip = $privateIps; outboundTag = 'direct' })
[void]$rules.Add([ordered]@{
  type = 'field'; domain = @($bypass | ForEach-Object { "domain:$_" }); outboundTag = 'direct'
})
if ($Mode -eq 'cn-direct') {
  [void]$rules.Add([ordered]@{ type = 'field'; domain = @('geosite:cn'); outboundTag = 'direct' })
  [void]$rules.Add([ordered]@{ type = 'field'; ip = @('geoip:cn'); outboundTag = 'direct' })
}
if ($Mode -eq 'whitelist') {
  [void]$rules.Add([ordered]@{ type = 'field'; network = 'tcp,udp'; outboundTag = 'direct' })
} else {
  [void]$rules.Add([ordered]@{ type = 'field'; network = 'tcp,udp'; outboundTag = 'proxy' })
}

$domainStrategy = if ($Mode -eq 'cn-direct') { 'IPIfNonMatch' } else { 'AsIs' }
$config = [ordered]@{
  log = [ordered]@{ loglevel = 'warning'; access = 'none'; dnsLog = $false }
  inbounds = @($inbound)
  outbounds = @($outbound, $direct, $block)
  routing = [ordered]@{
    domainStrategy = $domainStrategy
    rules = @($rules)
  }
}

# ---- locate / copy core ---------------------------------------------------
$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($CoreDir)) { $CoreDir = Join-Path $scriptRoot 'core' }
$required = @('xray.exe', 'geoip.dat', 'geosite.dat')
foreach ($file in $required) {
  if (-not (Test-Path (Join-Path $CoreDir $file))) {
    throw "缺少内核文件 $file（$CoreDir）。请使用包含 core/ 的独立版压缩包，或用 -CoreDir 指定目录。"
  }
}

if (Test-Path $InstallDir) {
  Write-Step "更新已有安装：$InstallDir"
} else {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}
foreach ($file in $required) {
  Copy-Item -Path (Join-Path $CoreDir $file) -Destination (Join-Path $InstallDir $file) -Force
}
$configPath = Join-Path $InstallDir 'config.json'
$configJson = $config | ConvertTo-Json -Depth 20
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $configJson, $utf8NoBom)

# ---- helper scripts -------------------------------------------------------
$runCmd = @'
@echo off
setlocal
set "XRAY_LOCATION_ASSET=%~dp0"
"%~dp0xray.exe" run -c "%~dp0config.json"
'@
Set-Content -Path (Join-Path $InstallDir 'run.cmd') -Value $runCmd -Encoding ASCII

$runHidden = @'
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd.exe /c """ & dir & "\run.cmd""", 0, False
'@
Set-Content -Path (Join-Path $InstallDir 'run-hidden.vbs') -Value $runHidden -Encoding ASCII

$stopPs = @'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$xray = Join-Path $dir 'xray.exe'
Get-Process xray -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $xray } |
  Stop-Process -Force
Write-Host "[2Xray] stopped"
'@
Set-Content -Path (Join-Path $InstallDir 'stop.ps1') -Value $stopPs -Encoding UTF8
Set-Content -Path (Join-Path $InstallDir 'stop.cmd') -Value "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0stop.ps1`"`r`npause`r`n" -Encoding ASCII
Set-Content -Path (Join-Path $InstallDir 'start.cmd') -Value "@echo off`r`nwscript.exe `"%~dp0run-hidden.vbs`"`r`n" -Encoding ASCII

# Save the share link so the user can import it into the Chrome extension UI.
[System.IO.File]::WriteAllText((Join-Path $InstallDir 'vless-link.txt'), $Link, $utf8NoBom)

# Copy the uninstaller into the install dir so the package can be removed later.
$uninstaller = Join-Path $scriptRoot 'uninstall.ps1'
if (Test-Path $uninstaller) {
  Copy-Item -Path $uninstaller -Destination (Join-Path $InstallDir 'uninstall.ps1') -Force
  $uninstallCmd = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0uninstall.ps1`"`r`npause`r`n"
  Set-Content -Path (Join-Path $InstallDir 'uninstall.cmd') -Value $uninstallCmd -Encoding ASCII
}

# Extract the Chrome extension next to the core so it can be loaded directly.
$extensionZip = Get-ChildItem -Path $scriptRoot -Filter '2xray-chrome-*.zip' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($extensionZip) {
  $extensionDir = Join-Path $InstallDir 'extension'
  if (Test-Path $extensionDir) { Remove-Item -Recurse -Force $extensionDir }
  New-Item -ItemType Directory -Force -Path $extensionDir | Out-Null
  try {
    Expand-Archive -Path $extensionZip.FullName -DestinationPath $extensionDir -Force
    Write-Ok "Chrome 扩展已解压：$extensionDir"
  } catch {
    Write-Warn "扩展解压失败：$($_.Exception.Message)"
  }
}

# ---- optional login auto-start -------------------------------------------
$startupPath = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupPath '2Xray Core.lnk'
if (-not $NoStartup) {
  try {
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shortcut.Arguments = '"' + (Join-Path $InstallDir 'run-hidden.vbs') + '"'
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.WindowStyle = 7
    $shortcut.Description = '2Xray local Xray core'
    $shortcut.Save()
    Write-Ok "已创建登录启动项：$shortcutPath"
  } catch {
    Write-Warn "创建登录启动项失败：$($_.Exception.Message)"
  }
} else {
  Write-Step '已跳过登录启动项（-NoStartup）'
}

# ---- start and verify -----------------------------------------------------
if (-not $NoStart) {
  Get-Process xray -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq (Join-Path $InstallDir 'xray.exe') } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + (Join-Path $InstallDir 'run-hidden.vbs') + '"') -WindowStyle Hidden
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $client.Connect('127.0.0.1', $Port)
      $client.Close()
      $ready = $true
      break
    } catch { }
  }
  if (-not $ready) {
    Write-Warn "端口 $Port 未在 15 秒内监听；查看 $InstallDir 下的 xray 输出或手动运行 run.cmd。"
  } else {
    try {
      $probe = Invoke-WebRequest -Uri 'http://cp.cloudflare.com/generate_204' -Proxy ("http://127.0.0.1:$Port") -UseBasicParsing -TimeoutSec 10
      if ($probe.StatusCode -eq 204) {
        Write-Ok "内核已启动，代理链路验证通过（HTTP 204）。"
      } else {
        Write-Warn "内核已监听，但代理探测返回 HTTP $($probe.StatusCode)。"
      }
    } catch {
      Write-Warn "内核已监听，但代理探测失败：$($_.Exception.Message)"
    }
  }
} else {
  Write-Step '已跳过启动（-NoStart）；可运行 start.cmd'
}

Write-Host ''
Write-Ok '独立版安装完成。'
Write-Host "  内核目录 : $InstallDir"
Write-Host "  代理端点 : http://127.0.0.1:$Port"
Write-Host "  分流模式 : $Mode"
Write-Host "  节点     : $nodeName"
if ($extensionZip) {
  Write-Host "  Chrome 扩展：chrome://extensions → 开发者模式 → 加载已解压 → $InstallDir\extension"
}
Write-Host "  管理     : start.cmd / stop.cmd / 删除登录启动项：$shortcutPath"
Write-Host "  改节点   : 重新运行 install.ps1 -Link <新链接>（会覆盖 config.json 并重启内核）"
Write-Host "  卸载     : uninstall.cmd"
Write-Host ''
Write-Warn '本安装器只监听 127.0.0.1，不修改系统代理；Chrome 流量由 2Xray 扩展接管。'
