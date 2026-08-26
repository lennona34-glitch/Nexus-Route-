@echo off
setlocal enabledelayedexpansion
title Ollama Model Installer
color 0B

:check_ollama
echo.
echo ========================================
echo    OLLAMA MODEL INSTALLER
echo ========================================
echo.

REM Check if Ollama is installed
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Ollama is not installed or not in PATH!
    echo.
    echo Please install Ollama from: https://ollama.ai
    echo.
    pause
    exit /b 1
)

echo [OK] Ollama detected!
echo.

:main_menu
echo ========================================
echo    SELECT INSTALLATION METHOD
echo ========================================
echo.
echo 1. Install from popular models list
echo 2. Install by entering model name manually
echo 3. View currently installed models
echo 4. Exit
echo.
set /p choice="Enter your choice (1-4): "

if "%choice%"=="1" goto popular_models
if "%choice%"=="2" goto manual_install
if "%choice%"=="3" goto view_installed
if "%choice%"=="4" goto end
echo.
echo [ERROR] Invalid choice. Please try again.
echo.
goto main_menu

:popular_models
cls
echo.
echo ========================================
echo    POPULAR OLLAMA MODELS
echo ========================================
echo.
echo SMALL MODELS (Fast, Lower Resource):
echo   1. llama3.2:1b        - Llama 3.2 1B (Fast, 1.3GB)
echo   2. llama3.2:3b        - Llama 3.2 3B (Balanced, 2GB)
echo   3. phi3:mini          - Microsoft Phi-3 Mini (3.8GB)
echo   4. gemma2:2b          - Google Gemma 2 2B (1.6GB)
echo.
echo MEDIUM MODELS (Balanced):
echo   5. llama3.1:8b        - Llama 3.1 8B (4.7GB)
echo   6. llama3.2:latest    - Llama 3.2 Latest (2GB)
echo   7. mistral:7b         - Mistral 7B (4.1GB)
echo   8. gemma2:9b          - Google Gemma 2 9B (5.5GB)
echo   9. phi3:medium        - Microsoft Phi-3 Medium (7.9GB)
echo.
echo LARGE MODELS (High Quality, More Resources):
echo  10. llama3.1:70b       - Llama 3.1 70B (40GB)
echo  11. mixtral:8x7b       - Mixtral 8x7B (26GB)
echo  12. qwen2.5:72b        - Qwen 2.5 72B (41GB)
echo.
echo SPECIALIZED MODELS:
echo  13. codellama:7b       - Code Llama 7B (3.8GB)
echo  14. codellama:13b      - Code Llama 13B (7.4GB)
echo  15. llama3.2-vision:11b - Llama 3.2 Vision (7.9GB)
echo  16. llava:7b           - LLaVA Vision 7B (4.7GB)
echo.
echo  0. Back to main menu
echo.
set /p model_choice="Enter model number (0-16): "

if "%model_choice%"=="0" goto main_menu
if "%model_choice%"=="1" set "model_name=llama3.2:1b"
if "%model_choice%"=="2" set "model_name=llama3.2:3b"
if "%model_choice%"=="3" set "model_name=phi3:mini"
if "%model_choice%"=="4" set "model_name=gemma2:2b"
if "%model_choice%"=="5" set "model_name=llama3.1:8b"
if "%model_choice%"=="6" set "model_name=llama3.2:latest"
if "%model_choice%"=="7" set "model_name=mistral:7b"
if "%model_choice%"=="8" set "model_name=gemma2:9b"
if "%model_choice%"=="9" set "model_name=phi3:medium"
if "%model_choice%"=="10" set "model_name=llama3.1:70b"
if "%model_choice%"=="11" set "model_name=mixtral:8x7b"
if "%model_choice%"=="12" set "model_name=qwen2.5:72b"
if "%model_choice%"=="13" set "model_name=codellama:7b"
if "%model_choice%"=="14" set "model_name=codellama:13b"
if "%model_choice%"=="15" set "model_name=llama3.2-vision:11b"
if "%model_choice%"=="16" set "model_name=llava:7b"

if not defined model_name (
    echo.
    echo [ERROR] Invalid choice. Please try again.
    echo.
    pause
    goto popular_models
)

goto install_model

:manual_install
cls
echo.
echo ========================================
echo    MANUAL MODEL INSTALLATION
echo ========================================
echo.
echo Enter the model name exactly as it appears on ollama.ai
echo Examples: llama3.2, mistral:7b, codellama:13b
echo.
echo Type 'back' to return to main menu
echo.
set /p model_name="Enter model name: "

if /i "%model_name%"=="back" goto main_menu
if "%model_name%"=="" (
    echo.
    echo [ERROR] Model name cannot be empty!
    echo.
    pause
    goto manual_install
)

goto install_model

:install_model
cls
echo.
echo ========================================
echo    INSTALLING MODEL
echo ========================================
echo.
echo Model: %model_name%
echo.
echo This may take several minutes depending on model size...
echo.
echo [INFO] Starting download and installation...
echo.

ollama pull %model_name%

if %errorlevel% equ 0 (
    color 0A
    echo.
    echo ========================================
    echo [SUCCESS] Model installed successfully!
    echo ========================================
    echo.
    echo Model: %model_name%
    echo.
    echo You can now use this model with:
    echo   ollama run %model_name%
    echo.
) else (
    color 0C
    echo.
    echo ========================================
    echo [ERROR] Installation failed!
    echo ========================================
    echo.
    echo Model: %model_name%
    echo.
    echo Possible reasons:
    echo - Model name is incorrect
    echo - Network connection issue
    echo - Insufficient disk space
    echo.
)

echo.
set /p continue="Install another model? (Y/N): "
if /i "%continue%"=="Y" (
    color 0B
    cls
    goto main_menu
)
goto end

:view_installed
cls
echo.
echo ========================================
echo    CURRENTLY INSTALLED MODELS
echo ========================================
echo.
ollama list
echo.
echo ========================================
echo.
pause
cls
goto main_menu

:end
echo.
echo Thank you for using Ollama Model Installer!
echo.
pause
exit /b 0
