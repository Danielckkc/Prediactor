import logging
from typing import Any, Dict, List

from utils.parser import parse_user_posts
from utils.rate_limit import RateLimiter
from utils.signing import SignedClient, CookieRequiredError

LOGGER = logging.getLogger("rednote.user_posts")

USER_POSTED_PATH = "/api/sns/web/v1/user_posted"


class UserPostsModeExtractor:
    """
    Extracts a user's published posts via the signed web API. Uses cursor-based
    pagination (the endpoint returns up to `num` notes per page).
    """

    def __init__(self, settings: Dict[str, Any], rate_limiter: RateLimiter) -> None:
        self.settings = settings
        self.rate_limiter = rate_limiter

        posts_cfg = settings.get("userPosts", {})
        self.num = int(posts_cfg.get("pageSize", 30))
        self.timeout = int(posts_cfg.get("timeoutSeconds", 10))
        self.client = SignedClient(settings, timeout=self.timeout)

    def _fetch_posts_for_user(self, user_id: str, max_items: int) -> List[Dict[str, Any]]:
        posts: List[Dict[str, Any]] = []
        cursor = ""

        LOGGER.info("Fetching posts for user_id=%s", user_id)

        while len(posts) < max_items:
            self.rate_limiter.wait()

            params = {
                "num": self.num,
                "cursor": cursor,
                "user_id": user_id,
                "image_formats": "jpg,webp,avif",
                "xsec_token": "",
                "xsec_source": "pc_search",
            }

            try:
                data = self.client.get_json(USER_POSTED_PATH, params)
            except CookieRequiredError as exc:
                LOGGER.error("%s", exc)
                break
            except Exception as exc:  # noqa: BLE001
                LOGGER.error("User posts fetch failed (user_id=%s): %s", user_id, exc)
                break

            if not data.get("success", False):
                LOGGER.warning("User posts API error for user_id=%s; stopping.", user_id)
                break

            items = parse_user_posts(data, user_id)
            if not items:
                LOGGER.info("No more posts for user_id=%s.", user_id)
                break

            for item in items:
                posts.append(item)
                if len(posts) >= max_items:
                    break

            block = data.get("data") or {}
            cursor = block.get("cursor") or ""
            if not block.get("has_more", False) or not cursor:
                break

        return posts

    def run(self, user_ids: List[str], max_items: int) -> List[Dict[str, Any]]:
        all_posts: List[Dict[str, Any]] = []
        for user_id in user_ids:
            all_posts.extend(self._fetch_posts_for_user(user_id, max_items))

        LOGGER.info(
            "User posts scraping completed. Total posts across %d users: %d",
            len(user_ids), len(all_posts),
        )
        return all_posts
