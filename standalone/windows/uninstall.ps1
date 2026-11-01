[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA '2Xray'),
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'
function Write-Warn([string]$Text) { Write-Host "[2Xray] $Text" -ForegroundColor Yellow }
Write-Host "[2Xray] uninstalling from $InstallDir" -ForegroundColor Cyan

$xray = Join-Path $InstallDir 'xray.exe'
Get-Process xray -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $xray } |
  Stop-Process -Force -ErrorAction SilentlyContinue

$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) '2Xray Core.lnk'
if (Test-Path $shortcut) {
  Remove-Item $shortcut -Force -ErrorAction SilentlyContinue
  Write-Host "[2Xray] removed login startup: $shortcut" -ForegroundColor Green
}

if ($KeepFiles) {
  Write-Host "[2Xray] kept files at $InstallDir (-KeepFiles)" -ForegroundColor Yellow
} elseif (Test-Path $InstallDir) {
  $resolved = (Resolve-Path $InstallDir).Path
  if ($resolved -eq (Join-Path $env:LOCALAPPDATA '2Xray') -or $resolved -like '*\2Xray*') {
    Remove-Item -Path $resolved -Recurse -Force
    Write-Host "[2Xray] removed $resolved" -ForegroundColor Green
  } else {
    Write-Warn "refusing to remove unexpected path: $resolved"
  }
}

Write-Host "[2Xray] Chrome extension: remove it manually at chrome://extensions if no longer needed." -ForegroundColor Yellow
Write-Host "[2Xray] system proxy was never modified by this installer." -ForegroundColor Yellow
