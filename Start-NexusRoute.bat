@echo off
title NexusRoute Gateway Launcher

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"

cd /d "%NEXUS_DIR%"

if exist "%NEXUS_DIR%\NexusRoute.exe" (
    echo [*] Starting native NexusRoute.exe...
    start "" "%NEXUS_DIR%\NexusRoute.exe" %*
    exit /b 0
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%NEXUS_DIR%\scripts\start_servers.ps1" %*
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Launcher exited with error code %ERRORLEVEL%.
    pause
)

