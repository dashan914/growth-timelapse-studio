@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0scripts\launch.mjs" --source "%~dp0."
if errorlevel 1 pause
endlocal
