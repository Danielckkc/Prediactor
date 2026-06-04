# Instagram is NOT scheduled separately — it runs after TikTok in one daily job.
# See PRODUCT-TRENDS.md
# Use this instead:
#   .\scripts\install-daily-schedule.ps1
#
# That installs "Lupin-Social-Product-Trends" at 2:00 AM (TikTok, then Instagram).

Write-Host ""
Write-Host "Instagram runs AFTER TikTok in the same nightly job."
Write-Host ""
Write-Host "Run this once to install both:"
Write-Host "  .\scripts\install-daily-schedule.ps1"
Write-Host ""
Write-Host "Test TikTok then Instagram:"
Write-Host "  .\scripts\run-social-trends-daily.ps1"
Write-Host ""

& (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) "scripts\install-daily-schedule.ps1")
