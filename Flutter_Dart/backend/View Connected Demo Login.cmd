@echo off
setlocal
pushd "%~dp0"
if not exist "data\clinch-connected-demo-owner.xml" (
  echo Open Start Clinch Shared Demo.cmd first to create the connected demo account.
  pause
  exit /b 1
)
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $c=Import-Clixml -LiteralPath 'data/clinch-connected-demo-owner.xml'; Write-Host ('Owner email: ' + $c.UserName); Write-Host ('Owner password: ' + $c.GetNetworkCredential().Password)"
pause
popd
