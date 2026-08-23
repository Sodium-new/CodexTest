@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ========== 1. 挑选一个未被占用的端口（8000 起） ==========
set "PORT=8000"
for /l %%p in (8000,1,8010) do (
  powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%%p);$c.Close();exit 0}catch{exit 1}" >nul 2>nul
  if "!errorlevel!"=="1" set "PORT=%%p" & goto :portok
)
echo 端口 8000-8010 均被占用，无法启动本地服务器。
pause
exit /b 1

:portok
echo 使用端口: %PORT%

rem ========== 2. 找一个可用的静态服务器命令 ==========
set "SRV="
where py >nul 2>nul
if !errorlevel! equ 0 set "SRV=py -m http.server %PORT% --bind 127.0.0.1" & goto :run
where python >nul 2>nul
if !errorlevel! equ 0 set "SRV=python -m http.server %PORT% --bind 127.0.0.1" & goto :run
where python3 >nul 2>nul
if !errorlevel! equ 0 set "SRV=python3 -m http.server %PORT% --bind 127.0.0.1" & goto :run
where node >nul 2>nul
if !errorlevel! equ 0 set "SRV=node server.js %PORT%" & goto :run

rem 兜底：本机 Codex 运行时自带的 Python / Node
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  set "SRV=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe -m http.server %PORT% --bind 127.0.0.1"
  goto :run
)
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  set "SRV=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe server.js %PORT%"
  goto :run
)

echo 未找到 Python 或 Node.js，无法启动本地服务器。
echo 请安装 Python 或 Node.js 后重试。
pause
exit /b 1

:run
echo 启动本地服务器: http://127.0.0.1:%PORT%/
start "剪影画廊服务器" cmd /k %SRV%

rem ========== 3. 等待服务器就绪后再打开浏览器 ==========
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();exit 0}catch{Start-Sleep -Milliseconds 300}};exit 1" >nul 2>nul
if "!errorlevel!"=="0" (
  start "" "http://127.0.0.1:%PORT%/"
) else (
  echo 服务器启动似乎失败，请查看弹出的服务器窗口中的错误信息。
  pause
)
exit /b 0