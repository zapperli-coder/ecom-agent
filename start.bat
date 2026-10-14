@echo off
REM Double-click launcher — runs start.ps1 and keeps the window open on exit.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
