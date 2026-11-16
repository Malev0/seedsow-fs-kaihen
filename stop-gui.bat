@echo off
REM Windows launcher: stops the controller, its run children, the bridge and the
REM console loop. The implementation lives in launch\windows\stop-gui.ps1.
setlocal
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%launch\windows\stop-gui.ps1" %*
if errorlevel 1 pause
endlocal
