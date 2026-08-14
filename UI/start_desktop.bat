@echo off
chcp 65001 >nul
title Atrium OS - 桌面版

cd /d "%~dp0"

echo ========================================
echo   Atrium OS V1.0 - 桌面版
echo ========================================
echo.

REM 检查依赖
if not exist "node_modules" (
    echo [1/2] 安装前端依赖...
    call npm install
)

REM 检查 Python 虚拟环境
if not exist "..\venv" (
    echo [2/2] 创建 Python 虚拟环境...
    cd ..
    python -m venv venv
    call venv\Scripts\activate.bat
    pip install -r requirements.txt -q
    cd UI
)

echo.
echo 启动桌面应用...
call npm run dev:electron
pause