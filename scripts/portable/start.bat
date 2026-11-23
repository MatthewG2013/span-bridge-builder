@echo off
chcp 65001 >nul
setlocal
title SPAN Bridge Builder
cd /d "%~dp0"

if exist "%~dp0runtime\node.exe" (
  set "NODE_EXE=%~dp0runtime\node.exe"
  goto :run
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [Error] Node.js was not found.
  echo         Use the full portable package, or install Node.js 22.5+:
  echo         https://nodejs.org/
  echo.
  pause
  exit /b 1
)
set "NODE_EXE=node"

:run
"%NODE_EXE%" "%~dp0launcher.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [Launch failed] See the error above.
  pause
)
exit /b %EXIT_CODE%
