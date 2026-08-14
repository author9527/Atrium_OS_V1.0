@echo off
title Atrium OS - Backend

cd /d "%~dp0"

echo.
echo ============================================
echo   Atrium OS - Backend Starting...
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
    echo [Tailscale] IP detected: %TAILSCALE_IP%
    echo.
    echo   Mobile app connect URL:
    echo   http://%TAILSCALE_IP%:8000
    echo.
) else (
    echo [WARNING] Tailscale not found.
    echo          Mobile app will not be able to connect.
    echo          Please install and login to Tailscale.
    echo.
)

echo [Local] Backend URL: http://localhost:8000
echo ============================================
echo.

if exist "venv\Scripts\python.exe" (
    venv\Scripts\python.exe start_server.py
) else (
    python start_server.py
)

pause