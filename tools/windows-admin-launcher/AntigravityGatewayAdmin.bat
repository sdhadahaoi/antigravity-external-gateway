@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0AntigravityGatewayAdmin.ps1"

if errorlevel 1 (
  echo.
  echo Antigravity 外接网关管理器启动失败。
  echo 请确认这台电脑可以使用 Windows PowerShell。
  pause
)
