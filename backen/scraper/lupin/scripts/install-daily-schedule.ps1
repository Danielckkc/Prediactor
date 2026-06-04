# One daily task at 2:00 AM: TikTok (300 posts) THEN Instagram (300 posts).
# Guide: PRODUCT-TRENDS.md
# Run once:
#   cd c:\Users\lsu22\Downloads\lupin-main\lupin-main
#   .\scripts\install-daily-schedule.ps1
#
# Remove:
#   schtasks /Delete /TN "Lupin-Social-Product-Trends" /F

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Runner = Join-Path $ProjectRoot "scripts\run-social-trends-daily.ps1"
$TaskName = "Lupin-Social-Product-Trends"

# Remove old separate tasks if they exist
foreach ($old in @("Lupin-TikTok-Product-Trends", "Lupin-Instagram-Product-Trends")) {
  schtasks /Query /TN $old 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN $old /F | Out-Null
    Write-Host "Removed old task: $old"
  }
}

if (-not (Test-Path $Runner)) {
  throw "Runner not found: $Runner"
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`"" `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -Daily -At "2:00AM"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 8)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "2 AM: scrape 300 TikTok posts, then 300 Instagram posts (dated JSON in data/)" `
  -Force

Write-Host ""
Write-Host "Scheduled task installed: $TaskName"
Write-Host "  When:     Every day at 2:00 AM"
Write-Host "  Order:    1) TikTok 300 posts  ->  2) Instagram 300 posts"
Write-Host "  Runner:   $Runner"
Write-Host "  TikTok:   $ProjectRoot\data\tiktok-product-trends-YYYY-MM-DD.json"
Write-Host "  Instagram: $ProjectRoot\data\instagram-product-trends-YYYY-MM-DD.json"
Write-Host "  Combined log: $ProjectRoot\logs\social-trends-YYYY-MM-DD.log"
Write-Host ""
Write-Host "Test the full chain now:"
Write-Host "  .\scripts\run-social-trends-daily.ps1"
Write-Host ""
Write-Host "Task Scheduler: taskschd.msc -> $TaskName"
