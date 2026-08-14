@echo off
chcp 65001 >nul
REM ============================================
REM Atrium_OS 公网访问启动脚本（Cloudflare Tunnel 快速隧道）
REM 作用：把本机 8000 端口后端映射成公网 https 网址，供手机端远程访问
REM 注意：每次启动网址都会变化，请从终端输出中复制新的网址
REM ============================================

echo [1/2] 检查后端是否在运行...
curl -s -o nul -w "%%{http_code}" http://localhost:8000/docs > %~dp0_health.tmp 2>nul
set /p code=<%~dp0_health.tmp
del %~dp0_health.tmp >nul 2>nul
if "%code%"=="200" (
    echo      后端运行正常 (HTTP 200)
) else (
    echo      警告: 后端似乎未运行，请先启动 start_server.py
)

echo [2/2] 启动 Cloudflare 公网隧道 (Ctrl+C 停止)...
echo.
%~dp0cloudflared.exe tunnel --url http://localhost:8000 --no-autoupdate
echo.
echo 隧道已停止。按任意键退出...
pause >nul