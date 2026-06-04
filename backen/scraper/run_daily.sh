#!/bin/bash
# Daily 2 AM scrape runner for Prediactor (called by launchd).
# launchd runs with a bare environment, so we set PATH explicitly here.
export PATH="/usr/local/bin:/opt/homebrew/bin:/Library/Frameworks/Python.framework/Versions/3.14/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRAPER_DIR="/Users/daniel_mba/Documents/GitHub/Prediactor/backen/scraper"
cd "$SCRAPER_DIR" || exit 1

mkdir -p logs
LOG="logs/scrape-$(date +%Y-%m-%d).log"

echo "===== run $(date) =====" >> "$LOG"
# "yesterday's most on fire": recent sort + date window + dedupe + dated output
python3 scraper.py --daily --target 300 --comments 2 >> "$LOG" 2>&1
echo "===== exit $? =====" >> "$LOG"
