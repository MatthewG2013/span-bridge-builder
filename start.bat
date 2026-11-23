@echo off
chcp 65001 >nul
setlocal
title SPAN Bridge Builder
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [Error] Node.js was not found.
  echo         Install Node.js 22.5 or newer: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node scripts\launch.mjs %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [Launch failed] See the error above.
  pause
)
exit /b %EXIT_CODE%
