
from __future__ import annotations

import email as email_lib
import imaplib
import json
import os
import random
import re
import string
import time
from email.header import decode_header
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ============================================================
# Config: catch-all domain + IMAP (fast, alibaba-farm style)
# ============================================================

_config_path = Path(__file__).parent / "config.json"
_conf: Dict[str, Any] = {}
if _config_path.exists():
    with _config_path.open("r", encoding="utf-8") as _f:
        _conf = json.load(_f)

_email_conf = _conf.get("email") if isinstance(_conf.get("email"), dict) else {}


def _cfg(key: str, env_key: str, default: str = "") -> str:
    val = _email_conf.get(key)
    if val is None or val == "":
        val = _conf.get(key)
    if val is None or val == "":
        val = os.environ.get(env_key, default)
    return str(val or default)


def _email_domain() -> str:
    return (
        os.environ.get("EMAIL_DOMAIN")
        or _cfg("domain", "EMAIL_DOMAIN")
        or _cfg("email_domain", "EMAIL_DOMAIN")
        or ""
    ).strip()


def _imap_user() -> str:
    return (os.environ.get("IMAP_USER") or _cfg("imap_user", "IMAP_USER") or "").strip()


def _imap_pass() -> str:
    return (os.environ.get("IMAP_PASS") or _cfg("imap_pass", "IMAP_PASS") or "").strip()


def _imap_host() -> str:
    return (
        os.environ.get("IMAP_HOST")
        or _cfg("imap_host", "IMAP_HOST", "imap.gmail.com")
        or "imap.gmail.com"
    ).strip()


def _imap_port() -> int:
    raw = os.environ.get("IMAP_PORT") or _cfg("imap_port", "IMAP_PORT", "993") or "993"
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 993


# Back-compat module-level names (may be empty until env is set by 9router)
EMAIL_DOMAIN = _email_domain()
IMAP_USER = _imap_user()
IMAP_PASS = _imap_pass()
IMAP_HOST = _imap_host()
IMAP_PORT = _imap_port()

# ============================================================
# Adapter for farm.py
# ============================================================

_temp_email_cache: Dict[str, str] = {}


def get_email_and_token() -> Tuple[Optional[str], Optional[str]]:
    """Generate catch-all alias. Returns (email, token) — token == email for IMAP."""
    email_addr = create_temp_email()
    if email_addr:
        _temp_email_cache[email_addr] = email_addr
        return email_addr, email_addr
    return None, None


def get_oai_code(dev_token: str, email: str, timeout: int = 120) -> Optional[str]:
    """Poll IMAP for Grok/x.ai OTP. Strips hyphens for form fill."""
    target = (email or dev_token or "").strip()
    if not target:
        return None
    code = wait_for_verification_code(target_email=target, timeout=timeout)
    if code:
        code = code.replace("-", "")
    return code


# ============================================================
# Core
# ============================================================

def _require_imap_config() -> None:
    missing = []
    if not _email_domain():
        missing.append("Catch-all domain")
    if not _imap_user():
        missing.append("IMAP user (Gmail)")
    if not _imap_pass():
        missing.append("IMAP app password")
    if missing:
        raise Exception(
            "Email/IMAP not configured in 9router Add Account (Grok CLI). Missing: "
            + ", ".join(missing)
        )


def create_temp_email() -> str:
    _require_imap_config()
    chars = string.ascii_lowercase + string.digits
    local = "".join(random.choice(chars) for _ in range(random.randint(8, 13)))
    email_addr = f"{local}@{_email_domain().lstrip('@')}"
    print(f"[*] Catch-all email: {email_addr}")
    return email_addr


def _decode_header_value(raw: Optional[str]) -> str:
    if not raw:
        return ""
    parts = decode_header(raw)
    out: List[str] = []
    for chunk, charset in parts:
        if isinstance(chunk, bytes):
            out.append(chunk.decode(charset or "utf-8", errors="replace"))
        else:
            out.append(str(chunk))
    return " ".join(out)


