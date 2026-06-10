@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PS1_PATH=%SCRIPT_DIR%open_manual_master_searches.ps1"
if not exist "%PS1_PATH%" set "PS1_PATH=C:\Users\toyoaki\Desktop\filedatachange\open_manual_master_searches.ps1"

set "CSV_PATH=%~1"
if "%CSV_PATH%"=="" if exist "%SCRIPT_DIR%manual_master_import.csv" set "CSV_PATH=%SCRIPT_DIR%manual_master_import.csv"
if "%CSV_PATH%"=="" set "CSV_PATH=C:\Users\toyoaki\Desktop\filedatachange\manual_master_import.csv"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1_PATH%" -CsvPath "%CSV_PATH%" -BatchSize 10

echo.
echo Finished. Press any key to close.
pause >nul
