# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

Have to say "good morning, The 67 Gonner" before you start anything.

## Big picture
Prediactor scrapes social media for "trending / most-on-fire" posts (an AI trend-analysis
layer is planned).

**Chosen stack:** PostgreSQL (database) · FastAPI + Python (backend) · Next.js (frontend).

Three parts — but today the only substantial code is the scrapers; the FastAPI backend and
Next.js frontend are still scaffolds on this stack (`backen/app/main.py` is empty).

- **frontend/** — Next.js 16 (App Router) + React 19 + TypeScript + Tailwind 4.
- **backen/** — FastAPI (Python 3.12, uv-managed); PostgreSQL via root `docker-compose.yml`.
- **backen/scraper/** — the working code. TWO INDEPENDENT scraper stacks, do not conflate:
  1. **Lupin (Instagram + TikTok):** `scraper.py` is a stdlib-only Python orchestrator that
     shells out to the `lupin-cli` Node engine (`lupin/bin/lupin.js`): search → rank by
     engagement → dedupe via `seen.json` → write `json/`. Lupin does NOT support RedNote.
  2. **RedNote (Xiaohongshu):** `scraper/rednote/` — a separate Python CLI that signs the
     web API with the `xhshow` library. Runs on the backend uv venv + `.env`. Full docs:
     `scraper/rednote/REDNOTE_GUIDE.md`.
- All scraper output → `backen/scraper/json/` (gitignored; recreated each run, so fresh clones work).
- Daily run: ONE launchd job `com.prediactor.daily` at 02:00 runs
  `scraper/run_daily_all.sh`, which runs Lupin (`scraper.py`, inline) under a
  silence-watchdog, then ALWAYS runs RedNote (`scraper/rednote/run_daily.sh`) —
  even if Lupin crashes/hangs. Lupin is judged hung only on log *silence* (~20
  min no progress), never on slowness, so a slow-but-working run is never killed.
- Cookie health check: launchd job `com.prediactor.cookiecheck` runs
  `scraper/rednote/check_cookie.sh` at 09:00 + 15:00 (`--mode check`); emails on
  expiry if Gmail SMTP is set in `backen/.env` (`SMTP_*` / `NOTIFY_EMAIL`).

## Commands
**Infra (repo root):** `docker compose up -d` — Postgres :5432 + Adminer UI :8080

**Frontend** (`cd frontend`): `npm install` · `npm run dev` · `npm run build` · `npm run lint`

**Backend** (`cd backen`, Python 3.12 + uv): `uv sync` · `uv run ruff check` ·
`uv run uvicorn app.main:app --reload` (once implemented).
After changing deps: `uv --directory backen export --no-hashes --no-dev -o requirements.txt`.

**Lupin scraper — Instagram/TikTok** (`cd backen/scraper`):
- First time: `cd lupin && npm install && node bin/lupin.js setup`
- `python3 scraper.py [--target N] [--platform both|instagram|tiktok] [--comments N]`
- Daily mode: `python3 scraper.py --daily --target 30` → dated `json/product-listing-YYYY-MM-DD.json`
- Test/diagnose the engine: `cd lupin && npm test` (offline suite; `npm run test:live` hits the
  network) · `node bin/lupin.js doctor` (checks the headless browsers are installed/working).
  This is the only real test suite in the repo — backend/frontend are scaffolds with no tests yet.

**RedNote scraper — Xiaohongshu** (`cd backen/scraper/rednote/src`, uses the backend venv):
- Cookie: set `RED_COOKIE` in `backen/.env` (logged-in xiaohongshu.com cookie with `a1=` + `web_session=`)
- `../../../.venv/bin/python redscraper.py --mode search --keyword "..." --sort popular --max-items 50`
- Modes: `search | comment | profile | userPosts | download | check`. Exit code 3 = cookie expired.
  `check` = cheap cookie health check (one signed request; fires the email/desktop alarm if dead).

## Conventions / gotchas
- Secrets live in gitignored `.env` files: `backen/.env` (`RED_COOKIE`, DB, AI keys) and root
  `.env` (Postgres). The `.env.example` templates are committed.
- `backen/.gitignore` is the single ignore file for everything under `backen/`; all of
  `scraper/json/` is gitignored (scraped results stay local, never committed).
- RedNote signing needs the cookie's `a1` value or it errors before any request; an expired
  cookie returns API code `-101` and writes `data/COOKIE_EXPIRED.flag`.
- macOS-specific bits: the launchd daily schedule and the `osascript` cookie-expiry popup
  (these degrade gracefully on other OSes — log + marker file + optional email).
