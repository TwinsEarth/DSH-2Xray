@echo off
setlocal
rem Launch DeepSeek Harness with the embedded Chromium browser pointed at the
rem plugin's local HTTP inbound. A Node plugin cannot change Chromium's proxy at
rem runtime, so the switch has to be present when the app starts.
rem
rem Usage:
rem   launch-with-browser-proxy.cmd ["C:\path\to\DeepSeek Harness.exe"]
rem
rem Close DSH completely before running this: a second launch only focuses the
rem existing single instance and never applies the flag.

set "PORT=20808"
set "EXE=%~1"
if not defined EXE set "EXE=%DSH_EXE%"

if not defined EXE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe" set "EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if not defined EXE if exist "%ProgramFiles%\DeepSeek Harness\DeepSeek Harness.exe" set "EXE=%ProgramFiles%\DeepSeek Harness\DeepSeek Harness.exe"
if not defined EXE if exist "E:\DS\DeepSeek Harness.exe" set "EXE=E:\DS\DeepSeek Harness.exe"

if not defined EXE (
  echo DeepSeek Harness executable not found.
  echo Pass the path explicitly:
  echo   %~nx0 "C:\path\to\DeepSeek Harness.exe"
  exit /b 1
)

echo Launching with embedded browser proxy: http://127.0.0.1:%PORT%
start "" "%EXE%" --proxy-server=http://127.0.0.1:%PORT%
endlocal
