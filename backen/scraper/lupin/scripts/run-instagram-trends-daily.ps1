# Runs the Instagram trends scraper (300 posts) — dated JSON + log.

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectRoot

$dateStamp = Get-Date -Format "yyyy-MM-dd"
$DataDir = Join-Path $ProjectRoot "data"
$LogDir = Join-Path $ProjectRoot "logs"
$OutputFile = Join-Path $DataDir "instagram-product-trends-$dateStamp.json"
$LogFile = Join-Path $LogDir "instagram-trends-$dateStamp.log"

New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null

$node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $node) { throw "Node.js not found in PATH." }

$script = Join-Path $ProjectRoot "scripts\instagram-product-trends.mjs"
"[$((Get-Date).ToString('o'))] Starting Instagram trends -> $OutputFile" | Tee-Object -FilePath $LogFile -Append

try {
  & $node $script --target 300 --output $OutputFile --concurrency 2 --delay 800 2>&1 |
    Tee-Object -FilePath $LogFile -Append
  "[$((Get-Date).ToString('o'))] Finished OK" | Tee-Object -FilePath $LogFile -Append
  exit 0
} catch {
  "[$((Get-Date).ToString('o'))] FAILED: $_" | Tee-Object -FilePath $LogFile -Append
  exit 1
}