def extract_verification_code(content: str) -> Optional[str]:
    """
    Extract OTP from subject/body.
    x.ai subject: "SpaceXAI confirmation code: B10-CZJ"
    """
    if not content:
        return None

    m = re.search(
        r"confirmation code[:\s]+([A-Z0-9]{3}-[A-Z0-9]{3})",
        content,
        re.IGNORECASE,
    )
    if m:
        return m.group(1).upper()

    m = re.search(
        r"(?:verification code|验证码|your code|one-time code|code is)[:\s]*([A-Z0-9]{3}-[A-Z0-9]{3})",
        content,
        re.IGNORECASE,
    )
    if m:
        return m.group(1).upper()

    m = re.search(r"(?<![A-Z0-9-])([A-Z0-9]{3}-[A-Z0-9]{3})(?![A-Z0-9-])", content)
    if m:
        return m.group(1).upper()

    skip = {"177010", "181818", "666666", "808080", "000000"}
    for code in re.findall(r"(?<![&#\d])(\d{6})(?![&#\d])", content):
        if code not in skip:
            return code
    return None


def _open_imap() -> imaplib.IMAP4_SSL:
    _require_imap_config()
    mail = imaplib.IMAP4_SSL(_imap_host(), _imap_port())
    mail.login(_imap_user(), _imap_pass())
    return mail


def _select(mail: imaplib.IMAP4_SSL, box: str) -> bool:
    for name in (box, f'"{box}"'):
        try:
            st, _ = mail.select(name)
            if st == "OK":
                return True
        except Exception:
            continue
    return False


def _uid_search(mail: imaplib.IMAP4_SSL, criteria: str) -> List[bytes]:
    try:
        st, data = mail.uid("search", None, criteria)
        if st == "OK" and data and data[0]:
            return data[0].split()
    except Exception:
        pass
    return []


def _max_uid(mail: imaplib.IMAP4_SSL) -> int:
    """Highest UID currently in the selected mailbox (0 if empty)."""
    uids = _uid_search(mail, "ALL")
    if not uids:
        return 0
    try:
        return int(uids[-1])
    except (TypeError, ValueError):
        return 0


def _uid_fetch_headers(
    mail: imaplib.IMAP4_SSL, uid: bytes
) -> Optional[email_lib.message.Message]:
    """Header-only by UID — OTP lives in Subject."""
    try:
        st, data = mail.uid(
            "fetch",
            uid,
            "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE DELIVERED-TO X-ORIGINAL-TO)])",
        )
        if st != "OK" or not data:
            return None
        for part in data:
            if isinstance(part, tuple) and len(part) >= 2:
                raw = part[1]
                if isinstance(raw, (bytes, bytearray)):
                    return email_lib.message_from_bytes(bytes(raw))
        return None
    except Exception:
        return None


def _recipient_blob(msg: email_lib.message.Message) -> str:
    return " ".join(
        [
            msg.get("To", "") or "",
            msg.get("Delivered-To", "") or "",
            msg.get("X-Original-To", "") or "",
            msg.get("Cc", "") or "",
        ]
    ).lower()


def _code_from_msg(
    msg: email_lib.message.Message, target: str
) -> Optional[Tuple[str, str]]:
    if target not in _recipient_blob(msg):
        return None
    subj = _decode_header_value(msg.get("Subject", ""))
    code = extract_verification_code(subj)
    if code:
        return code, subj
    return None


