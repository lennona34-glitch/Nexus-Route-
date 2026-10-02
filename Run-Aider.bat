@echo off
title NexusRoute - Aider Coding Agent
setlocal enabledelayedexpansion

set "PATH=C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;C:\Program Files\Git\cmd;%PATH%"

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"

:: Ensure NexusRoute gateway is alive
curl -s http://127.0.0.1:3000/health >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [NexusRoute] Gateway not detected on port 3000.
    echo [NexusRoute] Starting local server in background...
    start /min "NexusRoute Server" cmd /c "cd /d \"%NEXUS_DIR%\" && node dist/server.js"
    
    echo [NexusRoute] Waiting for Gateway to be ready...
    set /a attempts=0
    :wait_loop
    timeout /t 1 /nobreak >nul
    set /a attempts+=1
    curl -s http://127.0.0.1:3000/health >nul 2>nul
    if %ERRORLEVEL% EQU 0 goto :ready
    if !attempts! GEQ 15 goto :timeout
    goto :wait_loop

    :timeout
    echo [!] Server is taking a few moments to initialize. Launching Aider...
    goto :ready
)

:ready
echo [NexusRoute] Local Gateway is ready on http://127.0.0.1:3000!
echo.

:: Configure environment for OpenAI / Aider proxy
set "OPENAI_API_BASE=http://127.0.0.1:3000/v1"
set "OPENAI_BASE_URL=http://127.0.0.1:3000/v1"
set "OPENAI_API_KEY=nr-live-local"

where aider >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    aider --model openai/deepseek-chat --no-show-model-warnings --yes-always %*
) else (
    echo [!] Aider is not currently installed.
    echo [*] Installing Aider via pip...
    pip install aider-chat
    echo.
    echo [*] Starting Aider...
    aider --model openai/deepseek-chat --no-show-model-warnings --yes-always %*
)

echo.
pause
