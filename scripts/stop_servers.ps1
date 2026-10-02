Write-Host "========================================" -ForegroundColor Cyan
Write-Host "       NexusRoute Server Shutdown       " -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan

$stoppedAny = $false

# 1. Stop NexusRoute Gateway (Port 3000)
$port3000 = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
if ($port3000) {
    $pids = $port3000 | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pidToKill in $pids) {
        if ($pidToKill -gt 0) {
            Write-Host "[!] Terminating NexusRoute Gateway process (PID $pidToKill)..." -ForegroundColor Yellow
            try {
                Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
                $stoppedAny = $true
            } catch {}
        }
    }
}

# 2. Stop GPU Art Server (Port 5005)
$port5005 = Get-NetTCPConnection -LocalPort 5005 -ErrorAction SilentlyContinue
if ($port5005) {
    $pids = $port5005 | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pidToKill in $pids) {
        if ($pidToKill -gt 0) {
            Write-Host "[!] Terminating GPU Art Server process (PID $pidToKill)..." -ForegroundColor Yellow
            try {
                Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
                $stoppedAny = $true
            } catch {}
        }
    }
}

# 3. Stop Embedded Ollama daemon if started from nexus-route\bin\engine
$ollamaProcs = Get-Process ollama -ErrorAction SilentlyContinue
if ($ollamaProcs) {
    foreach ($p in $ollamaProcs) {
        try {
            $path = $p.Path
            if ($path -and ($path -like "*nexus-route*")) {
                Write-Host "[!] Terminating Embedded Ollama engine (PID $($p.Id))..." -ForegroundColor Yellow
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
                $stoppedAny = $true
            }
        } catch {}
    }
}

# Verify shutdown
Start-Sleep -Seconds 1
$check3000 = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
$check5005 = Get-NetTCPConnection -LocalPort 5005 -ErrorAction SilentlyContinue

if (-not $check3000 -and -not $check5005) {
    Write-Host "`n[OK] NexusRoute and all associated servers have been stopped successfully." -ForegroundColor Green
} else {
    Write-Host "`n[!] Some processes may still be running. Cleaning up remaining node instances..." -ForegroundColor Yellow
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*node.exe*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Shutdown complete." -ForegroundColor Green
}
