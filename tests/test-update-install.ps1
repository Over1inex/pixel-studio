$ErrorActionPreference='Stop'
$taskProject=Split-Path -Parent $PSScriptRoot
$taskWork=Join-Path $taskProject ('work/update-install-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskWork|Out-Null
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$taskScript=[IO.File]::ReadAllText((Join-Path $taskProject 'desktop/apply-update.ps1'))
# Only this test copy substitutes an isolated cache root and console errors.
$taskScript=$taskScript.Replace("`$taskExpected=Get-UpdateFullPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PixelStudio/Updates')",' $taskExpected=Get-UpdateFullPath '+"'"+(Join-Path $taskWork 'Updates')+"'")
$taskScript=[Text.RegularExpressions.Regex]::Replace($taskScript,'(?m)^\s*\[Windows.Forms.MessageBox\]::Show.*$'," Write-Output 'Expected update failure'")
foreach($taskMode in @('success','tampered','locked')){
 $taskInstall=Join-Path $taskWork $taskMode
 $taskStage=Join-Path $taskWork ('Updates/0.2.2-'+[Guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $taskInstall,$taskStage -Force|Out-Null
 foreach($taskVersion in @('0.2.1','0.2.2')){
  foreach($taskName in @('Pixel Studio.exe','Удалить Pixel Studio.exe')){
   $taskTitle=if($taskName -eq 'Pixel Studio.exe'){'Pixel Studio'}else{'Удаление Pixel Studio'}
   $taskSource=Join-Path $taskWork 'fixture.cs'
   [IO.File]::WriteAllText($taskSource,('using System.Reflection;[assembly:AssemblyTitle("'+$taskTitle+'")] [assembly:AssemblyVersion("'+$taskVersion+'.0")] class Fixture {static void Main(){}}'))
   $taskOutput=Join-Path $(if($taskVersion -eq '0.2.1'){$taskInstall}else{$taskStage}) $taskName
   & $taskCompiler /nologo /target:exe "/out:$taskOutput" $taskSource
   if($LASTEXITCODE -ne 0){throw 'Install fixture build failed'}
  }
 }
 $taskKeep=Join-Path $taskInstall 'project.pixel.json';[IO.File]::WriteAllText($taskKeep,'keep')
 $taskFiles=@('Pixel Studio.exe','Удалить Pixel Studio.exe')|ForEach-Object {@{name=$_;hash=(Get-FileHash -LiteralPath (Join-Path $taskStage $_) -Algorithm SHA256).Hash.ToLowerInvariant()}}
 if($taskMode -eq 'tampered'){[IO.File]::AppendAllText((Join-Path $taskStage 'Pixel Studio.exe'),'corrupt')}
 $taskLock=$null
 if($taskMode -eq 'locked'){$taskLock=[IO.File]::Open((Join-Path $taskInstall 'Удалить Pixel Studio.exe'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
 $taskPlan=@{root=$taskInstall;executable='Pixel Studio.exe';stage=$taskStage;version='0.2.2';files=@($taskFiles);parentId=2147483000}|ConvertTo-Json -Depth 5 -Compress
 $taskData=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($taskPlan))
 $taskRun='$ProgressPreference=''SilentlyContinue'';$taskPlan=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('''+$taskData+'''))|ConvertFrom-Json'+[Environment]::NewLine+$taskScript
 try{& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskRun)));$taskExit=$LASTEXITCODE}finally{if($taskLock){$taskLock.Dispose()}}
 $taskExpected=if($taskMode -eq 'success'){'0.2.2.0'}else{'0.2.1.0'}
 foreach($taskName in @('Pixel Studio.exe','Удалить Pixel Studio.exe')){if([Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $taskInstall $taskName)).FileVersion -ne $taskExpected){throw ('Wrong version after '+$taskMode)}}
 if(($taskMode -eq 'success' -and $taskExit -ne 0) -or ($taskMode -ne 'success' -and $taskExit -ne 1)){throw ('Unexpected installer result: '+$taskMode)}
 if([IO.File]::ReadAllText($taskKeep) -ne 'keep'){throw 'User project changed'}
 Write-Output ('Update install fixture passed: '+$taskMode)
}
