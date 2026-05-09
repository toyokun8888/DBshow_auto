@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0codex_health_check.ps1" %*
