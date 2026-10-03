param(
    # A gateway already listening on 3000 is left alone by default. That silently
    # keeps a stale build alive across edits, so -Restart replaces it instead.
    [switch]$Restart
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "       NexusRoute Gateway Launcher      " -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan

$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

# 0. Check Node.js prerequisite
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "`n[x] Node.js is required but was not found on your system PATH." -ForegroundColor Red
    Write-Host "    Please download and install Node.js (v18+) from https://nodejs.org" -ForegroundColor Yellow
    Write-Host "`nPress any key to exit..." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# 1. First-time setup: ensure .env exists
if (-not (Test-Path "$rootDir\.env")) {
    if (Test-Path "$rootDir\.env.example") {
        Copy-Item "$rootDir\.env.example" "$rootDir\.env"
        Write-Host "[+] Initialized .env configuration file from template." -ForegroundColor Green
    }
}

# 2. First-time setup: ensure node_modules are installed
if (-not (Test-Path "$rootDir\node_modules")) {
    Write-Host "`n[*] First-time setup detected: Installing required dependencies (npm install)..." -ForegroundColor Yellow
    Write-Host "    (This only needs to run once)..." -ForegroundColor DarkGray
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[x] npm install failed. Please check internet connection." -ForegroundColor Red
        exit 1
    }
    Write-Host "[+] Dependencies installed successfully!`n" -ForegroundColor Green
}

# 3. Ensure production bundle exists
if (-not (Test-Path "$rootDir\dist\server.bundle.mjs")) {
    Write-Host "[*] Building NexusRoute production bundle..." -ForegroundColor Yellow
    & npm.cmd run build:bundle
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[!] Bundle build failed, will fall back to development runner." -ForegroundColor DarkGray
    }
}

# 4. Check & Start NexusRoute Gateway (Port 3000)
$port3000 = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue

if ($port3000 -and $Restart) {
    $ownerPid = ($port3000 | Select-Object -First 1).OwningProcess
    Write-Host "[!] Stopping existing gateway on port 3000 (PID $ownerPid)..." -ForegroundColor Yellow
    try {
        Stop-Process -Id $ownerPid -Force -ErrorAction Stop
        Start-Sleep -Seconds 2
        $port3000 = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
    } catch {
        Write-Host "[x] Could not stop PID ${ownerPid}: $($_.Exception.Message)" -ForegroundColor Red
    }
}

if (-not $port3000) {
    Write-Host "[+] Starting NexusRoute Gateway on http://localhost:3000..." -ForegroundColor Green
    if (Test-Path "$rootDir\dist\server.bundle.mjs") {
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c start /min `"NexusRoute Server`" node dist/server.bundle.mjs" -WorkingDirectory $rootDir -WindowStyle Hidden
    } else {
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c start /min `"NexusRoute Server`" npm start" -WorkingDirectory $rootDir -WindowStyle Hidden
    }

    # Wait for gateway to be alive
    Write-Host "[*] Waiting for gateway to be ready..." -ForegroundColor DarkGray
    $attempts = 0
    $ready = $false
    while ($attempts -lt 15) {
        Start-Sleep -Seconds 1
        $attempts++
        try {
            $res = Invoke-RestMethod -Uri "http://127.0.0.1:3000/health" -TimeoutSec 1 -ErrorAction Stop
            if ($res.status -eq 'ok') {
                $ready = $true
                break
            }
        } catch {}
    }

    if ($ready) {
        Write-Host "[+] NexusRoute Gateway is online!" -ForegroundColor Green
    } else {
        Write-Host "[!] Server started, opening browser..." -ForegroundColor Yellow
    }
} else {
    $ownerPid = ($port3000 | Select-Object -First 1).OwningProcess
    $since = try { (Get-Process -Id $ownerPid -ErrorAction Stop).StartTime } catch { $null }
    Write-Host "[*] A gateway is ALREADY running on port 3000 (PID $ownerPid)." -ForegroundColor Cyan
    if ($since) { Write-Host "    It started at $since." -ForegroundColor DarkGray }
    Write-Host "    To reload latest changes, run Restart-NexusRoute.bat." -ForegroundColor Yellow
}

# 5. Check & Start Local RTX 4060 GPU Engine (Port 5005)
$port5005 = Get-NetTCPConnection -LocalPort 5005 -ErrorAction SilentlyContinue
$candidatePythons = @(
    (Join-Path (Split-Path -Parent $rootDir) "nexus-art-engine\Scripts\python.exe")
    (Join-Path $rootDir ".venv\Scripts\python.exe")
    "python"
)

$pythonPath = $null
foreach ($py in $candidatePythons) {
    if (Get-Command $py -ErrorAction SilentlyContinue) {
        $pythonPath = $py
        break
    }
}

if ($pythonPath -and (-not $port5005)) {
    Write-Host "[+] Starting RTX GPU Art Server on http://127.0.0.1:5005..." -ForegroundColor Green
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c start /min `"NexusRoute Art Engine`" `"$pythonPath`" scripts/local_art_server.py" -WorkingDirectory $rootDir -WindowStyle Hidden
} elseif ($port5005) {
    Write-Host "[*] RTX GPU Art Server is already active on port 5005." -ForegroundColor Cyan
}

# 6. Launch Web UI in Default Browser
Write-Host "[+] Opening NexusRoute Web UI..." -ForegroundColor Green
Start-Process "http://localhost:3000"

Write-Host "`nNexusRoute is ready! Enjoy." -ForegroundColor Yellow
Start-Sleep -Seconds 2
