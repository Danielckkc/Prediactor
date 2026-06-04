"""
Shared signed-request layer for the unified RedNote tool.

Every Xiaohongshu web-API call must carry signed headers (x-s / x-t /
x-s-common ...) that the gateway validates. We generate them with the
`xhshow` library — the same engine XHS-Downloader uses — and attach the
logged-in cookie. This is what lets the scraper get past the gateway that
returns HTTP 500 / "create invoker failed" for unsigned requests.

NOTE: xhshow derives part of the signature from the `a1` cookie value and
raises if it is missing. A logged-in cookie is therefore mandatory for live
data. Without one, `CookieRequiredError` is raised with a clear message.
"""

import logging
import os
from typing import Any, Dict, Optional

import requests
from xhshow import Xhshow

from utils.notify import is_auth_failure, notify_cookie_expired

LOGGER = logging.getLogger("rednote.signing")

# Real Xiaohongshu web-API host (the public www.* host returns 500 for these).
DEFAULT_API_HOST = "https://edith.xiaohongshu.com"

# Browser-like headers the web API expects alongside the signed headers.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json;charset=UTF-8",
    "Origin": "https://www.xiaohongshu.com",
    "Referer": "https://www.xiaohongshu.com/",
}


class CookieRequiredError(RuntimeError):
    """Raised when signing is attempted without a usable (a1-bearing) cookie."""


class SignedClient:
    """
    Thin requests wrapper that signs every call with xhshow and carries the
    configured cookie. One instance is shared by all extractor modes.
    """

    def __init__(self, settings: Dict[str, Any], timeout: int = 10) -> None:
        http_cfg = settings.get("http", {})
        # Precedence: RED_COOKIE env var (from .env) > settings.json http.cookie.
        # Keeping the cookie in a gitignored .env avoids committing credentials.
        self.cookie: str = (
            os.environ.get("RED_COOKIE") or http_cfg.get("cookie") or ""
        ).strip()
        self.host: str = settings.get("apiHost", DEFAULT_API_HOST).rstrip("/")
        self.timeout = timeout
        self._settings = settings  # kept for cookie-expiry notifications

        self._signer = Xhshow()
        self._session = requests.Session()
        merged = {**DEFAULT_HEADERS, **http_cfg.get("headers", {})}
        if self.cookie:
            merged["Cookie"] = self.cookie
        self._session.headers.update(merged)

        self._has_a1 = "a1=" in self.cookie
        if not self.cookie:
            LOGGER.warning(
                "No cookie configured (set RED_COOKIE in .env, or http.cookie "
                "in settings.json). Requests cannot be signed and will be "
                "refused until a logged-in cookie is added."
            )
        elif not self._has_a1:
            LOGGER.warning(
                "Cookie is set but contains no 'a1=' value; xhshow needs it "
                "to sign. Copy the FULL cookie header from a logged-in browser."
            )

    # -- internal helpers -------------------------------------------------
    def _uri(self, path: str) -> str:
        return path if path.startswith("http") else f"{self.host}{path}"

    def _ensure_signable(self) -> None:
        if not self._has_a1:
            raise CookieRequiredError(
                "A logged-in RedNote cookie containing 'a1' is required to "
                "sign requests. Set RED_COOKIE in .env (recommended) or "
                "http.cookie in settings.json."
            )

    def _decode(self, resp: requests.Response, method: str, path: str) -> Dict[str, Any]:
        try:
            data = resp.json()
        except ValueError:
            LOGGER.warning(
                "%s %s -> HTTP %s, non-JSON body (%d bytes)",
                method, path, resp.status_code, len(resp.content),
            )
            return {"success": False, "code": resp.status_code,
                    "msg": "non-JSON response", "_http_status": resp.status_code}
        if not data.get("success", False):
            code, msg = data.get("code"), data.get("msg")
            LOGGER.warning(
                "%s %s -> API error: code=%s msg=%r", method, path, code, msg,
            )
            if is_auth_failure(code, msg):
                # Cookie missing/expired/invalid — fire the alarm (once per run).
                notify_cookie_expired(self._settings)
        return data

    # -- public API -------------------------------------------------------
    def get_json(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Signed GET. `path` may be an absolute URL or an API path."""
        self._ensure_signable()
        params = params or {}
        uri = self._uri(path)
        signed = self._signer.sign_headers_get(uri=uri, cookies=self.cookie, params=params)
        resp = self._session.get(uri, params=params, headers=signed, timeout=self.timeout)
        return self._decode(resp, "GET", path)

    def post_json(self, path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Signed POST. The body sent on the wire MUST byte-match what xhshow
        signed, so we serialize it with xhshow's own build_json_body().
        """
        self._ensure_signable()
        payload = payload or {}
        uri = self._uri(path)
        signed = self._signer.sign_headers_post(uri=uri, cookies=self.cookie, payload=payload)
        body = self._signer.build_json_body(payload)  # compact, matches signature
        resp = self._session.post(
            uri, data=body.encode("utf-8"), headers=signed, timeout=self.timeout
        )
        return self._decode(resp, "POST", path)
