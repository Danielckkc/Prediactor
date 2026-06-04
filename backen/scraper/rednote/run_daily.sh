#!/bin/bash
# Daily RedNote (Xiaohongshu) scrape for Prediactor — called by launchd at 02:30,
# just after the Lupin (Instagram/TikTok) job at 02:00.
# launchd runs with a bare environment, so we set PATH explicitly and call the
# backend's uv venv Python by absolute path.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REDNOTE_DIR="/Users/daniel_mba/Documents/GitHub/Prediactor/backen/scraper/rednote"
PY="/Users/daniel_mba/Documents/GitHub/Prediactor/backen/.venv/bin/python"

# Topics to pull "popular" (trending-ish) posts for, each day. Edit freely.
KEYWORDS=("数码好物" "好物推荐" "智能家居")
MAX_ITEMS=50

cd "$REDNOTE_DIR/src" || exit 1
mkdir -p "$REDNOTE_DIR/logs"
LOG="$REDNOTE_DIR/logs/scrape-$(date +%Y-%m-%d).log"

echo "===== run $(date) =====" >> "$LOG"
for kw in "${KEYWORDS[@]}"; do
  echo "--- search: $kw ---" >> "$LOG"
  "$PY" redscraper.py --mode search --keyword "$kw" --sort popular --max-items "$MAX_ITEMS" >> "$LOG" 2>&1
  rc=$?
  echo "--- '$kw' exit $rc ---" >> "$LOG"
  # Exit code 3 = cookie expired; stop early, the rest would all fail the same way.
  if [ "$rc" -eq 3 ]; then
    echo "Cookie expired — skipping remaining keywords. Refresh RED_COOKIE in backen/.env." >> "$LOG"
    break
  fi
done
echo "===== done $(date) =====" >> "$LOG"
