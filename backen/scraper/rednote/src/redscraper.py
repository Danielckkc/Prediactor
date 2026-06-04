import argparse
import json
import logging
import os
import re
import sys
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

from extractors.search_mode import SearchModeExtractor, _generate_search_id
from extractors.comment_mode import CommentModeExtractor
from extractors.profile_mode import ProfileModeExtractor
from extractors.user_posts_mode import UserPostsModeExtractor
from extractors.download_mode import DownloadModeExtractor
from output.exporter import JsonExporter
from utils.rate_limit import RateLimiter
from utils.notify import cookie_expired_was_detected
from utils.signing import SignedClient, CookieRequiredError

LOGGER = logging.getLogger("rednote.redscraper")

_NOTE_ID_RE = re.compile(r"/(?:explore|item)/([0-9a-fA-F]+)")


def parse_note_url(url: str) -> Dict[str, str]:
    """Extract note_id (and xsec_token if present) from a RedNote note URL."""
    note_id, xsec_token = "", ""
    m = _NOTE_ID_RE.search(url)
    if m:
        note_id = m.group(1)
    elif re.fullmatch(r"[0-9a-fA-F]+", url.strip()):
        note_id = url.strip()  # a bare note id was passed
    qs = parse_qs(urlparse(url).query)
    if "xsec_token" in qs:
        xsec_token = qs["xsec_token"][0]
    return {"note_id": note_id, "xsec_token": xsec_token}

def load_dotenv() -> None:
    """
    Load KEY=VALUE pairs (e.g. RED_COOKIE) from the nearest `.env` found by
    walking up from this file — which lands on the shared backend `.env`
    (backen/.env). Existing environment variables are never overwritten.
    Lightweight, no external dependency.
    """
    d = os.path.dirname(os.path.abspath(__file__))
    env_path = None
    for _ in range(6):  # src -> rednote -> scraper -> backen (.env lives here)
        candidate = os.path.join(d, ".env")
        if os.path.exists(candidate):
            env_path = candidate
            break
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    if not env_path:
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value

def configure_logging(verbose: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )

def load_settings() -> Dict[str, Any]:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    settings_path = os.path.join(base_dir, "config", "settings.json")
    if not os.path.exists(settings_path):
        raise FileNotFoundError(f"Settings file not found at {settings_path}")

    with open(settings_path, "r", encoding="utf-8") as f:
        return json.load(f)

