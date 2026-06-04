#!/bin/bash
# Twice-daily RedNote cookie health check (launchd, 09:00 + 15:00).
# Makes ONE cheap signed request. If the cookie is dead it fires the alarm:
# loud log + data/COOKIE_EXPIRED.flag + macOS popup + EMAIL (when SMTP is set in
# backen/.env). If the cookie is fine, it just logs "VALID" — no spam.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REDNOTE_DIR="/Users/daniel_mba/Documents/GitHub/Prediactor/backen/scraper/rednote"
PY="/Users/daniel_mba/Documents/GitHub/Prediactor/backen/.venv/bin/python"

cd "$REDNOTE_DIR/src" || exit 1
mkdir -p "$REDNOTE_DIR/logs"
LOG="$REDNOTE_DIR/logs/cookie-check-$(date +%Y-%m-%d).log"

echo "===== check $(date) =====" >> "$LOG"
"$PY" redscraper.py --mode check >> "$LOG" 2>&1
echo "===== exit $? =====" >> "$LOG"
