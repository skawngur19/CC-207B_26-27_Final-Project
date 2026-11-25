@echo off
setlocal
set "CLINCH_BACKEND_DIR=%~dp0backend"
if not exist "%CLINCH_BACKEND_DIR%\View Connected Demo Login.cmd" (
  echo Could not find the Clinch backend at:
  echo %CLINCH_BACKEND_DIR%
  echo Set CLINCH_BACKEND_DIR to the folder containing the backend launcher.
  pause
  exit /b 1
)
call "%CLINCH_BACKEND_DIR%\View Connected Demo Login.cmd"
