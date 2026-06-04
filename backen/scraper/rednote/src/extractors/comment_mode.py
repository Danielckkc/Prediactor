import logging
from typing import Any, Dict, List

from utils.parser import parse_comment_items
from utils.rate_limit import RateLimiter
from utils.signing import SignedClient, CookieRequiredError

LOGGER = logging.getLogger("rednote.comment")

COMMENT_PATH = "/api/sns/web/v2/comment/page"


class CommentModeExtractor:
    """
    Extracts comments (including sub-comments) for a list of note IDs via the
    signed web API. Uses cursor-based pagination.

    Note: the live endpoint also expects a per-note `xsec_token`. Supply it via
    settings.json `comment.xsecToken` when available; without it some notes
    return an empty/blocked result.
    """

    def __init__(self, settings: Dict[str, Any], rate_limiter: RateLimiter) -> None:
        self.settings = settings
        self.rate_limiter = rate_limiter

        comment_cfg = settings.get("comment", {})
        self.timeout = int(comment_cfg.get("timeoutSeconds", 10))
        self.xsec_token = comment_cfg.get("xsecToken", "")
        self.client = SignedClient(settings, timeout=self.timeout)

    def _fetch_comments_for_note(self, note_id: str, max_items: int) -> List[Dict[str, Any]]:
        comments: List[Dict[str, Any]] = []
        cursor = ""

        LOGGER.info("Fetching comments for note_id=%s", note_id)

        while len(comments) < max_items:
            self.rate_limiter.wait()

            params = {
                "note_id": note_id,
                "cursor": cursor,
                "top_comment_id": "",
                "image_formats": "jpg,webp,avif",
                "xsec_token": self.xsec_token,
            }

            try:
                data = self.client.get_json(COMMENT_PATH, params)
            except CookieRequiredError as exc:
                LOGGER.error("%s", exc)
                break
            except Exception as exc:  # noqa: BLE001
                LOGGER.error("Comment fetch failed (note_id=%s): %s", note_id, exc)
                break

            if not data.get("success", False):
                LOGGER.warning("Comment API error for note_id=%s; stopping.", note_id)
                break

            items = parse_comment_items(data, note_id)
            if not items:
                LOGGER.info("No more comments for note_id=%s.", note_id)
                break

            for item in items:
                comments.append(item)
                if len(comments) >= max_items:
                    break

            block = data.get("data") or {}
            cursor = block.get("cursor") or ""
            if not block.get("has_more", False) or not cursor:
                break

        return comments

    def run(self, note_ids: List[str], max_items: int) -> List[Dict[str, Any]]:
        all_comments: List[Dict[str, Any]] = []
        for note_id in note_ids:
            all_comments.extend(self._fetch_comments_for_note(note_id, max_items))

        LOGGER.info(
            "Comment scraping completed. Total comments across %d notes: %d",
            len(note_ids), len(all_comments),
        )
        return all_comments