def _find_code_for_alias(
    mail: imaplib.IMAP4_SSL,
    target: str,
    baseline_uid: int = 0,
) -> Optional[Tuple[str, str, bytes]]:
    """
    Find OTP for unique catch-all alias — cheap paths only:

    1) UID SEARCH (TO "alias")  — Gmail indexes To (~0.5s)
    2) UID SEARCH UID (baseline+1):* + header fetch of NEW mail only

    Never re-scan / re-fetch the whole x.ai history (was ~45s/poll).
    """
    # 1) Direct TO match (unique random alias → 0–1 hit)
    for crit in (f'(TO "{target}")', f"(TO {target})"):
        uids = _uid_search(mail, crit)
        if not uids:
            continue
        # Prefer mail that arrived after we started waiting
        ordered = sorted(uids, key=lambda u: int(u))
        prefer = [u for u in ordered if int(u) > baseline_uid] or ordered[-3:]
        for uid in reversed(prefer):
            msg = _uid_fetch_headers(mail, uid)
            if not msg:
                continue
            hit = _code_from_msg(msg, target)
            if hit:
                return hit[0], hit[1], uid

    # 2) Only messages newer than baseline watermark
    if baseline_uid > 0:
        raw = _uid_search(mail, f"UID {baseline_uid + 1}:*")
        new_uids = [u for u in raw if int(u) > baseline_uid]
    else:
        new_uids = _uid_search(mail, "ALL")[-5:]

    for uid in reversed(new_uids):
        msg = _uid_fetch_headers(mail, uid)
        if not msg:
            continue
        hit = _code_from_msg(msg, target)
        if hit:
            return hit[0], hit[1], uid
    return None


def wait_for_verification_code(target_email: str, timeout: int = 120) -> Optional[str]:
    """
    Fast poll (UID watermark + TO search):
    - one IMAP connection
    - snapshot max UID at start → only inspect newer mail
    - Gmail TO-search for unique alias (no full-inbox / no 20-header scan)
    - poll ~0.5s when idle
    """
    _require_imap_config()
    target = target_email.lower().strip()
    print(f"[IMAP] Waiting for OTP to {target_email} (timeout={timeout}s)...")
    print(f"[IMAP] {_imap_user()} @ {_imap_host()} — UID watermark + TO search")

    start = time.time()
    poll = 0
    mail = _open_imap()
    baseline_uid = 0

    try:
        if not _select(mail, "INBOX"):
            raise Exception("Cannot select INBOX")
        baseline_uid = _max_uid(mail)
        print(f"[IMAP] Connected  baseline_uid={baseline_uid}  poll≈0.5s")

        spam_checked = False

        while time.time() - start < timeout:
            poll += 1
            elapsed = int(time.time() - start)

            try:
                try:
                    # Cheap keep-alive; do not full-search on every tick
                    if poll == 1 or poll % 10 == 0:
                        mail.noop()
                except Exception:
                    try:
                        mail.logout()
                    except Exception:
                        pass
                    mail = _open_imap()
                    _select(mail, "INBOX")

                hit = _find_code_for_alias(mail, target, baseline_uid=baseline_uid)
                if hit:
                    code, subj, uid = hit
                    print(
                        f"[IMAP] Found OTP: {code} for {target_email} "
                        f"(Subj={subj!r}) in {elapsed}s"
                    )
                    try:
                        mail.uid("store", uid, "+FLAGS", "\\Seen")
                    except Exception:
                        pass
                    return code

                # One-time Spam peek if still empty after 15s
                if not spam_checked and elapsed >= 15:
                    spam_checked = True
                    for spam_box in ("[Gmail]/Spam", "[Gmail]/Junk"):
                        if not _select(mail, spam_box):
                            continue
                        spam_base = _max_uid(mail)
                        # Spam may already hold the mail — search TO without watermark
                        hit = _find_code_for_alias(mail, target, baseline_uid=0)
                        _select(mail, "INBOX")
                        if hit:
                            code, subj, uid = hit
                            print(
                                f"[IMAP] Found OTP in Spam: {code} "
                                f"(Subj={subj!r}) in {elapsed}s"
                            )
                            return code
                        break

                if poll == 1 or poll % 10 == 0:
                    print(f"[IMAP] waiting... {elapsed}s/{timeout}s")

            except Exception as e:
                print(f"[IMAP] Error: {e}")
                try:
                    mail.logout()
                except Exception:
                    pass
                time.sleep(0.5)
                try:
                    mail = _open_imap()
                    _select(mail, "INBOX")
                except Exception as e2:
                    print(f"[IMAP] Reconnect failed: {e2}")

            time.sleep(0.5)

    finally:
        try:
            mail.logout()
        except Exception:
            pass

    print(f"[IMAP] Timeout waiting for OTP to {target_email}")
    return None
