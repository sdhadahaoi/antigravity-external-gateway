@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0AntigravityGatewayAdmin.ps1"

if errorlevel 1 (
  echo.
  echo Antigravity Gateway Admin failed to start.
  echo Make sure Windows PowerShell is available on this computer.
  pause
)
