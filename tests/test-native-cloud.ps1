$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskWork=Join-Path $taskRoot ('work/native-cloud-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskWork | Out-Null
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$taskExe=Join-Path $taskWork 'native-cloud-tests.exe'
& $taskCompiler /nologo /target:exe /reference:System.Web.Extensions.dll "/out:$taskExe" (Join-Path $taskRoot 'desktop/CloudDiagnostics.cs') (Join-Path $PSScriptRoot 'native-cloud.cs')
if($LASTEXITCODE -ne 0){throw 'Native cloud test build failed'}
& $taskExe $taskWork
if($LASTEXITCODE -ne 0){throw 'Native cloud tests failed'}
