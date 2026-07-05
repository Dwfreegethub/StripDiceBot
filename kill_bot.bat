@echo off
echo === StripDiceBot Kill Script ===
echo.
echo Searching for node.exe processes...
tasklist /FI "IMAGENAME eq node.exe" /FO TABLE 2>NUL
echo.
echo Killing all node.exe processes...
taskkill /F /IM node.exe /T 2>NUL
if %ERRORLEVEL% EQU 0 (
    echo SUCCESS: node.exe processes terminated.
) else (
    echo INFO: No node.exe processes found, or already terminated.
)
echo.
echo Verifying...
tasklist /FI "IMAGENAME eq node.exe" /FO TABLE 2>NUL
echo.
echo Done.
pause
