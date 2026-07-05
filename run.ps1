# Wrapper script: keeps StripDiceBot running, restarting it if the process exits/crashes.
$ErrorActionPreference = "Continue"

$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$host.UI.RawUI.WindowTitle = "StripDiceBot"

while ($true) {
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$time] Starting StripDiceBot..."

    Write-Host "[wrapper] Building latest source..."
    Push-Location $PSScriptRoot
    npm run build
    Pop-Location

    # Redirect via cmd.exe so output is appended as raw UTF-8 bytes, regardless
    # of PowerShell's pipeline encoding (which can flip to UTF-16LE on restart).
    # Log file is dated so each calendar day gets its own file; the date is
    # evaluated once per restart, so the file rolls over on the next restart
    # after midnight.
    $logDate = Get-Date -Format "yyyy-MM-dd"
    $logFile = "wrapper_$logDate.log"
    cmd /c "node build/index.js >> $logFile 2>&1"

    $exitCode = $LASTEXITCODE
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$time] StripDiceBot exited with code $exitCode. Restarting in 10 seconds..."

    Start-Sleep -Seconds 10
}
