@echo off
setlocal
pushd "%~dp0"
set "CLINCH_DB=%CD%\data\clinch-connected-demo.sqlite"
set "CLINCH_SYNC_LIVE=1"
if not exist "%CLINCH_DB%" (
  echo Could not find the app database at:
  echo %CLINCH_DB%
  echo Run "Start Clinch Shared Demo.cmd" once first, so the database exists.
  pause
  exit /b 1
)
if not exist "%APPDATA%\gcloud\application_default_credentials.json" (
  echo Google sign-in is missing on this PC. Run this once, then start again:
  echo   gcloud auth application-default login
  pause
  exit /b 1
)
if not exist "node_modules\firebase-admin" (
  echo Installing the sync packages, one time...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if "%CLINCH_FIREBASE_OPERATOR_UID%"=="" echo Note: CLINCH_FIREBASE_OPERATOR_UID is not set, so synced sales are tagged with the app's local owner id.
echo Syncing the app with the website (Firestore project clinch-demo). Keep this window open.
node server\clinch-sync.mjs
if errorlevel 1 pause
popd