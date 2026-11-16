@echo off
REM Windows launcher: starts the controller and opens it in the browser.
REM The implementation lives in launch\windows\start-gui.ps1.
setlocal
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%launch\windows\start-gui.ps1" %*
if errorlevel 1 pause
endlocal
