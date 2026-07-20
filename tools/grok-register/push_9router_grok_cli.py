"""
Hand Build OAuth tokens to 9router as a grok-cli connection.

Modes (env NINEROUTER_IMPORT_MODE):
  direct  — print a machine line for the parent 9router process to import
            via createProviderConnection (no HTTP). Default when launched
            from Add Account automation.
  http    — POST /api/providers (standalone CLI / external farm). Fallback.

Always prints @@GROK_CLI_IMPORT@@...@@ so 9router can import even if HTTP is off.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from sso_to_build import BuildTokens

DEFAULT_BASE = "http://127.0.0.1:20127"
IMPORT_MARKER = "@@GROK_CLI_IMPORT@@"

# Cache dashboard session cookie per base_url (password auth)
_session_cache: Dict[str, str] = {}


def _compute_cli_token(data_dir: Optional[str] = None) -> Optional[str]:
    base = Path(os.path.expanduser(data_dir or "~/.9router"))
    mid = base / "machine-id"
    secret = base / "auth" / "cli-secret"
    if not mid.is_file() or not secret.is_file():
        return None
    raw = mid.read_text(encoding="utf-8").strip()
    sec = secret.read_text(encoding="utf-8").strip()
    if not raw or not sec:
        return None
    return hashlib.sha256(f"{raw}9r-cli-auth{sec}".encode()).hexdigest()[:16]


def _display_from_id_token(id_token: str) -> str:
    try:
        import base64

        parts = id_token.split(".")
        pad = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(pad))
        given = (claims.get("given_name") or "").strip()
        family = (claims.get("family_name") or "").strip()
        return f"{given} {family}".strip()
    except Exception:
        return ""


def build_import_payload(
    tokens: BuildTokens,
    *,
    name: str = "",
    email: str = "",
    display_name: str = "",
) -> Dict[str, Any]:
    email = (email or tokens.email or "").strip()
    name = (name or tokens.name or email or tokens.user_id or "Grok CLI").strip()
    display_name = (display_name or "").strip()
    if not display_name and tokens.id_token:
        display_name = _display_from_id_token(tokens.id_token)
    if not display_name:
        display_name = name

    return {
        "provider": "grok-cli",
        "accessToken": tokens.access_token,
        "refreshToken": tokens.refresh_token or None,
        "idToken": tokens.id_token or None,
        "expiresIn": tokens.expires_in,
        "expiresAt": tokens.expires_at,
        "scope": tokens.scope,
        "email": email or tokens.email or None,
        "name": name,
        "displayName": display_name,
        "userId": tokens.user_id or None,
    }


def emit_import_marker(payload: Dict[str, Any]) -> None:
    """Single-line marker for 9router GrokRegisterRunner to parse (stdout)."""
    line = f"{IMPORT_MARKER}{json.dumps(payload, separators=(',', ':'))}{IMPORT_MARKER}"
    print(line, flush=True)


def _jwt_payload(token: str) -> Dict[str, Any]:
    parts = str(token or "").split(".")
    if len(parts) < 2:
        return {}
    try:
        import base64

        pad = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(pad))
    except Exception:
        return {}


def access_token_bot_flagged(access_token: str) -> bool:
    """True if xAI stamped bot_flag_source on this Build/CLI access token."""
    if os.environ.get("GROK_IMPORT_ALLOW_BOT_FLAG", "").strip() in ("1", "true", "yes"):
        return False
    claims = _jwt_payload(access_token)
    flag = claims.get("bot_flag_source")
    if flag is None or flag is False or flag == 0 or flag == "0":
        return False
    return True


def _login_dashboard(base_url: str, password: str) -> str:
    """Dashboard password login → Cookie header auth_token=..."""
    import requests

    base = base_url.rstrip("/")
    if base in _session_cache:
        return _session_cache[base]

    resp = requests.post(
        f"{base}/api/auth/login",
        json={"password": password},
        timeout=20,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(
            f"9router login HTTP {resp.status_code}: {resp.text[:200]}"
        )

    cookie_header = None
    for c in resp.cookies:
        if c.name == "auth_token":
            cookie_header = f"auth_token={c.value}"
            break
    if not cookie_header:
        raw = resp.headers.get("Set-Cookie") or ""
        for part in raw.split(","):
            part = part.strip()
            if part.lower().startswith("auth_token="):
                cookie_header = part.split(";", 1)[0].strip()
                break
    if not cookie_header:
        raise RuntimeError(
            "9router login OK but auth_token cookie missing "
            "(check Set-Cookie / SameSite on remote)"
        )

    _session_cache[base] = cookie_header
    print("[*] 9router login OK (session cookie cached)")
    return cookie_header


def push_build_tokens_to_9router(
    tokens: BuildTokens,
    *,
    base_url: str = DEFAULT_BASE,
    data_dir: Optional[str] = None,
    cli_token: Optional[str] = None,
    password: Optional[str] = None,
    name: str = "",
    email: str = "",
    display_name: str = "",
) -> Dict[str, Any]:
    """
    Prefer direct mode when embedded in 9router (NINEROUTER_IMPORT_MODE=direct).
    Otherwise HTTP POST /api/providers for standalone CLI use.

    Auth for HTTP (priority):
      1. password / NINEROUTER_PASSWORD (dashboard login → Cookie)
      2. cli_token / ~/.9router CLI token
    """
    payload = build_import_payload(
        tokens, name=name, email=email, display_name=display_name
    )

    # bot_flag_source only appears on OAuth access tokens (after device convert),
    # not on Web SSO cookies. Skip import so flagged accounts never hit providers.
    if access_token_bot_flagged(tokens.access_token or ""):
        claims = _jwt_payload(tokens.access_token or "")
        flag = claims.get("bot_flag_source")
        email_s = payload.get("email") or email or "?"
        msg = (
            f"skip import: bot_flag_source={flag} email={email_s} "
            f"(xAI bot-flagged — chat usually 403). "
            f"SSO kept on disk; not pushed to 9router. "
            f"Set GROK_IMPORT_ALLOW_BOT_FLAG=1 to force."
        )
        print(f"[*] {msg}", flush=True)
        raise RuntimeError(msg)

    # Always emit for in-process parent (9router Add Account runner)
    emit_import_marker(payload)

    mode = (os.environ.get("NINEROUTER_IMPORT_MODE") or "http").strip().lower()
    if mode in ("direct", "inprocess", "local", "none", "skip-http"):
        print(
            f"[*] Import mode={mode}: tokens emitted for 9router in-process save "
            f"(no HTTP) name={payload.get('name')} email={payload.get('email')}"
        )
        return {
            "id": "",
            "mode": "direct",
            "name": payload.get("name"),
            "email": payload.get("email"),
        }

    # --- HTTP fallback (external / standalone) ---
    try:
        import requests
    except ImportError as e:
        raise RuntimeError("requests required for HTTP import mode") from e

    base = (base_url or DEFAULT_BASE).rstrip("/")
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    auth_mode = "none"

    pwd = (password or os.environ.get("NINEROUTER_PASSWORD") or "").strip()
    if pwd:
        cookie = _login_dashboard(base, pwd)
        headers["Cookie"] = cookie
        auth_mode = "password-cookie"
    else:
        token = (cli_token or "").strip() or _compute_cli_token(data_dir)
        if token:
            headers["x-9r-cli-token"] = token
            auth_mode = "cli-token"
        else:
            raise RuntimeError(
                "No 9router auth: set grok_cli.password (dashboard password) "
                "for remote URL, or ensure ~/.9router CLI token for localhost. "
                "When running inside 9router Add Account, set NINEROUTER_IMPORT_MODE=direct."
            )

    url = f"{base}/api/providers"
    print(
        f"[*] 9router POST {url} auth={auth_mode} "
        f"name={payload.get('name')} email={payload.get('email')}"
    )
    resp = requests.post(url, headers=headers, json=payload, timeout=45)

    if resp.status_code == 401 and pwd:
        _session_cache.pop(base, None)
        headers["Cookie"] = _login_dashboard(base, pwd)
        resp = requests.post(url, headers=headers, json=payload, timeout=45)

    if resp.status_code not in (200, 201):
        raise RuntimeError(
            f"9router grok-cli import HTTP {resp.status_code}: {resp.text[:300]}"
        )

    data = resp.json() if resp.content else {}
    conn = data.get("connection") or data or {}
    conn_id = conn.get("id") or ""
    print(f"[*] 9router grok-cli imported via HTTP id={conn_id}")
    return {
        "id": conn_id,
        "mode": "http",
        "name": conn.get("name") or payload.get("name"),
        "email": conn.get("email") or payload.get("email"),
        "raw": data,
    }
