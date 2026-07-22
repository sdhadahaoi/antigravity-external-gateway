@echo off
setlocal

cd /d "%~dp0"

if /I "%~1"=="--check" (
  echo start-local.bat OK
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js 20 or newer.
  pause
  exit /b 1
)

if "%PORT%"=="" set "PORT=3000"
if "%GATEWAY_ADMIN_KEY%"=="" set "GATEWAY_ADMIN_KEY=local-admin-key"
if "%GATEWAY_ADMIN_BASE_URL%"=="" set "GATEWAY_ADMIN_BASE_URL=http://127.0.0.1:%PORT%"
if "%GATEWAY_USER_BASE_URL%"=="" set "GATEWAY_USER_BASE_URL=http://127.0.0.1:%PORT%"
if "%GATEWAY_DATA_DIR%"=="" set "GATEWAY_DATA_DIR=%CD%\data\local"

echo Starting Antigravity External Gateway local website...
echo.
echo Admin website:
echo %GATEWAY_ADMIN_BASE_URL%/?key=%GATEWAY_ADMIN_KEY%
echo.
echo User/API base website:
echo %GATEWAY_USER_BASE_URL%
echo.
echo Keep this window open. Close it to stop the local website.
echo.

start "" "%GATEWAY_ADMIN_BASE_URL%/?key=%GATEWAY_ADMIN_KEY%"
node server.mjs

echo.
echo Local website stopped.
pause
