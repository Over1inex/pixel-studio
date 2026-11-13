$ErrorActionPreference='Stop'
[Environment]::CurrentDirectory=$env:WINDIR
Set-Location -LiteralPath $env:WINDIR
$taskApplied=@()
$taskTemporaryFiles=@()
function Get-UpdateFullPath([string]$value){return [IO.Path]::GetFullPath($value).TrimEnd('\')}
function Assert-UpdatePlainPath([string]$value){
 $taskItem=Get-Item -LiteralPath $value -Force -ErrorAction SilentlyContinue
 while($null -ne $taskItem){if($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Обновление через ссылки не поддерживается.'};$taskItem=if($taskItem -is [IO.FileInfo]){$taskItem.Directory}else{$taskItem.Parent}}
}
try{
 $taskRoot=Get-UpdateFullPath $taskPlan.root
 $taskStage=Get-UpdateFullPath $taskPlan.stage
 $taskExpected=Get-UpdateFullPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PixelStudio/Updates')
 if(-not $taskStage.StartsWith($taskExpected+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetDirectoryName($taskStage) -ne $taskExpected -or [IO.Path]::GetFileName($taskStage) -notmatch '^\d+\.\d+\.\d+-[a-f0-9]{32}$'){throw 'Неверная папка обновления.'}
 if($taskPlan.version -notmatch '^\d+\.\d+\.\d+$' -or $taskPlan.executable -notmatch '^Pixel Studio(?: Local(?: \d+\.\d+(?:\.\d+)?)?| \d+\.\d+\.\d+)?\.exe$'){throw 'Неверные параметры обновления.'}
 Assert-UpdatePlainPath $taskRoot
 Assert-UpdatePlainPath $taskStage
 $taskExe=Join-Path $taskRoot $taskPlan.executable
 Wait-Process -Id $taskPlan.parentId -Timeout 60 -ErrorAction SilentlyContinue
 if(Get-Process -Id $taskPlan.parentId -ErrorAction SilentlyContinue){throw 'Закройте редактор перед обновлением.'}
 for($taskAttempt=0;$taskAttempt -lt 60;$taskAttempt++){
  $taskRunning=@(Get-Process -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq $taskExe})
  if(-not $taskRunning.Count){break}
  Start-Sleep -Milliseconds 1000
 }
 if($taskRunning.Count){throw 'Осталось открыто другое окно редактора. Обновление отложено.'}
 $taskAllowed=@('Pixel Studio.exe','Удалить Pixel Studio.exe','Начните здесь.txt','GIF-LICENSES.txt','LICENSE-MIT.txt','THIRD-PARTY-NOTICES.txt','WebView2-LICENSE.txt','WebView2-NOTICE.txt')
 $taskSeen=@{}
 foreach($taskFile in $taskPlan.files){
  if($taskFile.name -notin $taskAllowed -or $taskSeen.ContainsKey($taskFile.name) -or $taskFile.hash -notmatch '^[a-f0-9]{64}$'){throw 'Неверный список файлов обновления.'}
  $taskSeen[$taskFile.name]=$true
  $taskSource=Join-Path $taskStage $taskFile.name
  Assert-UpdatePlainPath $taskSource
  if((Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskFile.hash){throw 'Файл обновления изменился. Установка отменена.'}
  $taskName=if($taskFile.name -eq 'Pixel Studio.exe'){$taskPlan.executable}else{$taskFile.name}
  $taskTarget=Join-Path $taskRoot $taskName
  Assert-UpdatePlainPath $taskTarget
  Assert-UpdatePlainPath ($taskTarget+'.update')
  Assert-UpdatePlainPath ($taskTarget+'.previous')
 }
 if(-not $taskSeen.ContainsKey('Pixel Studio.exe') -or -not $taskSeen.ContainsKey('Удалить Pixel Studio.exe')){throw 'Обновление неполное.'}
 foreach($taskName in @('Pixel Studio.exe','Удалить Pixel Studio.exe')){
  $taskInfo=[Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $taskStage $taskName))
  if($taskInfo.FileVersion -ne ($taskPlan.version+'.0')){throw 'Версия файлов обновления не совпала.'}
 }
 foreach($taskFile in $taskPlan.files){
  $taskName=if($taskFile.name -eq 'Pixel Studio.exe'){$taskPlan.executable}else{$taskFile.name}
  $taskTarget=Join-Path $taskRoot $taskName
  $taskBackup=$taskTarget+'.previous'
  $taskTemporary=$taskTarget+'.update'
  $taskTemporaryFiles+=$taskTemporary
  $taskExisted=Test-Path -LiteralPath $taskTarget -PathType Leaf
  Copy-Item -LiteralPath (Join-Path $taskStage $taskFile.name) -Destination $taskTemporary -Force
  if($taskExisted){[IO.File]::Replace($taskTemporary,$taskTarget,$taskBackup,$true)}else{[IO.File]::Move($taskTemporary,$taskTarget)}
  $taskApplied+=@{target=$taskTarget;backup=$taskBackup;existed=$taskExisted}
 }
 # Only this validated, direct child update cache is removed recursively.
 Assert-UpdatePlainPath $taskStage
 try{Remove-Item -LiteralPath $taskStage -Recurse -Force -ErrorAction Stop}catch{}
}catch{
 $taskRollbackFailed=$false
 $taskRollback=@($taskApplied);[Array]::Reverse($taskRollback)
 foreach($taskFile in $taskRollback){
  if($null -eq $taskFile){continue}
  try{if($taskFile.existed -and (Test-Path -LiteralPath $taskFile.backup)){Copy-Item -LiteralPath $taskFile.backup -Destination $taskFile.target -Force}elseif(-not $taskFile.existed -and (Test-Path -LiteralPath $taskFile.target)){Remove-Item -LiteralPath $taskFile.target -Force}}catch{$taskRollbackFailed=$true}
 }
 foreach($taskTemporary in $taskTemporaryFiles){try{if(Test-Path -LiteralPath $taskTemporary){Remove-Item -LiteralPath $taskTemporary -Force}}catch{}}
 Add-Type -AssemblyName System.Windows.Forms
 $taskRollbackMessage=if($taskRollbackFailed){'Не удалось полностью восстановить файлы. Используйте резервную копию .previous или скачайте выпуск заново.'}else{'Сохранена предыдущая версия.'}
 [Windows.Forms.MessageBox]::Show(('Обновление не установлено. '+$taskRollbackMessage+' '+$_.Exception.Message),'Обновление Pixel Studio','OK','Warning')|Out-Null
 exit 1
}
