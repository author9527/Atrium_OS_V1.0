@echo off
chcp 65001 >nul
title Atrium_OS - 一键启动公网隧道 (Ollama + SearXNG)
cd /d "%~dp0"

set "CURL=C:\Windows\System32\curl.exe"
set "ROOT=%~dp0.."

echo ============================================
echo   Atrium_OS - 一键启动公网隧道
echo ============================================
echo.

echo [1/4] 检查 Ollama (端口 11434) ...
"%CURL%" -s -o NUL -w "%%{http_code}" http://localhost:11434/api/tags > _code.tmp 2>nul
set /p CODE=<_code.tmp
del _code.tmp >nul 2>nul
if "%CODE%"=="200" (
    echo       OK: Ollama 已在运行
) else (
    echo       启动 Ollama ...
    start "" /B "ollama" serve
    timeout /t 3 /nobreak >nul
    echo       Ollama 已启动
)
echo.

echo [2/4] 检查 SearXNG (端口 8888) ...
"%CURL%" -s -o NUL -w "%%{http_code}" http://localhost:8888 > _code2.tmp 2>nul
set /p CODE2=<_code2.tmp
del _code2.tmp >nul 2>nul
if "%CODE2%"=="200" (
    echo       OK: SearXNG 已在运行
) else (
    echo       启动 SearXNG ...
    set "SEARXNG_SETTINGS_PATH=%ROOT%\searxng\settings.yml"
    start "SearXNG" /MIN "%ROOT%\searxng\searxng-venv\Scripts\python.exe" -m searx.webapp
    echo       等待 SearXNG 启动 ...
    timeout /t 8 /nobreak >nul
    echo       SearXNG 已启动
)
echo.

echo [3/4] 启动 Cloudflare 公网隧道 ...
echo.
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0_ollama_tunnel_helper.ps1"
echo.

echo [4/4] 完成!
echo.
echo ============================================
echo   手机端配置地址 (每次启动会变化，请更新):
echo.
echo   Ollama 地址  : 见上方 Ollama URL
echo   搜索服务地址  : 见上方 SearXNG URL
echo.
echo   注意: 地址不含端口号和路径后缀
echo   隧道持续运行，关闭此窗口或电脑重启后需重新运行
echo ============================================
echo.
pause
