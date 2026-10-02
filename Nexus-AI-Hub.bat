@echo off
title NexusRoute - AI CLI Hub & Manager
setlocal enabledelayedexpansion

set "PATH=C:\Program Files\Git\bin;C:\Program Files\Git\usr\bin;C:\Program Files\Git\cmd;%PATH%"

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"

:menu
cls
echo ===================================================================
echo             NEXUSROUTE AI CODING HUB ^& CLI MANAGER
echo ===================================================================
echo  Gateway Target: http://127.0.0.1:3000 (Local Loopback)
echo  Active Engines: DeepSeek V4, CheaperInference, Groq, RTX 4060 GPU
echo ===================================================================
echo.
echo  --- LAUNCH CODING AGENTS ^& IDEs ---
echo   [1] Launch Claude Code CLI (Autonomous Mode)
echo   [2] Launch Aider Terminal Agent (Git Pair Programmer)
echo   [3] Launch OpenAI Codex CLI (Autonomous Terminal Agent)
echo   [4] Launch Cursor AI IDE
echo   [5] Open NexusRoute Web UI ^& Inspector Dashboard
echo.
echo  --- INSTALL / UPDATE CLIs ---
echo   [6] Install / Update Claude Code  (npm install -g @anthropic-ai/claude-code)
echo   [7] Install / Update Aider Chat   (pip install -U aider-chat)
echo   [8] Install / Update Codex CLI    (npm install -g @openai/codex)
echo.
echo  --- GATEWAY CONTROLS ---
echo   [9] Start NexusRoute Gateway (Port 3000)
echo   [10] Restart NexusRoute Gateway (Reload latest code)
echo   [11] Stop All NexusRoute Servers (Shutdown Port 3000, 5005, local GPU)
echo   [0] Exit
echo.
echo ===================================================================
set /p choice="Select an option (0-11): "

if "%choice%"=="1" goto :launch_claude
if "%choice%"=="2" goto :launch_aider
if "%choice%"=="3" goto :launch_codex
if "%choice%"=="4" goto :launch_cursor
if "%choice%"=="5" goto :launch_web
if "%choice%"=="6" goto :install_claude
if "%choice%"=="7" goto :install_aider
if "%choice%"=="8" goto :install_codex
if "%choice%"=="9" goto :start_gateway
if "%choice%"=="10" goto :restart_gateway
if "%choice%"=="11" goto :stop_gateway
if "%choice%"=="0" exit /b 0

echo Invalid selection.
timeout /t 2 >nul
goto :menu

:launch_claude
cls
call "%NEXUS_DIR%\run-claude-code.bat"
goto :menu

:launch_aider
cls
call "%NEXUS_DIR%\Run-Aider.bat"
goto :menu

:launch_codex
cls
call "%NEXUS_DIR%\Run-Codex.bat"
goto :menu

:launch_cursor
cls
call "%NEXUS_DIR%\Run-Cursor.bat"
goto :menu

:launch_web
start http://127.0.0.1:3000
goto :menu

:install_claude
cls
echo [NexusRoute] Installing/Updating Claude Code CLI...
echo.
call npm install -g @anthropic-ai/claude-code
echo.
echo Installation complete!
pause
goto :menu

:install_aider
cls
echo [NexusRoute] Installing/Updating Aider Terminal Agent...
echo.
call pip install -U aider-chat
echo.
echo Installation complete!
pause
goto :menu

:install_codex
cls
echo [NexusRoute] Installing/Updating OpenAI Codex CLI...
echo.
call npm install -g @openai/codex
echo.
echo Installation complete!
pause
goto :menu

:start_gateway
cls
call "%NEXUS_DIR%\Start-NexusRoute.bat"
timeout /t 2 >nul
goto :menu

:restart_gateway
cls
call "%NEXUS_DIR%\Restart-NexusRoute.bat"
timeout /t 2 >nul
goto :menu

:stop_gateway
cls
call "%NEXUS_DIR%\Stop-NexusRoute.bat"
goto :menu
