@echo off
title Atrium OS - Mobile Dev Server
cd /d "%~dp0\mobile"

echo ============================================
echo   Atrium OS - Mobile Dev Server
echo ============================================
echo.

:: Get Tailscale IP
set "TAILSCALE_IP="
set "TAILSCALE_EXE="
where tailscale >nul 2>&1 && set "TAILSCALE_EXE=tailscale"
if not defined TAILSCALE_EXE (
    if exist "C:\Program Files\Tailscale\tailscale.exe" set "TAILSCALE_EXE=C:\Program Files\Tailscale\tailscale.exe"
)
if not defined TAILSCALE_EXE (
    if exist "%ProgramFiles%\Tailscale\tailscale.exe" set "TAILSCALE_EXE=%ProgramFiles%\Tailscale\tailscale.exe"
)
if defined TAILSCALE_EXE (
    for /f "delims=" %%i in ('"%TAILSCALE_EXE%" ip -4 2^>nul') do set "TAILSCALE_IP=%%i"
)

if defined TAILSCALE_IP (
    echo [Tailscale] IP: %TAILSCALE_IP%
    echo [Metro] Binding to: exp://%TAILSCALE_IP%:8081
    echo.
    set "REACT_NATIVE_PACKAGER_HOSTNAME=%TAILSCALE_IP%"
) else (
    echo [WARNING] Tailscale not found.
    echo          Running on localhost only.
    echo          Phone must be on same WiFi as PC.
    echo.
)

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Starting Expo dev server (clearing cache)...
echo Scan the QR code with Expo Go to connect.
echo.
call npx expo start --clear

pause