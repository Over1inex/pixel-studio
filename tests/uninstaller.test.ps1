$ErrorActionPreference='Stop'
$taskProject=Split-Path -Parent $PSScriptRoot
$taskWork=Join-Path $taskProject ('work/uninstall-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskWork | Out-Null
$taskApp=Join-Path $taskWork 'Pixel Studio.exe'
$taskSelf=Join-Path $taskWork 'Uninstall Pixel Studio.exe'
$taskDummyApp=Join-Path $taskWork 'dummy.cs'
[IO.File]::WriteAllText($taskDummyApp,'using System.Reflection; [assembly: AssemblyTitle("Pixel Studio")] class Dummy { static void Main() {} }')
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $taskCompiler /nologo /target:exe "/out:$taskApp" $taskDummyApp
if($LASTEXITCODE -ne 0){throw 'Fixture build failed'}
[IO.File]::WriteAllText($taskSelf,'disposable self fixture')
$taskKeep=Join-Path $taskWork 'my-project.pixel.json'
[IO.File]::WriteAllText($taskKeep,'{"keep":true}')
$taskOutside=Join-Path (Split-Path -Parent $taskWork) ('outside-'+[Guid]::NewGuid().ToString('N')+'.txt')
[IO.File]::WriteAllText($taskOutside,'keep outside')
# Run the real cleanup implementation with only its final message boxes replaced
# by console output. Never request deletion of real application data in this test.
$taskScript=[IO.File]::ReadAllText((Join-Path $taskProject 'desktop/uninstall.ps1'))
$taskScript=[Text.RegularExpressions.Regex]::Replace($taskScript,'(?m)^\s*\[Windows.Forms.MessageBox\]::Show.*$',"    Write-Output 'Cleanup result'")
$taskData=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PixelStudio'
foreach($taskInvalid in @($true,$false)){
 $taskApps=if($taskInvalid){@($taskApp,$taskOutside)}else{@($taskApp)}
 $taskPlan=@{root=$taskWork;apps=$taskApps;self=$taskSelf;dataDirectory=$taskData;removeData=$false;parentId=2147483000}|ConvertTo-Json -Compress
 $taskEncodedPlan=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($taskPlan))
 $taskRun='$taskPlan=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('''+$taskEncodedPlan+'''))|ConvertFrom-Json'+[Environment]::NewLine+$taskScript
 $taskEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskRun))
 & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $taskEncoded
 if($taskInvalid){if($LASTEXITCODE -ne 1 -or -not(Test-Path -LiteralPath $taskApp)){throw 'Unsafe cleanup plan was not rejected atomically'}}
 elseif($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $taskApp) -or (Test-Path -LiteralPath $taskSelf)){throw 'App cleanup failed'}
 if(-not(Test-Path -LiteralPath $taskKeep) -or -not(Test-Path -LiteralPath $taskOutside)){throw 'Cleanup removed user files'}
}
Write-Output 'Uninstaller: unsafe path rejected; own files removed; user project and outside file preserved.'
