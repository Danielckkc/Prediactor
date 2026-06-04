"""
Cookie-expiry alarm.

When RedNote rejects a request because the cookie is invalid/expired (API codes
like -100 / -101, "无登录信息" / "登录已过期"), we want to tell the user
immediately instead of silently collecting nothing. This fires ONCE per run via
several channels so it works whether you're watching the terminal or running
unattended (cron):

  1. A loud, unmistakable log block
  2. A marker file (data/COOKIE_EXPIRED.flag) a cron wrapper can check
  3. A macOS desktop notification (best-effort)
  4. An email, IF SMTP is configured (settings.json `notify` or env vars)

redscraper.py also exits with code 3 when this fired, so automation can react.
"""

import datetime as _dt
import logging
import os
import smtplib
import subprocess
import sys
from email.mime.text import MIMEText
from typing import Any, Dict

LOGGER = logging.getLogger("rednote.notify")

# XHS auth-failure codes (cookie missing/expired/invalid).
AUTH_FAIL_CODES = {-100, -101, -118}

_FIRED = False  # ensure we notify at most once per process


def is_auth_failure(code: Any, msg: Any) -> bool:
    """True if an API response indicates the cookie is invalid/expired."""
    try:
        if int(code) in AUTH_FAIL_CODES:
            return True
    except (TypeError, ValueError):
        pass
    return "登录" in str(msg)  # "...登录..." == login (expired/missing)


def cookie_expired_was_detected() -> bool:
    return _FIRED


def _desktop_notification(title: str, message: str) -> None:
    if sys.platform != "darwin":
        return

    def safe(s: str) -> str:
        return s.replace("\\", "").replace('"', "'")

    script = (
        f'display notification "{safe(message)}" '
        f'with title "{safe(title)}" sound name "Glass"'
    )
    try:
        subprocess.run(
            ["osascript", "-e", script], check=False, capture_output=True, timeout=10
        )
    except Exception:  # noqa: BLE001 - notification is best-effort
        pass


def _email_notification(subject: str, body: str, cfg: Dict[str, Any]) -> None:
    host = cfg.get("smtpHost") or os.environ.get("SMTP_HOST")
    if not host:
        return  # email not configured — silently skip
    port = int(cfg.get("smtpPort") or os.environ.get("SMTP_PORT") or 587)
    user = cfg.get("smtpUser") or os.environ.get("SMTP_USER")
    password = cfg.get("smtpPassword") or os.environ.get("SMTP_PASSWORD")
    to_addr = cfg.get("to") or os.environ.get("NOTIFY_EMAIL") or user
    if not (user and password and to_addr):
        LOGGER.warning("Email notify half-configured; need SMTP user/password/to.")
        return
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = to_addr
    try:
        with smtplib.SMTP(host, port, timeout=15) as server:
            server.starttls()
            server.login(user, password)
            server.sendmail(user, [to_addr], msg.as_string())
        LOGGER.info("Sent cookie-expired email to %s", to_addr)
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("Email notification failed: %s", exc)


def notify_cookie_expired(settings: Dict[str, Any]) -> None:
    """Fire the cookie-expired alarm across all channels (once per process)."""
    global _FIRED
    if _FIRED:
        return
    _FIRED = True

    when = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    title = "RedNote scraper — cookie expired"
    message = "RedNote rejected your cookie. Log in again and refresh RED_COOKIE in .env."

    LOGGER.error("=" * 64)
    LOGGER.error("⚠️  COOKIE EXPIRED — RedNote rejected the login (no login info).")
    LOGGER.error("    Fix: log in at xiaohongshu.com, copy a fresh cookie into .env")
    LOGGER.error("    (RED_COOKIE). Until then, scrapes will return no data.")
    LOGGER.error("=" * 64)

    # Marker file for unattended/cron detection. Kept in a fixed rednote-local
    # spot (rednote/data/), NOT the scrape-output dir — so it never lands in the
    # shared/committed scraper/json/ folder.
    try:
        project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        marker_dir = os.path.join(project_root, "data")
        os.makedirs(marker_dir, exist_ok=True)
        with open(os.path.join(marker_dir, "COOKIE_EXPIRED.flag"), "w", encoding="utf-8") as f:
            f.write(f"[{when}] {message}\n")
    except Exception:  # noqa: BLE001
        pass

    notify_cfg = settings.get("notify", {})
    if notify_cfg.get("desktop", True):
        _desktop_notification(title, message)
    _email_notification(title, f"[{when}] {message}", notify_cfg)
