@echo off
title Atrium OS - Frontend

cd /d "%~dp0\UI"

if not exist "node_modules" (
    echo Installing frontend dependencies...
    call npm install
)

echo Starting Vite dev server...
call npm run dev
pause