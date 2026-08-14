# _ollama_tunnel_helper.ps1
# Starts two Cloudflare quick tunnels:
#   - Ollama  (port 11434) -> public trycloudflare.com URL
#   - SearXNG (port 8888)  -> public trycloudflare.com URL
# Polls each tunnel log for its public URL, writes them to separate files,
# prints both, and copies the Ollama URL to the clipboard.
$ErrorActionPreference = 'Stop'

$dir     = $PSScriptRoot
$cfd     = Join-Path $dir 'cloudflared.exe'
$stamp   = Get-Date -Format 'yyyyMMdd_HHmmss'

# Fresh start: remove leftover tunnel processes and stale url files.
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600
Remove-Item (Join-Path $dir '_ollama_tunnel_url.txt') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dir '_searxng_tunnel_url.txt') -ErrorAction SilentlyContinue

# Start one cloudflared tunnel for a given local port, poll its log for the
# public URL (up to ~40s), write it to $UrlFile, and return it.
function Start-TunnelTunnel([string]$Name, [int]$Port, [string]$UrlFile) {
    $log    = Join-Path $dir "_${Name}_$stamp.log"
    $logOut = Join-Path $dir "_${Name}_$stamp.out"
    $args   = @('tunnel', '--url', "http://localhost:$Port", '--no-autoupdate')
    Start-Process -FilePath $cfd `
        -ArgumentList $args `
        -RedirectStandardError $log `
        -RedirectStandardOutput $logOut `
        -WindowStyle Minimized
    for ($i = 0; $i -lt 80; $i++) {
        $content = Get-Content $log -Raw -ErrorAction SilentlyContinue
        if ($content -and $content -match 'https://[a-z0-9.-]+\.trycloudflare\.com') {
            $url = $matches[0]
            Set-Content -Path $UrlFile -Value $url -Encoding UTF8
            return $url
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

Write-Host ""
Write-Host "  Starting tunnel for Ollama (port 11434) ..."
$ollamaUrl = Start-TunnelTunnel -Name 'ollama' -Port 11434 -UrlFile (Join-Path $dir '_ollama_tunnel_url.txt')

Write-Host "  Starting tunnel for SearXNG (port 8888) ..."
$searxngUrl = Start-TunnelTunnel -Name 'searxng' -Port 8888 -UrlFile (Join-Path $dir '_searxng_tunnel_url.txt')

Write-Host ""
if ($ollamaUrl) {
    Write-Host "  Ollama URL:  $ollamaUrl" -ForegroundColor Green
} else {
    Write-Host "  Ollama URL:  FAILED (make sure Ollama runs on port 11434)" -ForegroundColor Red
}
if ($searxngUrl) {
    Write-Host "  SearXNG URL: $searxngUrl" -ForegroundColor Green
} else {
    Write-Host "  SearXNG URL: FAILED (make sure SearXNG runs on port 8888)" -ForegroundColor Red
}
Write-Host ""
if ($ollamaUrl) {
    try {
        Set-Clipboard -Value $ollamaUrl
        Write-Host "  Ollama URL copied to clipboard automatically." -ForegroundColor Green
    } catch {
        Write-Host "  Copy the Ollama URL above manually." -ForegroundColor Yellow
    }
}
Write-Host ""
Write-Host "  In the mobile App settings:" -ForegroundColor Green
Write-Host "    - Ollama 地址  = the Ollama URL above" -ForegroundColor Green
Write-Host "    - 搜索服务地址  = the SearXNG URL above" -ForegroundColor Green
Write-Host "  Remove any trailing /api/tags part if present." -ForegroundColor Green
Write-Host "  Tunnels keep running. Close this launcher window to stop." -ForegroundColor Green