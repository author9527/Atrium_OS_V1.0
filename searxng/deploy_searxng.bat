@echo off
setlocal
cd /d "%~dp0"

set "BASE=%~dp0"
set "SRC=%BASE%searxng-src"
set "VENV=%BASE%searxng-venv"

REM Use the project's own full venv python first (most reliable), fall back to system python.
set "HOST_PY=%~dp0..\venv\Scripts\python.exe"
if not exist "%HOST_PY%" set "HOST_PY=python"

echo ============================================
echo  Atrium OS - SearXNG Deploy (pip method)
echo ============================================
echo.

REM 1. Create a dedicated virtual env
if not exist "%VENV%\Scripts\python.exe" (
    echo [1/5] Creating virtual environment...
    "%HOST_PY%" -m venv "%VENV%"
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual env. Please make sure Python 3.9+ is
        echo installed, or that the project venv exists at ..\venv.
        pause
        exit /b 1
    )
) else (
    echo [1/5] Virtual environment already exists, skip creation.
)

REM 2. Get SearXNG source (download official tarball + extract via stdlib)
if not exist "%SRC%" (
    echo [2/5] Downloading and extracting SearXNG source...
    cd /d "%BASE%"
    "%VENV%\Scripts\python.exe" _fetch_searxng.py
    if errorlevel 1 (
        echo [ERROR] Download/extract failed. Please check your network connection.
        pause
        exit /b 1
    )
) else (
    echo [2/5] SearXNG source already exists, skip download.
)

REM 3. Install dependencies
echo [3/5] Installing SearXNG dependencies (this may take a few minutes)...
cd /d "%SRC%"
"%VENV%\Scripts\python.exe" -m pip install --upgrade pip >nul 2>&1
"%VENV%\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo [ERROR] Dependency install failed. Some packages may need a C compiler,
    echo or the current Python version is incompatible. SearXNG supports Python 3.9+.
    pause
    exit /b 1
)

REM 4. Apply Windows compatibility patches (version_frozen, pwd, tomllib, extra deps)
echo [4/5] Applying Windows compatibility patches...
cd /d "%BASE%"
"%VENV%\Scripts\python.exe" _patch_win.py
if errorlevel 1 (
    echo [ERROR] Patch step failed.
    pause
    exit /b 1
)

REM 5. Generate settings.yml (enable JSON output + China-friendly engines)
echo [5/5] Generating settings.yml...
cd /d "%BASE%"
"%VENV%\Scripts\python.exe" _gen_settings.py
if errorlevel 1 (
    echo [ERROR] Failed to generate settings.yml.
    pause
    exit /b 1
)

echo.
echo Deploy finished!
echo Next: run start_searxng.bat to start the engine at http://127.0.0.1:8888
echo.
pause