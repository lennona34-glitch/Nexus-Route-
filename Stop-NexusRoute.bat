@echo off
title NexusRoute Gateway - Shutdown

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"

cd /d "%NEXUS_DIR%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%NEXUS_DIR%\scripts\stop_servers.ps1"
echo.
echo Press any key to close...
pause >nul
