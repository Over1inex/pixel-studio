param([string]$OutputFile, [string]$UninstallerOutputFile)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Не найден компилятор .NET Framework 4.' }
$appRoot = Split-Path -Parent $PSScriptRoot
$sdkRoot = Join-Path $appRoot 'work/webview2-sdk'
if (-not (Test-Path -LiteralPath $sdkRoot)) {
    New-Item -ItemType Directory -Force -Path $sdkRoot | Out-Null
    $archive = Join-Path $sdkRoot 'sdk.zip'
    Invoke-WebRequest 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4314.35/microsoft.web.webview2.1.0.4314.35.nupkg' -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $sdkRoot -Force
}
$core = Join-Path $sdkRoot 'lib/net462/Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $sdkRoot 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
$loader = Join-Path $sdkRoot 'runtimes/win-x64/native/WebView2Loader.dll'
$bootstrap = Join-Path $PSScriptRoot 'Bootstrap.cs'
$desktop = Join-Path $PSScriptRoot 'DesktopApp.cs'
$google = Join-Path $PSScriptRoot 'GoogleSignIn.cs'
$diagnostics = Join-Path $PSScriptRoot 'CloudDiagnostics.cs'
$iconPath = Join-Path $PSScriptRoot 'pixel-studio.ico'
& node (Join-Path $PSScriptRoot 'generate-icon.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить иконку приложения.' }
$outputPath = if ($OutputFile) { [IO.Path]::GetFullPath($OutputFile) } else { Join-Path $appRoot 'Pixel Studio.exe' }
$uiDirectory = Join-Path $appRoot 'desktop-ui-dist'
if (-not (Test-Path -LiteralPath (Join-Path $uiDirectory 'index.html'))) { throw 'Сначала выполните npm run build:desktop: отсутствует desktop-ui-dist/index.html.' }
$uiArchive = Join-Path $appRoot 'work/desktop-ui.zip'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $uiArchive) | Out-Null
Compress-Archive -Path (Join-Path $uiDirectory '*') -DestinationPath $uiArchive -Force
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/win32icon:$iconPath" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Net.Http.dll /reference:System.Web.dll /reference:System.Web.Extensions.dll /reference:System.Security.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/reference:$core" "/reference:$forms" "/resource:$core,Microsoft.Web.WebView2.Core.dll" "/resource:$forms,Microsoft.Web.WebView2.WinForms.dll" "/resource:$loader,WebView2Loader.dll" "/resource:$uiArchive,PixelStudio.UI.zip" "/out:$outputPath" $bootstrap $desktop $google $diagnostics
if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать Pixel Studio.exe' }
Write-Output "Готово: $outputPath"
$uninstallerPath = if ($UninstallerOutputFile) { [IO.Path]::GetFullPath($UninstallerOutputFile) } else { Join-Path (Split-Path -Parent $outputPath) 'Удалить Pixel Studio.exe' }
$uninstallerSource = Join-Path $PSScriptRoot 'Uninstaller.cs'
$uninstallerScript = Join-Path $PSScriptRoot 'uninstall.ps1'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/win32icon:$iconPath" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/resource:$uninstallerScript,PixelStudio.Uninstall.ps1" "/out:$uninstallerPath" $uninstallerSource
if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать программу удаления.' }
Write-Output "Готово: $uninstallerPath"
