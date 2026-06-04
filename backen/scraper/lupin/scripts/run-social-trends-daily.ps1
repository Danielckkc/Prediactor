# Daily job: TikTok first (300 posts), then Instagram (300 posts).
# Used by Task Scheduler at 2:00 AM.

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

$dateStamp = Get-Date -Format "yyyy-MM-dd"
$LogDir = Join-Path $ProjectRoot "logs"
$CombinedLog = Join-Path $LogDir "social-trends-$dateStamp.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($message) {
  $line = "[$((Get-Date).ToString('o'))] $message"
  Write-Host $line
  $line | Out-File -FilePath $CombinedLog -Append -Encoding utf8
}

Write-Log "=== Starting daily social trends (TikTok -> Instagram) ==="

$tiktokRunner = Join-Path $ProjectRoot "scripts\run-tiktok-trends-daily.ps1"
$instagramRunner = Join-Path $ProjectRoot "scripts\run-instagram-trends-daily.ps1"

$tiktokOk = $true
$instagramOk = $true

Write-Log "--- Step 1/2: TikTok (300 posts) ---"
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tiktokRunner 2>&1 |
    ForEach-Object { Write-Log "TikTok: $_" }
  if ($LASTEXITCODE -ne 0) {
    $tiktokOk = $false
    Write-Log "TikTok step exited with code $LASTEXITCODE"
  } else {
    Write-Log "TikTok step finished OK"
  }
} catch {
  $tiktokOk = $false
  Write-Log "TikTok step FAILED: $_"
}

Write-Log "--- Step 2/2: Instagram (300 posts) ---"
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $instagramRunner 2>&1 |
    ForEach-Object { Write-Log "Instagram: $_" }
  if ($LASTEXITCODE -ne 0) {
    $instagramOk = $false
    Write-Log "Instagram step exited with code $LASTEXITCODE"
  } else {
    Write-Log "Instagram step finished OK"
  }
} catch {
  $instagramOk = $false
  Write-Log "Instagram step FAILED: $_"
}

if ($tiktokOk -and $instagramOk) {
  Write-Log "=== All done (TikTok + Instagram) ==="
  exit 0
}

Write-Log "=== Finished with errors (TikTok ok: $tiktokOk, Instagram ok: $instagramOk) ==="
exit 1
