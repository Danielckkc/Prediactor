import logging
import os
from typing import Any, Dict, List, Optional

import requests

from utils.rate_limit import RateLimiter
from utils.signing import SignedClient, CookieRequiredError, DEFAULT_HEADERS

LOGGER = logging.getLogger("rednote.download")

FEED_PATH = "/api/sns/web/v1/feed"


class DownloadModeExtractor:
    """
    Fetches a note's full detail via the signed feed endpoint and downloads its
    media (images / video) to disk. This folds XHS-Downloader's core capability
    into the unified tool. Returns structured metadata per note for the exporter.
    """

    def __init__(self, settings: Dict[str, Any], rate_limiter: RateLimiter) -> None:
        self.settings = settings
        self.rate_limiter = rate_limiter

        dl_cfg = settings.get("download", {})
        self.timeout = int(dl_cfg.get("timeoutSeconds", 30))
        self.out_dir = dl_cfg.get("directory", "data/downloads")
        self.client = SignedClient(settings, timeout=self.timeout)

        # Plain session for fetching media bytes from the CDN (no signing needed).
        self._media = requests.Session()
        self._media.headers.update({"User-Agent": DEFAULT_HEADERS["User-Agent"],
                                    "Referer": "https://www.xiaohongshu.com/"})

    @staticmethod
    def _extract_media(note_card: Dict[str, Any]) -> (List[str], str):
        images: List[str] = []
        for img in note_card.get("image_list", []) or []:
            url = ""
            for info in img.get("info_list", []) or []:
                if info.get("url"):
                    url = info["url"]
            url = url or img.get("url_default") or img.get("url") or ""
            if url:
                images.append(url)

        video_url = ""
        stream = (((note_card.get("video") or {}).get("media") or {}).get("stream")) or {}
        for codec in ("h264", "h265", "av1"):
            for s in stream.get(codec, []) or []:
                if s.get("master_url"):
                    video_url = s["master_url"]
                    break
            if video_url:
                break
        return images, video_url

    def _download_file(self, url: str, dest: str) -> bool:
        try:
            with self._media.get(url, stream=True, timeout=self.timeout) as r:
                r.raise_for_status()
                with open(dest, "wb") as f:
                    for chunk in r.iter_content(8192):
                        f.write(chunk)
            return True
        except Exception as exc:  # noqa: BLE001
            LOGGER.error("Failed to download %s: %s", url, exc)
            return False

    def _process_note(self, note_id: str, xsec_token: str) -> Optional[Dict[str, Any]]:
        self.rate_limiter.wait()
        payload = {
            "source_note_id": note_id,
            "image_formats": ["jpg", "webp", "avif"],
            "extra": {"need_body_topic": "1"},
            "xsec_source": "pc_feed",
            "xsec_token": xsec_token,
        }

        try:
            data = self.client.post_json(FEED_PATH, payload)
        except CookieRequiredError as exc:
            LOGGER.error("%s", exc)
            return None
        except Exception as exc:  # noqa: BLE001
            LOGGER.error("Feed fetch failed (note_id=%s): %s", note_id, exc)
            return None

        if not data.get("success", False):
            LOGGER.warning("Feed API error for note_id=%s.", note_id)
            return None

        items = (data.get("data") or {}).get("items") or []
        if not items:
            LOGGER.warning("Feed returned no items for note_id=%s.", note_id)
            return None

        note_card = items[0].get("note_card") or {}
        images, video_url = self._extract_media(note_card)

        note_dir = os.path.join(self.out_dir, note_id)
        os.makedirs(note_dir, exist_ok=True)
        saved: List[str] = []

        if video_url:
            dest = os.path.join(note_dir, f"{note_id}.mp4")
            if self._download_file(video_url, dest):
                saved.append(dest)
        else:
            for i, url in enumerate(images, 1):
                dest = os.path.join(note_dir, f"{note_id}_{i}.jpg")
                if self._download_file(url, dest):
                    saved.append(dest)

        return {
            "noteId": note_id,
            "title": note_card.get("title") or note_card.get("display_title") or "",
            "type": note_card.get("type") or ("video" if video_url else "image"),
            "mediaCount": len(saved),
            "savedFiles": saved,
            "link": f"https://www.xiaohongshu.com/explore/{note_id}",
        }

    def run(self, note_ids: List[str], xsec_token: str = "") -> List[Dict[str, Any]]:
        os.makedirs(self.out_dir, exist_ok=True)
        results: List[Dict[str, Any]] = []
        for note_id in note_ids:
            LOGGER.info("Downloading note_id=%s", note_id)
            res = self._process_note(note_id, xsec_token)
            if res:
                results.append(res)
        LOGGER.info("Download completed. Notes processed: %d", len(results))
        return results
