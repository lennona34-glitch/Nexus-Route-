@echo off
title NexusRoute - Claude Code Gateway
setlocal enabledelayedexpansion

echo ========================================================
echo   NexusRoute Gateway - Claude Code Integration
echo   Base URL : http://localhost:3000
echo   API Key  : nr-live-local (Handled by NexusRoute)
echo ========================================================
echo.

:: Ensure Git Bash & POSIX CLI tools are in PATH for Claude Code tool execution
set "PATH=C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;C:\Program Files\Git\cmd;%PATH%"

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"

:: Check if NexusRoute server is already responding on port 3000
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
    echo [!] Server is taking a few moments to initialize. Launching Claude Code...
    goto :ready
)

:ready
echo [NexusRoute] Local Gateway is ready on http://127.0.0.1:3000!
echo.

:: Configure environment for Claude Code proxy
set ANTHROPIC_AUTH_TOKEN=
set ANTHROPIC_BASE_URL=http://localhost:3000
set ANTHROPIC_API_KEY=nr-live-local
set ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
set ANTHROPIC_DEFAULT_SONNET_MODEL=claude-3-5-sonnet-20241022
set ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-3-5-sonnet-20241022
set ANTHROPIC_DEFAULT_OPUS_MODEL=claude-3-5-sonnet-20241022
set CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1

where claude >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    claude %*
) else (
    echo [NexusRoute] Launching Claude Code CLI via npx...
    npx @anthropic-ai/claude-code %*
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [NexusRoute] Tip: If npx prompted to install @anthropic-ai/claude-code, run:
    echo        npm install -g @anthropic-ai/claude-code
)

echo.
pause
