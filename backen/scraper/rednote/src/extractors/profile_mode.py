import logging
from typing import Any, Dict, List

from utils.parser import parse_profile
from utils.rate_limit import RateLimiter
from utils.signing import SignedClient, CookieRequiredError

LOGGER = logging.getLogger("rednote.profile")

PROFILE_PATH = "/api/sns/web/v1/user/otherinfo"


class ProfileModeExtractor:
    """
    Extracts user profile details (nickname, followers, engagement) via the
    signed web API.
    """

    def __init__(self, settings: Dict[str, Any], rate_limiter: RateLimiter) -> None:
        self.settings = settings
        self.rate_limiter = rate_limiter

        profile_cfg = settings.get("profile", {})
        self.timeout = int(profile_cfg.get("timeoutSeconds", 10))
        self.client = SignedClient(settings, timeout=self.timeout)

    def _fetch_profile(self, user_id: str) -> Dict[str, Any]:
        self.rate_limiter.wait()
        params = {"target_user_id": user_id}

        try:
            data = self.client.get_json(PROFILE_PATH, params)
        except CookieRequiredError as exc:
            LOGGER.error("%s", exc)
            return {}
        except Exception as exc:  # noqa: BLE001
            LOGGER.error("Profile fetch failed (user_id=%s): %s", user_id, exc)
            return {}

        if not data.get("success", False):
            LOGGER.warning("Profile API error for user_id=%s.", user_id)
            return {}

        return parse_profile(data, user_id)

    def run(self, user_ids: List[str]) -> List[Dict[str, Any]]:
        profiles: List[Dict[str, Any]] = []

        for user_id in user_ids:
            LOGGER.info("Fetching profile for user_id=%s", user_id)
            profile = self._fetch_profile(user_id)
            if profile:
                profiles.append(profile)

        LOGGER.info("Profile scraping completed. Profiles collected: %d", len(profiles))
        return profiles
