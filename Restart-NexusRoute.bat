@echo off
title NexusRoute Gateway - Restart
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_servers.ps1" -Restart
