@echo off
cd /d "%~dp0"
if exist turn-settings.bat call turn-settings.bat
if exist admin-settings.bat call admin-settings.bat
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo Installing the tunnel tool, one time only...
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  echo.
  echo Done. CLOSE this window, then double-click start-online.bat again.
  pause
  exit /b
)
call npm install
start "Relay server - keep open" cmd /k node server.js
timeout /t 3 >nul
echo.
echo ============================================================
echo  Find the https://something.trycloudflare.com link below.
echo  Open it on EVERY device. Keep both windows open.
echo ============================================================
cloudflared tunnel --url http://localhost:3000
pause
