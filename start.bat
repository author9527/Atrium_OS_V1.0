@echo off
title Atrium OS V1.0

echo ========================================
echo   Atrium OS V1.0
echo ========================================
echo.

REM check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.10+
    pause
    exit /b 1
)

REM check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js 18+
    pause
    exit /b 1
)

REM check Ollama
curl -s http://localhost:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo [WARNING] Ollama not running. AI features will be unavailable.
    echo.
)

cd /d "%~dp0"

if not exist "venv" (
    echo [1/3] Creating Python virtual environment...
    python -m venv venv
    call venv\Scripts\activate.bat
    echo [2/3] Installing Python dependencies...
    pip install -r requirements.txt -q
) else (
    call venv\Scripts\activate.bat
)

if not exist "UI\node_modules" (
    echo [3/3] Installing frontend dependencies...
    cd UI
    call npm install
    cd ..
) else (
    echo [3/3] Frontend dependencies ready
)

echo.
echo ========================================
echo   Starting services...
echo ========================================
echo.

echo [Backend] Starting FastAPI (port 8000)...
start "Atrium-OS-Backend" /min venv\Scripts\python.exe start_server.py

echo [Backend] Waiting for service...
:wait_backend
timeout /t 2 /nobreak >nul
curl -s http://localhost:8000/api/health >nul 2>&1
if errorlevel 1 goto wait_backend
echo [Backend] Ready

echo [Frontend] Starting Vite dev server (port 5173)...
start "Atrium-OS-Frontend" /min powershell -Command "Set-Location '%~dp0UI'; npm run dev"

echo [Frontend] Waiting for service...
:wait_frontend
timeout /t 2 /nobreak >nul
curl -s http://localhost:5173 >nul 2>&1
if errorlevel 1 goto wait_frontend

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

echo.
echo ========================================
echo   Atrium OS Started!
echo   Frontend: http://localhost:5173
echo   Backend:  http://localhost:8000
echo   API Docs: http://localhost:8000/docs
if defined TAILSCALE_IP (
    echo   Mobile:   http://%TAILSCALE_IP%:8000
)
echo ========================================
echo.
echo Press any key to open browser...
pause >nul
start http://localhost:5173