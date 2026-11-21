@echo off
setlocal enabledelayedexpansion
title Stop CineVault Movie Server
cd /d "%~dp0"

set "PORT=3000"
set "PID_FILE=%~dp0data\server.pid"
set "STOPPED=0"

echo.
echo  ============================================================
echo    Stopping CineVault All in One Movie Server...
echo  ============================================================
echo.

:: 1. Try stopping using saved PID file (including any child ffmpeg processes via /T)
if exist "%PID_FILE%" (
  set /p SAVED_PID=<"%PID_FILE%"
  if not "!SAVED_PID!"=="" (
    tasklist /FI "PID eq !SAVED_PID!" 2>nul | find /I "node.exe" >nul
    if !errorlevel! equ 0 (
      echo  [INFO] Stopping CineVault process ^(PID !SAVED_PID!^)...
      taskkill /PID !SAVED_PID! /T /F >nul 2>&1
      if !errorlevel! equ 0 set "STOPPED=1"
    )
  )
  del /Q "%PID_FILE%" >nul 2>&1
)

:: 2. Fallback: stop any process listening on port 3000 (handles servers started before PID file existed)
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  if not "%%P"=="0" (
    echo  [INFO] Stopping process listening on port %PORT% ^(PID %%P^)...
    taskkill /PID %%P /T /F >nul 2>&1
    if !errorlevel! equ 0 set "STOPPED=1"
  )
)

echo.
if "!STOPPED!"=="1" (
  echo  [OK] CineVault Movie Server has been stopped.
) else (
  echo  [INFO] CineVault Movie Server was not running.
)
echo.
ping -n 3 127.0.0.1 >nul
