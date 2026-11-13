$ErrorActionPreference = 'Stop'
[Environment]::CurrentDirectory = $env:WINDIR
Set-Location -LiteralPath $env:WINDIR
Add-Type -AssemblyName System.Windows.Forms
function Get-FullPath([string]$value) { return [IO.Path]::GetFullPath($value).TrimEnd('\') }
function Assert-PlainPath([string]$value) {
    $taskCurrent = Get-Item -LiteralPath $value -Force -ErrorAction SilentlyContinue
    while ($null -ne $taskCurrent) {
        if ($taskCurrent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Папка содержит ссылку. Автоматическое удаление остановлено.' }
        $taskCurrent = $taskCurrent.Parent
    }
}
function Assert-PlainTree([string]$value, [string]$boundary) {
    if (-not (Get-FullPath $value).StartsWith($boundary + '\', [StringComparison]::OrdinalIgnoreCase) -and (Get-FullPath $value) -ne $boundary) { throw 'Недопустимая папка удаления.' }
    foreach ($taskEntry in Get-ChildItem -LiteralPath $value -Force) {
        if ($taskEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'В данных приложения обнаружена ссылка. Автоматическое удаление остановлено.' }
        if ($taskEntry.PSIsContainer) { Assert-PlainTree $taskEntry.FullName $boundary }
    }
}
try {
    Wait-Process -Id $taskPlan.parentId -Timeout 30 -ErrorAction SilentlyContinue
    if (Get-Process -Id $taskPlan.parentId -ErrorAction SilentlyContinue) { throw 'Программа удаления ещё работает. Повторите попытку.' }
    $taskRoot = Get-FullPath $taskPlan.root
    Assert-PlainPath $taskRoot
    $taskSelf = Get-FullPath $taskPlan.self
    if ([IO.Path]::GetDirectoryName($taskSelf) -ne $taskRoot -or [IO.Path]::GetFileName($taskSelf) -notin @('Удалить Pixel Studio.exe','Uninstall Pixel Studio.exe')) { throw 'Недопустимый путь программы удаления.' }
    $taskApps = @($taskPlan.apps)
    foreach ($taskApp in $taskApps) {
        if ([IO.Path]::GetDirectoryName((Get-FullPath $taskApp)) -ne $taskRoot -or
            (Test-Path -LiteralPath $taskApp) -and (Get-Item -LiteralPath $taskApp).VersionInfo.FileDescription -ne 'Pixel Studio') { throw 'Недопустимый файл приложения.' }
    }
    foreach ($taskProcess in Get-Process -ErrorAction SilentlyContinue) {
        if ($taskProcess.Path -and $taskApps -contains $taskProcess.Path) { throw 'Редактор снова запущен. Закройте его и повторите удаление.' }
    }
    $taskExpectedData = Get-FullPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PixelStudio')
    if ((Get-FullPath $taskPlan.dataDirectory) -ne $taskExpectedData) { throw 'Недопустимый путь данных.' }
    if ($taskPlan.removeData -and (Test-Path -LiteralPath $taskExpectedData)) {
        Assert-PlainPath $taskExpectedData
        Assert-PlainTree $taskExpectedData $taskExpectedData
        $taskDeleted = $false
        for ($taskAttempt=0; $taskAttempt -lt 15; $taskAttempt++) {
            try { Remove-Item -LiteralPath $taskExpectedData -Recurse -Force; $taskDeleted=$true; break }
            catch { Start-Sleep -Milliseconds 1000 }
        }
        if (-not $taskDeleted) { throw 'Данные приложения заняты. Закройте редактор и повторите удаление.' }
    }
    $taskShell = New-Object -ComObject WScript.Shell
    foreach ($taskShortcut in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pixel Studio.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Pixel Studio.lnk'))) {
        if (Test-Path -LiteralPath $taskShortcut) {
            if ($taskApps -contains $taskShell.CreateShortcut($taskShortcut).TargetPath) { Remove-Item -LiteralPath $taskShortcut -Force }
        }
    }
    foreach ($taskApp in $taskApps) {
        if (Test-Path -LiteralPath $taskApp) { Remove-Item -LiteralPath $taskApp -Force }
        foreach($taskSuffix in @('.previous','.update')){
            $taskBackup=$taskApp+$taskSuffix
            if((Test-Path -LiteralPath $taskBackup -PathType Leaf) -and (Get-Item -LiteralPath $taskBackup).VersionInfo.FileDescription -eq 'Pixel Studio'){Remove-Item -LiteralPath $taskBackup -Force}
        }
    }
    # The portable package contains only these additional program-owned notices.
    # Shared folders (such as outputs) never have their other files removed.
    if ([IO.Path]::GetFileName($taskRoot) -eq 'Pixel Studio') {
        foreach ($taskName in @('Начните здесь.txt','LICENSE-MIT.txt','GIF-LICENSES.txt','THIRD-PARTY-NOTICES.txt','WebView2-LICENSE.txt','WebView2-NOTICE.txt')) {
            $taskNotice = Join-Path $taskRoot $taskName
            if (Test-Path -LiteralPath $taskNotice -PathType Leaf) { Remove-Item -LiteralPath $taskNotice -Force }
            foreach($taskSuffix in @('.previous','.update')){if(Test-Path -LiteralPath ($taskNotice+$taskSuffix) -PathType Leaf){Remove-Item -LiteralPath ($taskNotice+$taskSuffix) -Force}}
        }
    }
    if (Test-Path -LiteralPath $taskSelf) { Remove-Item -LiteralPath $taskSelf -Force }
    foreach($taskSuffix in @('.previous','.update')){
        $taskBackup=$taskSelf+$taskSuffix
        if((Test-Path -LiteralPath $taskBackup -PathType Leaf) -and (Get-Item -LiteralPath $taskBackup).VersionInfo.FileDescription -eq 'Удаление Pixel Studio'){Remove-Item -LiteralPath $taskBackup -Force}
    }
    if ([IO.Path]::GetFileName($taskRoot) -eq 'Pixel Studio' -and @(Get-ChildItem -LiteralPath $taskRoot -Force).Count -eq 0) {
        # WinRAR or Explorer can retain a handle to the empty extraction folder.
        # Program files have already been removed; folder cleanup is best effort.
        try { Remove-Item -LiteralPath $taskRoot -ErrorAction Stop } catch [IO.IOException] { } catch [UnauthorizedAccessException] { }
    }
    [Windows.Forms.MessageBox]::Show('Pixel Studio удалён. Ваши сохранённые изображения, проекты и исходники остались на месте.', 'Удаление Pixel Studio') | Out-Null
} catch {
    [Windows.Forms.MessageBox]::Show(('Не удалось завершить удаление: ' + $_.Exception.Message), 'Удаление Pixel Studio', 'OK', 'Warning') | Out-Null
    exit 1
}
