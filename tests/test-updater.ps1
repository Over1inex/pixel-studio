$ErrorActionPreference='Stop'
$taskProject=Split-Path -Parent $PSScriptRoot
$taskWork=Join-Path $taskProject ('work/updater-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskWork|Out-Null
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
foreach($taskFixture in @(@('Pixel Studio.exe','Pixel Studio'),@('Удалить Pixel Studio.exe','Удаление Pixel Studio'))){
 $taskSource=Join-Path $taskWork 'fixture.cs'
 [IO.File]::WriteAllText($taskSource,('using System.Reflection;[assembly:AssemblyTitle("'+$taskFixture[1]+'")] [assembly:AssemblyVersion("0.2.2.0")] class Fixture {static void Main(){}}'))
 & $taskCompiler /nologo /target:exe "/out:$(Join-Path $taskWork $taskFixture[0])" $taskSource
 if($LASTEXITCODE -ne 0){throw 'Fixture compilation failed'}
}
$taskTests=Join-Path $taskWork 'updater-tests.exe'
& $taskCompiler /nologo /target:exe /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll "/out:$taskTests" (Join-Path $taskProject 'desktop/DesktopUpdater.cs') (Join-Path $PSScriptRoot 'updater-native.cs')
if($LASTEXITCODE -ne 0){throw 'Updater tests compilation failed'}
& $taskTests $taskWork
if($LASTEXITCODE -ne 0){throw 'Updater checks failed'}
Write-Output ('Updater fixture directory: '+$taskWork)
