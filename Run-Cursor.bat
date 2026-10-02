@echo off
title NexusRoute - Cursor AI IDE
setlocal enabledelayedexpansion

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"

:: Ensure NexusRoute gateway is alive
curl -s http://127.0.0.1:3000/health >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [NexusRoute] Gateway not detected on port 3000.
    echo [NexusRoute] Starting local server in background...
    start /min "NexusRoute Server" cmd /c "cd /d \"%NEXUS_DIR%\" && node dist/server.js"
    timeout /t 2 /nobreak >nul
)

set "CURSOR_EXE=%LOCALAPPDATA%\Programs\cursor\Cursor.exe"
if exist "%CURSOR_EXE%" (
    echo [NexusRoute] Launching Cursor IDE...
    if "%~1"=="" (
        start "" "%CURSOR_EXE%" "%NEXUS_DIR%"
    ) else (
        start "" "%CURSOR_EXE%" %*
    )
) else (
    echo [!] Cursor executable not found at %CURSOR_EXE%
    pause
)
