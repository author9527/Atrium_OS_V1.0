@echo off
echo ============================================
echo   Atrium OS - Firewall Setup
echo   Open ports 8000 and 8081 for mobile
echo ============================================
echo.

:: Check admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] This script requires administrator privileges.
    echo         Right-click and select "Run as administrator".
    echo.
    pause
    exit /b 1
)

echo Adding firewall rule for port 8000...
netsh advfirewall firewall add rule name="Atrium OS Backend (8000)" dir=in action=allow protocol=TCP localport=8000
if %errorlevel% equ 0 (
    echo [OK] Port 8000 opened
) else (
    echo [WARN] Port 8000 rule may already exist
)

echo Adding firewall rule for port 8081...
netsh advfirewall firewall add rule name="Expo Metro (8081)" dir=in action=allow protocol=TCP localport=8081
if %errorlevel% equ 0 (
    echo [OK] Port 8081 opened
) else (
    echo [WARN] Port 8081 rule may already exist
)

echo.
echo All firewall rules configured.
echo.
pause