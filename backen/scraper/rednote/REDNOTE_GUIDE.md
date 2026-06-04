# All-in-One RedNote (Xiaohongshu) Scraper 🔍 — Unified Build

A single CLI for collecting RedNote (Xiaohongshu) data

Every request is signed with [`xhshow`](https://pypi.org/project/xhshow/)
(`x-s` / `x-t` / `x-s-common`), which is what gets past the gateway that
returns `HTTP 500 "create invoker failed"` for unsigned requests.

---

## ⚠️ You need a logged-in RedNote cookie

The signer proves a request is well-formed, but Xiaohongshu derives part of the
signature from your **`a1` login cookie** and rejects sessionless requests with
`code -101 无登录信息` ("no login info"). **A logged-in account is mandatory.**

### Get your cookie
1. Log in at <https://www.xiaohongshu.com> in a browser.
2. Open DevTools (F12) → **Network** tab → reload the page.
3. Click any request to `xiaohongshu.com` → **Request Headers** → copy the full
   `cookie:` value (it must contain `a1=...` and `web_session=...`).

### Where to put it — the backend `.env`
This scraper is a module of the Prediactor backend, so it shares the backend's
environment and venv. Put your cookie in **`backen/.env`** (gitignored):

```bash
# in backen/.env
RED_COOKIE="a1=...; web_session=...; ..."
```

`RED_COOKIE` **takes precedence** over `src/config/settings.json` → `http.cookie`
(which still works as a fallback). The loader finds `backen/.env` automatically.

---

## Setup

No separate venv — the dependencies (`requests`, `xhshow`) live in the backend's
`pyproject.toml`. Install once from the backend:

```bash
cd backen && uv sync          # installs everything, including this scraper's deps
```

## Usage

Run from this `src/` directory using the **backend** venv:

```bash
cd backen/scraper/rednote/src
alias py="../../../.venv/bin/python"   # the shared backend venv

# Search — 'popular' sort ≈ "trending for a topic"
py main.py --mode search --keyword "美食" --sort popular --max-items 50

# Comments for a note
py main.py --mode comment --note-id NOTE_ID --xsec-token TOKEN --max-items 100

# A user's profile / their posts
py main.py --mode profile   --user-id USER_ID
py main.py --mode userPosts --user-id USER_ID --max-items 50

# Download a note's media (paste the full share link, token included)
py main.py --mode download --url "https://www.xiaohongshu.com/explore/NOTE_ID?xsec_token=XXX"
```

Results are written to the shared **`backen/scraper/json/`** folder (next to
`product-listing.json`), as `rednote_output_*.json`. Media downloads go to
`data/downloads/<note_id>/`. All of `scraper/json/` is **gitignored** — scraper
results stay local and are never pushed; every machine regenerates them on run.

### Settings (`src/config/settings.json`)
- `http.cookie` — your logged-in cookie (required)
- `search.sort` — `popular` | `latest` | `general`
- `rateLimit.callsPerMinute` — be polite; default 30

### Userscript helper
`userscript/collect-note-ids.user.js` (Tampermonkey) collects `id → title`
pairs as you browse, to gather note IDs to feed the tool.

### Cookie-expiry alerts
Cookies expire every few weeks. When RedNote rejects yours, the tool tells you
immediately instead of silently collecting nothing — via **all** of:
- a loud `COOKIE EXPIRED` log block,
- a marker file `data/COOKIE_EXPIRED.flag`,
- a macOS desktop notification,
- an email (only if SMTP is set in `.env` — see `.env.example`),
- and **exit code 3** (so a cron job can detect it: `... ; [ $? -eq 3 ] && ...`).

When you see it: log in again, copy a fresh cookie into `.env`, done. (A
*missing* cookie is different — that just warns "cookie required" and exits 0.)

---

## Honest limitations
- **Account required** — no logged-in cookie, no data. This is RedNote's design.
- **No global "trending" feed** — RedNote exposes none. The closest is
  `search --sort popular` (most popular results *for a keyword*).
- **Fragile** — RedNote rotates its signing periodically; if calls start failing
  with signature errors, update `xhshow` (`uv pip install -U xhshow`).
- Respect RedNote's Terms of Service and rate limits. For research/personal use.
