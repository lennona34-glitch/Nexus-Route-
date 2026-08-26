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

# 1. Check & Start NexusRoute Gateway (Port 3000)
$port3000 = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue

if ($port3000 -and $Restart) {
    $ownerPid = ($port3000 | Select-Object -First 1).OwningProcess
    Write-Host "[!] Stopping the gateway already on port 3000 (PID $ownerPid)..." -ForegroundColor Yellow
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
    # Run the TypeScript entry point directly, matching `npm start`. The compiled
    # dist output can be stale when a development build has not completed.
    Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory $rootDir -WindowStyle Hidden
    Start-Sleep -Seconds 2
} else {
    $ownerPid = ($port3000 | Select-Object -First 1).OwningProcess
    $since = try { (Get-Process -Id $ownerPid -ErrorAction Stop).StartTime } catch { $null }
    Write-Host "[*] A gateway is ALREADY running on port 3000 (PID $ownerPid)." -ForegroundColor Cyan
    if ($since) { Write-Host "    It started at $since, so it serves the code as of that moment." -ForegroundColor DarkGray }
    Write-Host "    Edits made since then are NOT live. Re-run with -Restart to replace it." -ForegroundColor Yellow
}

# 2. Check & Start Local RTX 4060 GPU Engine (Port 5005)
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
    Write-Host "[+] Starting RTX 4060 GPU Art Server on http://127.0.0.1:5005..." -ForegroundColor Green
    Start-Process -FilePath $pythonPath -ArgumentList "scripts/local_art_server.py" -WorkingDirectory $rootDir -WindowStyle Hidden
} elseif ($port5005) {
    Write-Host "[*] RTX 4060 GPU Art Server is already active on port 5005." -ForegroundColor Cyan
}

# 3. Launch Web UI in Default Browser
Write-Host "[+] Opening NexusRoute Web UI..." -ForegroundColor Green
Start-Process "http://localhost:3000"

Write-Host "
NexusRoute is ready! You can close this window." -ForegroundColor Yellow
Start-Sleep -Seconds 3
