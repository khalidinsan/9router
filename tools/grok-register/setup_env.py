#!/usr/bin/env python3
"""
One-shot environment setup for Grok CLI register (used by 9router Add Account).

Creates .venv, installs requirements, Playwright Chromium, and Camoufox browser.
Safe to re-run (idempotent). Flash-aligned with standalone grok-register.
"""

from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
REQ = ROOT / "requirements.txt"
CFG_EXAMPLE = ROOT / "config.example.json"
CFG = ROOT / "config.json"


def log(msg: str) -> None:
    print(msg, flush=True)


def venv_python() -> Path:
    if platform.system() == "Windows":
        return VENV / "Scripts" / "python.exe"
    return VENV / "bin" / "python"


def run(cmd: list[str], **kwargs) -> None:
    log(f"$ {' '.join(cmd)}")
    subprocess.check_call(cmd, cwd=str(ROOT), **kwargs)


def main() -> int:
    log("=== Grok Register environment setup (flash-aligned) ===")
    log(f"root: {ROOT}")
    log(f"system python: {sys.executable} ({sys.version.split()[0]})")

    if sys.version_info < (3, 10):
        log("ERROR: Python 3.10+ is required.")
        return 1

    if not VENV.exists():
        log("Creating virtualenv (.venv)...")
        run([sys.executable, "-m", "venv", str(VENV)])
    else:
        log("Virtualenv already exists.")

    py = venv_python()
    if not py.is_file():
        log(f"ERROR: venv python missing at {py}")
        return 1

    log("Upgrading pip...")
    run([str(py), "-m", "pip", "install", "--upgrade", "pip", "wheel", "setuptools"])

    if not REQ.is_file():
        log(f"ERROR: missing {REQ}")
        return 1

    log("Installing Python dependencies...")
    run([str(py), "-m", "pip", "install", "-r", str(REQ)])

    log("Installing Playwright Chromium (fallback engine)...")
    try:
        run([str(py), "-m", "playwright", "install", "chromium"])
    except subprocess.CalledProcessError as e:
        log(f"WARN: playwright chromium install failed: {e}")

    # Linux deps for chromium (best-effort)
    if platform.system() == "Linux":
        try:
            run([str(py), "-m", "playwright", "install-deps", "chromium"])
        except subprocess.CalledProcessError:
            log("WARN: playwright install-deps failed (may need sudo). Continue.")

    log("Fetching Camoufox browser (flash default engine)...")
    try:
        run([str(py), "-m", "camoufox", "fetch"])
    except subprocess.CalledProcessError as e:
        log(
            f"WARN: camoufox fetch failed ({e}). "
            "Retry later: .venv/bin/python -m camoufox fetch"
        )

    if not CFG.is_file() and CFG_EXAMPLE.is_file():
        shutil.copy(CFG_EXAMPLE, CFG)
        log("Created config.json from example — edit IMAP + enable grok_cli.")
    elif CFG.is_file():
        log("config.json already present (kept — not overwritten).")

    # Smoke imports
    log("Verifying imports...")
    run(
        [
            str(py),
            "-c",
            (
                "import DrissionPage, playwright, requests, textual; "
                "import camoufox; "
                "from browser_engine import resolve_display, resolve_engine; "
                "from chat_usable import probe_chat_usable; "
                "print('imports OK', 'engine', resolve_engine(), "
                "'display', resolve_display())"
            ),
        ]
    )

    log("=== Setup complete ===")
    log(f"venv python: {py}")
    log("Defaults: Camoufox + headless (Linux/Win) / offscreen (Mac)")
    log("Next: set email.* and grok_cli in config.json (or 9router Settings),")
    log("      then use 9router Add Account → Grok CLI.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
