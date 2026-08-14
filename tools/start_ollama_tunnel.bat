@echo off
title Atrium_OS - Public Tunnel (Ollama + SearXNG)
cd /d "%~dp0"

set "CURL=C:\Windows\System32\curl.exe"

echo ============================================
echo   Atrium_OS - Public Tunnel Launcher
echo ============================================
echo.

echo [1/3] Checking local Ollama on port 11434 ...
"%CURL%" -s -o NUL -w "%%{http_code}" http://localhost:11434/api/tags > _code.tmp 2>nul
set /p CODE=<_code.tmp
del _code.tmp >nul 2>nul
if "%CODE%"=="200" (
    echo        OK: Ollama is running
) else (
    echo        WARNING: Ollama not detected (HTTP %CODE%). Start Ollama first.
)
echo.

echo [2/3] Checking local SearXNG on port 8888 ...
"%CURL%" -s -o NUL -w "%%{http_code}" http://localhost:8888 > _code2.tmp 2>nul
set /p CODE2=<_code2.tmp
del _code2.tmp >nul 2>nul
if "%CODE2%"=="200" (
    echo        OK: SearXNG is running
) else (
    echo        WARNING: SearXNG not detected (HTTP %CODE2%).
    echo        Start it first:  searxng\start_searxng.bat
)
echo.

echo [3/3] Starting Cloudflare public tunnels and fetching URLs ...
echo.
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0_ollama_tunnel_helper.ps1"
echo.
pause