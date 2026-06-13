# Wrapper script: keeps StripDiceBot running, restarting it if the process exits/crashes.
$ErrorActionPreference = "Continue"

$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8

while ($true) {
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$time] Starting StripDiceBot..."

    # Redirect via cmd.exe so output is appended as raw UTF-8 bytes, regardless
    # of PowerShell's pipeline encoding (which can flip to UTF-16LE on restart).
    cmd /c "node build/index.js >> wrapper.output 2>&1"

    $exitCode = $LASTEXITCODE
    $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$time] StripDiceBot exited with code $exitCode. Restarting in 10 seconds..."

    Start-Sleep -Seconds 10
}
