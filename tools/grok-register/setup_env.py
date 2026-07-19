#!/usr/bin/env python3
"""
One-shot environment setup for Grok CLI register (used by 9router Add Account).

Creates .venv, installs requirements, installs Playwright Chromium.
Safe to re-run (idempotent).
"""

from __future__ import annotations

import os
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
    log("=== Grok Register environment setup ===")
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
    run([str(py), "-m", "pip", "install", "--upgrade", "pip"], stdout=subprocess.DEVNULL)

    if not REQ.is_file():
        log(f"ERROR: missing {REQ}")
        return 1

    log("Installing Python dependencies...")
    run([str(py), "-m", "pip", "install", "-r", str(REQ)])

    log("Installing Playwright Chromium (browser for farm — not your daily Chrome)...")
    run([str(py), "-m", "playwright", "install", "chromium"])

    # Linux deps for chromium (best-effort)
    if platform.system() == "Linux":
        try:
            run([str(py), "-m", "playwright", "install-deps", "chromium"])
        except subprocess.CalledProcessError:
            log("WARN: playwright install-deps failed (may need sudo). Continue.")

    if not CFG.is_file() and CFG_EXAMPLE.is_file():
        shutil.copy(CFG_EXAMPLE, CFG)
        log(f"Created config.json from example — edit IMAP + enable grok_cli.")
    elif CFG.is_file():
        log("config.json already present.")

    # Smoke imports
    log("Verifying imports...")
    run(
        [
            str(py),
            "-c",
            "import DrissionPage; import playwright; print('imports OK')",
        ]
    )

    log("=== Setup complete ===")
    log(f"venv python: {py}")
    log("Next: set email.* and grok_cli in config.json, then use 9router Add Account → Grok CLI.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
