@echo off
cd /d "%~dp0"
if exist admin-settings.bat call admin-settings.bat
echo Installing (first run only)...
call npm install
echo.
echo Starting Relay at http://localhost:3000  (keep this window open)
start "" http://localhost:3000
node server.js
pause
