@echo off
cd /d "%~dp0"
npm.cmd run dev -- --host localhost --port 5173 --strictPort
