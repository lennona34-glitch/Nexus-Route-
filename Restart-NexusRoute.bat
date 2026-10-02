@echo off
title NexusRoute Gateway - Restart

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"

cd /d "%NEXUS_DIR%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%NEXUS_DIR%\scripts\start_servers.ps1" -Restart
