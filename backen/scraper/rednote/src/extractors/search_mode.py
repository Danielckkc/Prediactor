import logging
import random
import time
from typing import Any, Dict, List

from utils.parser import parse_search_items
from utils.rate_limit import RateLimiter
from utils.signing import SignedClient, CookieRequiredError

LOGGER = logging.getLogger("rednote.search")

SEARCH_PATH = "/api/sns/web/v1/search/notes"

# Accept friendly names in settings.json and map to XHS web sort values.
SORT_MAP = {
    "general": "general",
    "popular": "popularity_descending",
    "popularity": "popularity_descending",
    "hot": "popularity_descending",
    "latest": "time_descending",
    "time": "time_descending",
}


def _base36(n: int) -> str:
    if n == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = []
    while n > 0:
        n, r = divmod(n, 36)
        out.append(digits[r])
    return "".join(reversed(out))


def _generate_search_id() -> str:
    """Mimic the XHS web client's search_id: (ms_ts << 64 | rand) in base36."""
    e = int(time.time() * 1000) << 64
    t = int(random.uniform(0, 2147483646))
    return _base36(e + t)


class SearchModeExtractor:
    """
    Keyword search via the signed web API. `search.sort` in settings.json can
    be 'popular' (closest to "trending for a topic"), 'latest', or 'general'.
    """

    def __init__(self, settings: Dict[str, Any], rate_limiter: RateLimiter) -> None:
        self.settings = settings
        self.rate_limiter = rate_limiter

        search_cfg = settings.get("search", {})
        self.page_size = int(search_cfg.get("pageSize", 20))
        self.sort = SORT_MAP.get(str(search_cfg.get("sort", "general")).lower(), "general")
        self.note_type = int(search_cfg.get("noteType", 0))  # 0=all, 1=video, 2=image
        self.timeout = int(search_cfg.get("timeoutSeconds", 10))
        self.client = SignedClient(settings, timeout=self.timeout)

    def run(self, keyword: str, max_items: int) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        page = 1
        search_id = _generate_search_id()

        LOGGER.info(
            "Starting search for keyword=%r sort=%s max_items=%d",
            keyword, self.sort, max_items,
        )

        while len(results) < max_items:
            self.rate_limiter.wait()

            payload = {
                "keyword": keyword,
                "page": page,
                "page_size": self.page_size,
                "search_id": search_id,
                "sort": self.sort,
                "note_type": self.note_type,
                "ext_flags": [],
                "image_formats": ["jpg", "webp", "avif"],
            }

            try:
                data = self.client.post_json(SEARCH_PATH, payload)
            except CookieRequiredError as exc:
                LOGGER.error("%s", exc)
                break
            except Exception as exc:  # noqa: BLE001 - network/transport
                LOGGER.error("Search request failed (page=%d): %s", page, exc)
                break

            if not data.get("success", False):
                LOGGER.warning("Search API returned an error on page=%d; stopping.", page)
                break

            items = parse_search_items(data, keyword)
            if not items:
                LOGGER.info("No more items returned; stopping at page=%d.", page)
                break

            for item in items:
                results.append(item)
                if len(results) >= max_items:
                    break

            LOGGER.debug("Collected %d/%d items so far", len(results), max_items)

            if not (data.get("data") or {}).get("has_more", True):
                break
            page += 1

        LOGGER.info("Search completed. Total items collected: %d", len(results))
        return results
