@echo off
setlocal
cd /d "%~dp0"

set "BASE=%~dp0"
set "SRC=%BASE%searxng-src"
set "VENV=%BASE%searxng-venv"

if not exist "%VENV%\Scripts\python.exe" (
    echo [ERROR] Not deployed yet. Please run deploy_searxng.bat first.
    pause
    exit /b 1
)
if not exist "%BASE%settings.yml" (
    echo [ERROR] settings.yml missing. Please run deploy_searxng.bat first.
    pause
    exit /b 1
)

echo Starting SearXNG at http://127.0.0.1:8888 (press Ctrl+C to stop)...
echo.
cd /d "%SRC%"
set "SEARXNG_SETTINGS_PATH=%BASE%settings.yml"
"%VENV%\Scripts\python.exe" -m searx.webapp
pause