def load_sample_input() -> Dict[str, Any]:
    # repo root is one level up from src
    base_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(base_dir, ".."))
    sample_path = os.path.join(repo_root, "data", "sample_input.json")
    if not os.path.exists(sample_path):
        raise FileNotFoundError(f"Sample input file not found at {sample_path}")

    with open(sample_path, "r", encoding="utf-8") as f:
        return json.load(f)

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="All-in-One RedNote (Xiaohongshu) Scraper"
    )
    parser.add_argument(
        "--mode",
        choices=["search", "comment", "profile", "userPosts", "download", "check"],
        help="Scraping mode (or 'check' = cookie health check). "
             "If omitted, falls back to data/sample_input.json",
    )
    parser.add_argument("--keyword", help="Keyword for search mode")
    parser.add_argument(
        "--sort",
        choices=["general", "popular", "latest"],
        help="Search result ordering (search mode). 'popular' ~= trending for a topic.",
    )
    parser.add_argument(
        "--note-id",
        action="append",
        help="Note ID for comment/download mode. Can be specified multiple times.",
    )
    parser.add_argument(
        "--url",
        action="append",
        help="Full note URL (with xsec_token) for download mode. Repeatable.",
    )
    parser.add_argument(
        "--xsec-token",
        help="xsec_token applied to download/comment requests (if not in the URL).",
    )
    parser.add_argument(
        "--user-id",
        action="append",
        help="User ID for profile or userPosts mode. Can be specified multiple times.",
    )
    parser.add_argument(
        "--max-items",
        type=int,
        default=None,
        help="Maximum number of items to scrape (per mode).",
    )
    parser.add_argument(
        "--output",
        help="Optional explicit output file path. If omitted, default from settings is used.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )
    return parser.parse_args()

def build_rate_limiter(settings: Dict[str, Any]) -> RateLimiter:
    rate_cfg = settings.get("rateLimit", {})
    calls_per_minute = int(rate_cfg.get("callsPerMinute", 30))
    burst = int(rate_cfg.get("burst", 5))
    return RateLimiter(calls_per_minute=calls_per_minute, burst=burst)

def resolve_config_from_args(args: argparse.Namespace) -> Dict[str, Any]:
    if args.mode:
        # CLI-driven config
        cfg: Dict[str, Any] = {
            "mode": args.mode,
        }
        if args.keyword:
            cfg["keyword"] = args.keyword
        if args.sort:
            cfg["sort"] = args.sort
        if args.note_id:
            cfg["noteIds"] = args.note_id
        if args.user_id:
            cfg["userIds"] = args.user_id
        if args.max_items is not None:
            cfg["maxItems"] = args.max_items

        # download mode: accept either bare note IDs or full URLs (with token)
        note_ids: List[str] = list(args.note_id or [])
        xsec_token = args.xsec_token or ""
        for url in args.url or []:
            parsed = parse_note_url(url)
            if parsed["note_id"]:
                note_ids.append(parsed["note_id"])
            if parsed["xsec_token"] and not xsec_token:
                xsec_token = parsed["xsec_token"]
        if note_ids:
            cfg["noteIds"] = note_ids
        if xsec_token:
            cfg["xsecToken"] = xsec_token
        return cfg

    # Fallback to sample_input.json when mode is not set
    LOGGER.info("No mode provided on CLI. Falling back to data/sample_input.json.")
    return load_sample_input()

def run_search_mode(
    cfg: Dict[str, Any], settings: Dict[str, Any], limiter: RateLimiter
) -> List[Dict[str, Any]]:
    keyword = cfg.get("keyword")
    if not keyword:
        raise ValueError("Search mode requires a 'keyword' in config or CLI.")
    max_items = int(cfg.get("maxItems", settings["search"].get("maxItems", 100)))

    # Let a CLI --sort override settings.json for this run.
    if cfg.get("sort"):
        settings.setdefault("search", {})["sort"] = cfg["sort"]

    extractor = SearchModeExtractor(settings=settings, rate_limiter=limiter)
    return extractor.run(keyword=keyword, max_items=max_items)

def run_comment_mode(
    cfg: Dict[str, Any], settings: Dict[str, Any], limiter: RateLimiter
) -> List[Dict[str, Any]]:
    note_ids = cfg.get("noteIds") or []
    if not note_ids:
        raise ValueError("Comment mode requires at least one 'noteId' in config or CLI.")
    max_items = int(cfg.get("maxItems", settings["comment"].get("maxItemsPerNote", 200)))

    extractor = CommentModeExtractor(settings=settings, rate_limiter=limiter)
    return extractor.run(note_ids=note_ids, max_items=max_items)

def run_profile_mode(
    cfg: Dict[str, Any], settings: Dict[str, Any], limiter: RateLimiter
) -> List[Dict[str, Any]]:
    user_ids = cfg.get("userIds") or []
    if not user_ids:
        raise ValueError("Profile mode requires at least one 'userId' in config or CLI.")

    extractor = ProfileModeExtractor(settings=settings, rate_limiter=limiter)
    return extractor.run(user_ids=user_ids)

def run_user_posts_mode(
    cfg: Dict[str, Any], settings: Dict[str, Any], limiter: RateLimiter
) -> List[Dict[str, Any]]:
    user_ids = cfg.get("userIds") or []
    if not user_ids:
        raise ValueError(
            "User posts mode requires at least one 'userId' in config or CLI."
        )
    max_items = int(cfg.get("maxItems", settings["userPosts"].get("maxItemsPerUser", 200)))

    extractor = UserPostsModeExtractor(settings=settings, rate_limiter=limiter)
    return extractor.run(user_ids=user_ids, max_items=max_items)

def run_download_mode(
    cfg: Dict[str, Any], settings: Dict[str, Any], limiter: RateLimiter
) -> List[Dict[str, Any]]:
    note_ids = cfg.get("noteIds") or []
    if not note_ids:
        raise ValueError(
            "Download mode requires at least one note (use --note-id or --url)."
        )

    extractor = DownloadModeExtractor(settings=settings, rate_limiter=limiter)
    return extractor.run(note_ids=note_ids, xsec_token=cfg.get("xsecToken", ""))

def run_check_mode(settings: Dict[str, Any], limiter: RateLimiter) -> None:
    """
    Cookie health check: one cheap signed request. If the cookie is dead, the
    SignedClient automatically fires the expiry alarm (loud log + marker file +
    desktop popup + email when SMTP is configured). Exits 0 = valid / not set up,
    3 = expired (needs a fresh cookie).
    """
    client = SignedClient(settings, timeout=int(settings.get("search", {}).get("timeoutSeconds", 10)))
    limiter.wait()
    payload = {
        "keyword": "美食", "page": 1, "page_size": 1,
        "search_id": _generate_search_id(), "sort": "general", "note_type": 0,
        "ext_flags": [], "image_formats": ["jpg", "webp", "avif"],
    }
    try:
        data = client.post_json("/api/sns/web/v1/search/notes", payload)
    except CookieRequiredError as exc:
        LOGGER.warning("Cookie not configured yet: %s", exc)
        sys.exit(0)  # not "expired" — just not set up; no alarm
    except Exception as exc:  # noqa: BLE001 - network/transport
        LOGGER.error("Cookie check could not reach RedNote (network?): %s", exc)
        sys.exit(0)  # can't conclude the cookie is dead from a network blip

    if data.get("success"):
        LOGGER.info("✅ Cookie is VALID — RedNote accepted the signed request.")
        sys.exit(0)
    if cookie_expired_was_detected():
        LOGGER.error("❌ Cookie INVALID/EXPIRED — alarm sent. Refresh RED_COOKIE in backen/.env.")
        sys.exit(3)
    LOGGER.error("Cookie check got a non-success response (code=%s).", data.get("code"))
    sys.exit(1)

def main() -> None:
    load_dotenv()  # pick up RED_COOKIE (and any other vars) from .env
    args = parse_args()
    configure_logging(verbose=bool(args.verbose))

    try:
        settings = load_settings()
    except Exception as exc:
        LOGGER.error("Failed to load settings.json: %s", exc)
        sys.exit(1)

    try:
        cfg = resolve_config_from_args(args)
    except Exception as exc:
        LOGGER.error("Failed to load configuration: %s", exc)
        sys.exit(1)

    mode = cfg.get("mode")
    if mode not in {"search", "comment", "profile", "userPosts", "download", "check"}:
        LOGGER.error("Invalid or missing mode in configuration: %r", mode)
        sys.exit(1)

    limiter = build_rate_limiter(settings)

    if mode == "check":
        run_check_mode(settings, limiter)  # health check; exits internally
        return

    exporter = JsonExporter(settings=settings)

    try:
        if mode == "search":
            LOGGER.info("Running in SEARCH mode.")
            data = run_search_mode(cfg, settings, limiter)
        elif mode == "comment":
            LOGGER.info("Running in COMMENT mode.")
            data = run_comment_mode(cfg, settings, limiter)
        elif mode == "profile":
            LOGGER.info("Running in PROFILE mode.")
            data = run_profile_mode(cfg, settings, limiter)
        elif mode == "download":
            LOGGER.info("Running in DOWNLOAD mode.")
            data = run_download_mode(cfg, settings, limiter)
        else:
            LOGGER.info("Running in USER POSTS mode.")
            data = run_user_posts_mode(cfg, settings, limiter)
    except KeyboardInterrupt:
        LOGGER.warning("Interrupted by user.")
        sys.exit(130)
    except Exception as exc:
        LOGGER.exception("Scraping failed: %s", exc)
        sys.exit(1)

    if not data:
        if cookie_expired_was_detected():
            # Distinct exit code so a cron wrapper can detect "needs new cookie".
            LOGGER.error("No data: cookie expired. Exiting with code 3.")
            sys.exit(3)
        LOGGER.warning("No data was scraped. Exiting without writing output.")
        sys.exit(0)

    try:
        output_path: Optional[str] = args.output
        final_path = exporter.export(data, output_path=output_path)
        LOGGER.info("Scraped %d records. Output written to %s", len(data), final_path)
    except Exception as exc:
        LOGGER.exception("Failed to export data: %s", exc)
        sys.exit(1)

if __name__ == "__main__":
    main()