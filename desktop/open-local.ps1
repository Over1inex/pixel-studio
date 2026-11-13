$deadline = [DateTime]::UtcNow.AddSeconds(60)
$executable = Join-Path (Split-Path -Parent $PSScriptRoot) 'Pixel Studio.exe'
while ([DateTime]::UtcNow -lt $deadline) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173' -TimeoutSec 2
        if ($response.StatusCode -eq 200 -and $response.Content.Contains('Pixel Studio')) {
            Start-Process -FilePath $executable -ArgumentList '--local' -WindowStyle Normal
            exit
        }
    } catch {}
    Start-Sleep -Seconds 2
}
