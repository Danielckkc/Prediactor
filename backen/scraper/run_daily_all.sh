#!/bin/bash
# ============================================================================
# Prediactor daily orchestrator (launchd, 02:00) — ONE self-contained script.
#
# Runs Lupin (Instagram + TikTok) FIRST — inline, under a silence-watchdog —
# then RedNote (Xiaohongshu). RedNote ALWAYS runs after Lupin, no matter how
# Lupin ends:  finishes normally  ·  crashes  ·  or hangs.
# A broken Lupin can NEVER block RedNote.
#
# "Is Lupin dead?" is decided by SILENCE, not slowness: scraper.py prints
# progress on every search/fetch step; the longest normal gap is ~240s (the
# lupin search timeout). While it keeps printing it is ALIVE — we never kill it,
# however many hours it runs. Only if its log goes COMPLETELY silent for
# STALL_SECS (default 20 min, ~5x the longest normal gap) do we treat it as
# genuinely hung and move on. HARD_CAP_SECS is a generous last-resort backstop.
#
# Config is env-overridable (used by the test harness); defaults are production.
# ============================================================================
set -u
export PATH="/usr/local/bin:/opt/homebrew/bin:/Library/Frameworks/Python.framework/Versions/3.14/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRAPER_DIR="/Users/daniel_mba/Documents/GitHub/Prediactor/backen/scraper"
DAY="$(date +%Y-%m-%d)"

# Lupin scrape command, run from SCRAPER_DIR (override for testing).
LUPIN_CMD="${LUPIN_CMD:-python3 scraper.py --daily --target 300 --comments 2}"
REDNOTE_RUNNER="${REDNOTE_RUNNER:-$SCRAPER_DIR/rednote/run_daily.sh}"
LUPIN_LOG="${LUPIN_LOG:-$SCRAPER_DIR/logs/scrape-$DAY.log}"
STALL_SECS="${STALL_SECS:-1200}"          # 20 min of silence => hung (normal gap ~240s)
HARD_CAP_SECS="${HARD_CAP_SECS:-36000}"   # 10h absolute backstop
POLL_SECS="${POLL_SECS:-60}"

mkdir -p "$SCRAPER_DIR/logs"
ORCH_LOG="${ORCH_LOG:-$SCRAPER_DIR/logs/daily-$DAY.log}"
olog() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$ORCH_LOG"; }

# Recursively kill a process and ALL its descendants (macOS has no setsid).
kill_tree() {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill -9 "$p" 2>/dev/null
}
mtime() { stat -f %m "$1" 2>/dev/null || echo 0; }

olog "===== daily orchestrator START ====="

# ---------------- 1) Lupin (inline), guarded by a SILENCE watchdog ----------------
olog "starting Lupin: $LUPIN_CMD"
echo "===== lupin run $(date) =====" >> "$LUPIN_LOG"
( cd "$SCRAPER_DIR" && $LUPIN_CMD ) >> "$LUPIN_LOG" 2>&1 &
LPID=$!

start="$(date +%s)"
outcome="finished normally"
while kill -0 "$LPID" 2>/dev/null; do
  sleep "$POLL_SECS"
  now="$(date +%s)"
  last="$(mtime "$LUPIN_LOG")"; [ "$last" -eq 0 ] && last="$start"
  silent=$(( now - last ))
  elapsed=$(( now - start ))

  if [ "$silent" -ge "$STALL_SECS" ]; then
    olog "Lupin SILENT ${silent}s, no log progress (limit ${STALL_SECS}s) -> HUNG. Killing process tree."
    kill_tree "$LPID"
    outcome="killed: hung (silent ${silent}s)"
    break
  fi
  if [ "$elapsed" -ge "$HARD_CAP_SECS" ]; then
    olog "Lupin ran ${elapsed}s, hit hard cap ${HARD_CAP_SECS}s -> backstop kill."
    kill_tree "$LPID"
    outcome="killed: hard cap (${elapsed}s)"
    break
  fi
done
wait "$LPID" 2>/dev/null
lrc=$?
echo "===== lupin exit $lrc =====" >> "$LUPIN_LOG"
olog "Lupin done: $outcome (rc=$lrc, ran $(( $(date +%s) - start ))s)"

# ---------------- 2) RedNote ALWAYS runs next ----------------
olog "launching RedNote (runs regardless of Lupin's outcome): $REDNOTE_RUNNER"
bash "$REDNOTE_RUNNER"
olog "RedNote done (rc=$?)"
olog "===== daily orchestrator END ====="
