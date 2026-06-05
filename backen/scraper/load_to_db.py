#!/usr/bin/env python3
"""
load_to_db.py — load scraped posts from scraper/json/*.json into Postgres.

Reads every *.json in backen/scraper/json/ (Lupin's product-listing*.json and
RedNote's rednote_output_*.json), normalizes each post into a few common columns,
and upserts them into a single `posts` table. The ENTIRE original post is kept in
a `raw` JSONB column, so nothing is lost and both formats are supported.

Idempotent: re-running updates existing rows (keyed by `id`) instead of duplicating.

Run it (from the backend venv):
    cd backen && .venv/bin/python scraper/load_to_db.py
"""

import asyncio
import glob
import json
import os
from datetime import datetime
from pathlib import Path

import asyncpg

HERE = Path(__file__).resolve().parent      # backen/scraper
BACKEND_DIR = HERE.parent                    # backen
JSON_DIR = HERE / "json"

CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS posts (
    id          text PRIMARY KEY,            -- post URL (lupin) or note id (rednote)
    source      text NOT NULL,               -- 'lupin' | 'rednote'
    platform    text,                        -- instagram | tiktok | xiaohongshu
    url         text,
    title       text,                        -- caption / display_title
    author      text,
    engagement  bigint,                      -- like count
    scraped_at  timestamptz,
    raw         jsonb NOT NULL,              -- the full original post, untouched
    loaded_at   timestamptz NOT NULL DEFAULT now()
);
"""

UPSERT = """
INSERT INTO posts (id, source, platform, url, title, author, engagement, scraped_at, raw)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
ON CONFLICT (id) DO UPDATE SET
    source     = EXCLUDED.source,
    platform   = EXCLUDED.platform,
    url        = EXCLUDED.url,
    title      = EXCLUDED.title,
    author     = EXCLUDED.author,
    engagement = EXCLUDED.engagement,
    scraped_at = EXCLUDED.scraped_at,
    raw        = EXCLUDED.raw,
    loaded_at  = now();
"""


def database_dsn() -> str:
    """Read DATABASE_URL from backen/.env (or env) as a plain asyncpg DSN."""
    url = os.environ.get("DATABASE_URL", "")
    env_file = BACKEND_DIR / ".env"
    if not url and env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    # asyncpg wants postgresql://, not the SQLAlchemy postgresql+asyncpg:// form
    return url.replace("postgresql+asyncpg://", "postgresql://")


def to_int(value) -> int | None:
    """Parse engagement counts like '5', '1,234', '5.2k', '1.2M' into an int."""
    if value is None:
        return None
    s = str(value).strip().lower().replace(",", "")
    if not s:
        return None
    mult = 1
    if s.endswith("k"):
        mult, s = 1_000, s[:-1]
    elif s.endswith("m"):
        mult, s = 1_000_000, s[:-1]
    try:
        return int(float(s) * mult)
    except ValueError:
        return None


def to_dt(value) -> datetime | None:
    """Parse an ISO timestamp string (incl. trailing 'Z') into a datetime."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def extract_posts(data) -> list[tuple[str, dict]]:
    """Return [(source, post_dict), ...] handling both JSON shapes."""
    # Lupin: {"results": [ {...}, ... ]}
    if isinstance(data, dict) and isinstance(data.get("results"), list):
        return [("lupin", p) for p in data["results"] if isinstance(p, dict)]
    # RedNote: [ {item: {...}, link: ...}, ... ]
    if isinstance(data, list):
        return [("rednote", p) for p in data if isinstance(p, dict)]
    return []


def normalize(source: str, p: dict) -> dict | None:
    """Map a raw post into the common columns. Returns None if it has no id."""
    if source == "lupin":
        url = p.get("url") or p.get("finalUrl") or ""
        author = p.get("author") or {}
        author_name = (author.get("name") or author.get("handle")) if isinstance(author, dict) else str(author)
        stats = p.get("stats") if isinstance(p.get("stats"), dict) else {}
        row = {
            "id": url, "source": "lupin", "platform": p.get("platform"), "url": url,
            "title": p.get("caption"), "author": author_name,
            "engagement": to_int(stats.get("likeCount")), "scraped_at": to_dt(p.get("fetchedAt")),
        }
    else:  # rednote
        item = p.get("item") or {}
        nc = item.get("note_card") or {}
        user = nc.get("user") or {}
        interact = nc.get("interact_info") or {}
        url = p.get("link") or ""
        row = {
            "id": item.get("id") or url, "source": "rednote", "platform": "xiaohongshu", "url": url,
            "title": nc.get("display_title"), "author": user.get("nickname"),
            "engagement": to_int(interact.get("liked_count")), "scraped_at": to_dt(p.get("scrapedAt")),
        }
    if not row["id"]:
        return None
    row["raw"] = json.dumps(p, ensure_ascii=False)
    return row


async def main() -> None:
    dsn = database_dsn()
    if not dsn:
        raise SystemExit("DATABASE_URL not set (check backen/.env).")

    files = sorted(glob.glob(str(JSON_DIR / "*.json")))
    if not files:
        print(f"No JSON files in {JSON_DIR} — nothing to load.")
        return

    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(CREATE_TABLE)
        loaded = skipped = 0
        for f in files:
            try:
                data = json.loads(Path(f).read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                print(f"  skip {Path(f).name}: {exc}")
                continue
            posts = extract_posts(data)
            file_loaded = 0
            for source, p in posts:
                row = normalize(source, p)
                if row is None:
                    skipped += 1
                    continue
                await conn.execute(
                    UPSERT, row["id"], row["source"], row["platform"], row["url"],
                    row["title"], row["author"], row["engagement"], row["scraped_at"], row["raw"],
                )
                file_loaded += 1
            loaded += file_loaded
            print(f"  {Path(f).name}: {file_loaded} posts")

        total = await conn.fetchval("SELECT count(*) FROM posts;")
        print(f"\n✅ Loaded/updated {loaded} posts ({skipped} skipped). `posts` table now holds {total} rows.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
