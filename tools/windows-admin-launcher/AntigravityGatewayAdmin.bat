@echo off
setlocal
cd /d "%~dp0"

set "SCRIPT=%~dp0AntigravityGatewayAdmin.ps1"
set "LOG=%~dp0launcher-error.log"

if not exist "%SCRIPT%" (
  echo Antigravity Gateway Admin script is missing:
  echo "%SCRIPT%"
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%SCRIPT%" > "%LOG%" 2>&1
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo Antigravity Gateway Admin failed to start.
  echo Error log:
  echo "%LOG%"
  echo.
  type "%LOG%"
  echo.
  pause
  exit /b %EXITCODE%
)

del "%LOG%" >nul 2>nul
exit /b 0
