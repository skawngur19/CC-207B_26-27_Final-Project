@echo off
setlocal
pushd "%~dp0"
set "CLINCH_BACKEND_DIR=%CD%"
set "CLINCH_DB=%CD%\data\clinch-connected-demo.sqlite"
set "CLINCH_OWNER_ACCESS_FILE=%CD%\data\clinch-connected-demo-owner.xml"
set "CLINCH_AUTH_PROVIDER=local"
set "CLINCH_HOST=127.0.0.1"
set "CLINCH_PORT=8788"
set "CLINCH_PUBLIC_ORIGIN="
set "CLINCH_WEB_ROOT=%CD%\artifacts\Clinch-Local-Demo"
if not exist "%CLINCH_OWNER_ACCESS_FILE%" (
  if exist "%CLINCH_DB%" (
    echo Connected demo database exists but its protected Owner credential file is missing.
    echo Keep the database unchanged and contact the app maintainer for recovery.
    pause
    exit /b 1
  )
  echo Creating a private Owner account for the shared website and app demo...
  node tools\initialize-owner.mjs
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Open http://127.0.0.1:8788 in your browser and keep this window open.
node server\main.mjs
if errorlevel 1 pause
popd
