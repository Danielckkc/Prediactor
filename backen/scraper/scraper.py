#!/usr/bin/env python3
"""
scraper.py — Prediactor's standalone social scraper (Instagram + TikTok via Lupin).

Two modes:

  Manual:
    python3 scraper.py                         # ~50 each, tech gadgets, no comments
    python3 scraper.py --target 100
    python3 scraper.py --urls my_urls.txt

  Daily "yesterday's most on fire" (what the 2 AM job runs):
    python3 scraper.py --daily --target 30
      -> sorts by recency, keeps only recent posts, ranks by engagement,
         SKIPS anything scraped before (seen.json), writes a DATED file:
         json/product-listing-YYYY-MM-DD.json

Output: json/  ·  Dedupe ledger: seen.json  ·  Engine: ./lupin (Node)
Uses only the Python standard library. First time: cd lupin && npm install && node bin/lupin.js setup
RedNote/Xiaohongshu is NOT supported by Lupin — Instagram + TikTok only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta, date
from pathlib import Path

HERE = Path(__file__).resolve().parent
LUPIN_CLI = HERE / "lupin" / "bin" / "lupin.js"
OUT_DIR = HERE / "json"
SEEN_FILE = HERE / "seen.json"
NODE = os.environ.get("NODE_BIN", "node")  # runner sets PATH so "node" resolves

DEFAULT_QUERIES = [
    "tech gadgets", "gadget finds", "amazon tech finds",
    "cool gadgets", "smart home gadgets", "tech accessories",
]

IG_RE = re.compile(r"https?://www\.instagram\.com/(?:p|reel)/[A-Za-z0-9_-]+/?")
TT_RE = re.compile(r"https?://www\.tiktok\.com/@[A-Za-z0-9._]+/video/\d+")


# ---------- lupin CLI wrapper ----------
def run_lupin(args: list[str], timeout: int) -> str:
    proc = subprocess.run([NODE, str(LUPIN_CLI), *args], capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0 and not proc.stdout.strip():
        raise RuntimeError((proc.stderr.strip()[:300]) or f"lupin exited {proc.returncode}")
    return proc.stdout


def detect_platform(url: str) -> str | None:
    if "tiktok.com" in url:
        return "tiktok"
    if "instagram.com" in url:
        return "instagram"
    return None


def discover(platform: str, query: str, limit: int, sort: str) -> list[str]:
    out = run_lupin(["search", platform, query, "--limit", str(limit), "--sort", sort, "--format", "json"], timeout=240)
    rx = IG_RE if platform == "instagram" else TT_RE
    return list(dict.fromkeys(rx.findall(out)))


def accumulate(platform: str, queries: list[str], pool: int, limit: int, sort: str, skip: set[str]) -> list[str]:
    seen: list[str] = []
    for q in queries:
        if len(seen) >= pool:
            break
        print(f"  search {platform}: \"{q}\" ({sort}) ...", file=sys.stderr)
        try:
            for u in discover(platform, q, limit, sort):
                if u not in seen and u not in skip:
                    seen.append(u)
                    if len(seen) >= pool:
                        break
        except Exception as e:  # noqa: BLE001
            print(f"    failed: {e}", file=sys.stderr)
        time.sleep(1)
    print(f"  -> {len(seen)} new {platform} candidates", file=sys.stderr)
    return seen


def fetch_post(platform: str, url: str, comments: int) -> dict:
    out = run_lupin(["fetch", platform, url, "--max-comments", str(comments), "--format", "json"], timeout=120)
    return json.loads(out)


# ---------- parsing helpers ----------
def parse_count(v) -> int:
    """'3,447' -> 3447 ; '35.1K' -> 35100 ; 5539 -> 5539 ; None -> 0."""
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().replace(",", "")
    m = re.match(r"^([\d.]+)\s*([KMB])?$", s, re.I)
    if not m:
        digits = re.sub(r"\D", "", s)
        return int(digits) if digits else 0
    num = float(m.group(1))
    mult = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get((m.group(2) or "").upper(), 1)
    return int(num * mult)


def parse_pub_date(v) -> date | None:
    """Best-effort: ISO '2026-06-03T..' or 'February 12, 2026' -> date; else None."""
    if not v:
        return None
    s = str(v).strip()
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        pass
    try:
        return datetime.strptime(s, "%B %d, %Y").date()
    except ValueError:
        return None


def engagement_of(platform: str, stats: dict) -> int:
    if platform == "tiktok":
        return parse_count(stats.get("viewCount")) or parse_count(stats.get("likeCount"))
    return parse_count(stats.get("likeCount"))


# ---------- seen ledger ----------
def load_seen(path: Path) -> set[str]:
    if path.exists():
        try:
            return set(json.loads(path.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            return set()
    return set()


def save_seen(path: Path, seen: set[str]) -> None:
    path.write_text(json.dumps(sorted(seen), indent=0), encoding="utf-8")


# ---------- main ----------
def main() -> None:
    ap = argparse.ArgumentParser(description="Scrape Instagram + TikTok into one JSON file.")
    ap.add_argument("--daily", action="store_true", help="2 AM mode: recent + dedupe + date window + dated output")
    ap.add_argument("--platform", default="both", choices=["both", "instagram", "tiktok"])
    ap.add_argument("--target", type=int, default=50, help="top posts to KEEP per platform")
    ap.add_argument("--pool-factor", type=int, default=2, help="fetch target*N candidates, then rank")
    ap.add_argument("--limit", type=int, default=25, help="results per search query")
    ap.add_argument("--comments", type=int, default=0, help="comments per post (0 = none)")
    ap.add_argument("--sort", default="recent", choices=["recent", "relevance"])
    ap.add_argument("--since-days", type=int, default=0, help="keep posts dated within N days (0 = no filter)")
    ap.add_argument("--queries", nargs="*", default=DEFAULT_QUERIES)
    ap.add_argument("--urls", help="file of post URLs (skips search)")
    ap.add_argument("--dedupe", action="store_true", help="skip posts already in seen.json")
    ap.add_argument("--delay", type=float, default=0.4)
    ap.add_argument("-o", "--output", default=None)
    args = ap.parse_args()

    # --daily presets
    if args.daily:
        args.sort = "recent"
        args.dedupe = True
        if args.since_days == 0:
            args.since_days = 2  # yesterday + today (lenient for timezones)

    if not LUPIN_CLI.exists():
        sys.exit(f"Lupin engine not found at {LUPIN_CLI}. Run: cd lupin && npm install && node bin/lupin.js setup")

    run_date = datetime.now(timezone.utc).date()
    out_path = Path(args.output) if args.output else (
        OUT_DIR / (f"product-listing-{run_date}.json" if args.daily else "product-listing.json")
    )
    seen = load_seen(SEEN_FILE) if args.dedupe else set()
    cutoff = run_date - timedelta(days=args.since_days) if args.since_days > 0 else None

    # 1) candidate URLs (per platform), skipping anything already seen
    pool = max(args.target * args.pool_factor, args.target)
    candidates: list[str] = []
    if args.urls:
        candidates = [ln.strip() for ln in Path(args.urls).read_text(encoding="utf-8").splitlines()
                      if ln.strip() and not ln.startswith("#") and ln.strip() not in seen]
        print(f"Loaded {len(candidates)} new URLs from {args.urls}", file=sys.stderr)
    else:
        platforms = ["instagram", "tiktok"] if args.platform == "both" else [args.platform]
        for p in platforms:
            candidates += accumulate(p, args.queries, pool, args.limit, args.sort, seen)

    if not candidates:
        sys.exit("No new URLs to fetch (all seen, or search blocked — try --urls).")

    # 2) fetch each candidate, record engagement + date (mark every fetch as seen -> no repeats ever)
    fetched: list[dict] = []
    for i, url in enumerate(candidates, 1):
        p = detect_platform(url)
        print(f"[{i}/{len(candidates)}] ({p or '?'}) {url} ...", end=" ", file=sys.stderr)
        if not p:
            print("SKIP", file=sys.stderr)
            continue
        try:
            res = fetch_post(p, url, 0)  # metadata only here (fast); comments fetched later, only for kept posts
            c = res.get("content", {}) or {}
            stats = c.get("stats", {}) or {}
            pub = parse_pub_date(c.get("publishedAt"))
            fetched.append({
                "platform": p, "url": url, "finalUrl": res.get("finalUrl", url),
                "author": c.get("author"), "caption": c.get("text", ""),
                "stats": stats, "hashtags": (c.get("platform") or {}).get("hashtags", []),
                "media": c.get("media", []), "comments": c.get("comments", []),
                "publishedAt": c.get("publishedAt"),
                "_pubdate": pub.isoformat() if pub else None,
                "engagement": engagement_of(p, stats),
                "fetchedAt": datetime.now(timezone.utc).isoformat(),
            })
            seen.add(url)
            print(f"ok (engagement {fetched[-1]['engagement']})", file=sys.stderr)
        except Exception:  # noqa: BLE001
            print("FAILED", file=sys.stderr)
        time.sleep(args.delay)

    # 3) per platform: keep only recent (best-effort), rank by engagement, take top target
    results: list[dict] = []
    for p in (["instagram", "tiktok"] if args.platform == "both" else [args.platform]):
        rows = [r for r in fetched if r["platform"] == p]
        if cutoff:
            # keep posts dated >= cutoff, OR with unknown date (can't confirm -> don't drop blindly)
            rows = [r for r in rows
                    if (parse_pub_date(r["publishedAt"]) is None) or (parse_pub_date(r["publishedAt"]) >= cutoff)]
        rows.sort(key=lambda r: r["engagement"], reverse=True)
        results.extend(rows[:args.target])

    # 3.5) enrich ONLY the kept posts with comments (browser per post -> slow; empty without login cookies)
    if args.comments > 0:
        print(f"Fetching up to {args.comments} comments for {len(results)} kept posts (browser each, slow)...", file=sys.stderr)
        for j, r in enumerate(results, 1):
            print(f"  comments [{j}/{len(results)}] ({r['platform']}) ...", end=" ", file=sys.stderr)
            try:
                cres = fetch_post(r["platform"], r["url"], args.comments)
                r["comments"] = (cres.get("content", {}) or {}).get("comments", [])
                print(f"{len(r['comments'])} got", file=sys.stderr)
            except Exception:  # noqa: BLE001
                print("FAILED", file=sys.stderr)
            time.sleep(args.delay)

    # 4) write dated output + persist seen
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "runDate": run_date.isoformat(),
        "mode": "daily" if args.daily else "manual",
        "window": {"sinceDays": args.since_days, "cutoff": cutoff.isoformat() if cutoff else None},
        "sort": args.sort,
        "fetched": len(fetched),
        "kept": len(results),
        "byPlatform": {
            "instagram": sum(1 for r in results if r["platform"] == "instagram"),
            "tiktok": sum(1 for r in results if r["platform"] == "tiktok"),
        },
        "results": results,  # already ranked: most "on fire" first, per platform
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    if args.dedupe:
        save_seen(SEEN_FILE, seen)
    print(f"\nKept {payload['kept']} (of {payload['fetched']} fetched) -> {out_path}", file=sys.stderr)
    print(f"  Instagram: {payload['byPlatform']['instagram']}  TikTok: {payload['byPlatform']['tiktok']}", file=sys.stderr)
    print(f"  seen.json now tracks {len(seen)} posts (never re-scraped)", file=sys.stderr)


if __name__ == "__main__":
    main()
