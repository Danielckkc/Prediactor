# Runs the TikTok trends scraper (300 posts) and saves a dated JSON file + log.
# Used by Windows Task Scheduler or run manually: .\scripts\run-tiktok-trends-daily.ps1

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

$dateStamp = Get-Date -Format "yyyy-MM-dd"
$DataDir = Join-Path $ProjectRoot "data"
$LogDir = Join-Path $ProjectRoot "logs"
$OutputFile = Join-Path $DataDir "tiktok-product-trends-$dateStamp.json"
$LogFile = Join-Path $LogDir "tiktok-trends-$dateStamp.log"

New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null

$node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $node) {
  throw "Node.js not found in PATH. Install Node 18+ and restart the terminal."
}

$script = Join-Path $ProjectRoot "scripts\tiktok-product-trends.mjs"
if (-not (Test-Path $script)) {
  throw "Missing script: $script"
}

"[$((Get-Date).ToString('o'))] Starting TikTok trends scrape -> $OutputFile" | Tee-Object -FilePath $LogFile -Append

try {
  & $node $script --target 300 --output $OutputFile --concurrency 2 --delay 800 2>&1 |
    Tee-Object -FilePath $LogFile -Append
  "[$((Get-Date).ToString('o'))] Finished OK" | Tee-Object -FilePath $LogFile -Append
  exit 0
} catch {
  "[$((Get-Date).ToString('o'))] FAILED: $_" | Tee-Object -FilePath $LogFile -Append
  exit 1
}
