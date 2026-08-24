@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ============================================================
rem  Silhouette Gallery launcher
rem  Works on any Windows machine. Uses Python / Node.js when
rem  available; otherwise falls back to the built-in PowerShell
rem  server, so nothing needs to be installed.
rem ============================================================

rem ---------- make sure the project files are actually here ----------
if not exist "%~dp0index.html" (
  echo [ERROR] index.html was not found next to this file.
  echo Please extract ALL files from the downloaded ZIP into one folder,
  echo then run this file again.
  echo.
  pause
  exit /b 1
)

rem ---------- pick a free port, starting from 8000 ----------
set "PORT=8000"
set "PORT_OK="
for /l %%p in (8000,1,8010) do (
  powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%%p);$c.Close();exit 0}catch{exit 1}" >nul 2>nul
  if "!errorlevel!"=="1" (
    set "PORT=%%p"
    set "PORT_OK=1"
    goto :portok
  )
)
if not defined PORT_OK (
  echo [ERROR] Ports 8000-8010 are all in use.
  echo Please close the programs using those ports and try again.
  echo.
  pause
  exit /b 1
)

:portok
echo Using port: %PORT%

rem ---------- find a static server ----------
set "SRV="
where py >nul 2>nul
if "!errorlevel!"=="0" (
  set "SRV=py -3 -m http.server %PORT% --bind 127.0.0.1"
  goto :run
)
where python >nul 2>nul
if "!errorlevel!"=="0" (
  set "SRV=python -m http.server %PORT% --bind 127.0.0.1"
  goto :run
)
where python3 >nul 2>nul
if "!errorlevel!"=="0" (
  set "SRV=python3 -m http.server %PORT% --bind 127.0.0.1"
  goto :run
)
where node >nul 2>nul
if "!errorlevel!"=="0" (
  set "SRV=node server.js %PORT%"
  goto :run
)

rem ---------- fallback: built-in PowerShell server ----------
set "SRV=powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Port %PORT% -Root "%CD%""

:run
echo Starting server...

rem ---------- write a small log file in case something goes wrong ----------
set "LOG=%~dp0startup_log.txt"
(
  echo [%date% %time%]
  echo Port: %PORT%
  echo Command: %SRV%
) > "%LOG%"

rem ---------- start the server in this console, so the window stays open ----------
start /b "" %SRV%

rem ---------- wait until the server is ready (up to ~15 seconds) ----------
set "READY="
powershell -NoProfile -Command "for($i=0;$i -lt 50;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();exit 0}catch{Start-Sleep -Milliseconds 300}};exit 1" >nul 2>nul
if "!errorlevel!"=="0" set "READY=1"

if defined READY (
  echo Server is running at: http://127.0.0.1:%PORT%/
  echo.
  echo Keep this window open while you use the page.
  echo Close this window to stop the server.
  echo Status: OK >> "%LOG%"
  echo Opening your browser...
  start "" "http://127.0.0.1:%PORT%/"
) else (
  echo [ERROR] The server did not start.
  echo Please check the messages above and look at %LOG%
  echo Status: FAILED - server did not become ready >> "%LOG%"
  pause
)

exit /b 0
