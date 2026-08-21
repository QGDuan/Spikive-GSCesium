@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  echo Runtime dependencies are not installed. Run install.cmd first.
  exit /b 1
)
if "%HOST%"=="" set HOST=0.0.0.0
if "%PORT%"=="" set PORT=3000
if "%DATA_DIR%"=="" set DATA_DIR=var

echo Spikive GS Inspector is starting: http://localhost:%PORT%
call npm run server
