@echo off
title CineVault - All in One Movie Server
cd /d "%~dp0"
echo.
echo  ============================================================
echo    CineVault - All in One Movie Server
echo  ============================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo  [ERROR] Node.js is not installed or not in PATH.
  pause
  exit /b 1
)

netstat -ano 2>nul | findstr /R /C:":3000 .*LISTENING" >nul
if %errorlevel% equ 0 (
  echo  [INFO] CineVault is already running on http://localhost:3000
  start "" http://localhost:3000
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

start "" http://localhost:3000
node server.js
pause
