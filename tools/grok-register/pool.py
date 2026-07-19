#!/usr/bin/env python3
"""
Concurrent Grok farm pool.

Clear semantics:
  --count N       total accounts to create
  --concurrent K  how many browsers in parallel

Example:
  python run_pool.py --count 100 --concurrent 3
  → 100 accounts split across 3 workers (34 + 33 + 33)

Also:
  python run_pool.py -n 10 -c 2 --offscreen
  python run_pool.py --dry-run -n 100 -c 3
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "farm.py"
CONFIG_PATH = ROOT / "config.json"


def load_pool_config() -> dict:
    defaults = {
        "count": 1,          # TOTAL accounts
        "concurrent": 2,     # parallel browsers
        "stagger_sec": 20,
        "proxies": [],
        "display": "offscreen" if sys.platform == "darwin" else "headed",
    }
    if not CONFIG_PATH.is_file():
        return defaults
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as f:
            conf = json.load(f)
        pool = conf.get("pool") or {}
        if not isinstance(pool, dict):
            return defaults
        out = dict(defaults)

        # New keys
        if isinstance(pool.get("count"), int) and pool["count"] >= 0:
            out["count"] = pool["count"]
        if isinstance(pool.get("concurrent"), int) and pool["concurrent"] >= 1:
            out["concurrent"] = pool["concurrent"]
        # Backward compat: pool.workers → concurrent
        elif isinstance(pool.get("workers"), int) and pool["workers"] >= 1:
            out["concurrent"] = pool["workers"]

        if isinstance(pool.get("stagger_sec"), (int, float)) and pool["stagger_sec"] >= 0:
            out["stagger_sec"] = float(pool["stagger_sec"])

        proxies = pool.get("proxies") or pool.get("proxy_list") or []
        if isinstance(proxies, list):
            out["proxies"] = [str(p).strip() for p in proxies if str(p).strip()]
        if not out["proxies"]:
            single = str(conf.get("browser_proxy") or conf.get("proxy") or "").strip()
            if single:
                out["proxies"] = [single]

        display = (
            pool.get("display")
            or (conf.get("run") or {}).get("display")
            or conf.get("display")
        )
        if isinstance(display, str) and display.strip():
            d = display.strip().lower()
            if d in ("bg", "background", "minimized", "minimise", "minimize"):
                d = "offscreen"
            if d in ("headed", "offscreen", "headless"):
                out["display"] = d
        return out
    except Exception as e:
        print(f"[Warn] config pool: {e}")
        return defaults


def load_proxy_file(path: str) -> list[str]:
    p = Path(path).expanduser()
    if not p.is_file():
        raise SystemExit(f"proxy file not found: {p}")
    lines = []
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        lines.append(s)
    return lines


def split_workload(total: int, concurrent: int) -> list[int]:
    """
    Split `total` accounts across `concurrent` workers as evenly as possible.

    Examples:
      100, 3 → [34, 33, 33]
      10, 3  → [4, 3, 3]
      2, 5   → [1, 1]   (only 2 workers needed)
      0, 3   → [0, 0, 0]  (0 = infinite per worker)
    """
    if concurrent < 1:
        raise ValueError("concurrent must be >= 1")
    if total == 0:
        # Infinite mode: every worker runs forever
        return [0] * concurrent
    if total < 0:
        raise ValueError("count must be >= 0")
    # No empty workers
    n = min(concurrent, total)
    base, extra = divmod(total, n)
    return [base + (1 if i < extra else 0) for i in range(n)]


def platform_is_mac() -> bool:
    return sys.platform == "darwin"


def _mask_proxy(url: str) -> str:
    if not url or "@" not in url:
        return url
    try:
        left, right = url.rsplit("@", 1)
        if "://" in left:
            scheme, creds = left.split("://", 1)
            if ":" in creds:
                user = creds.split(":", 1)[0]
                return f"{scheme}://{user}:***@{right}"
        return f"***@{right}"
    except Exception:
        return "***"


def main() -> int:
    cfg = load_pool_config()

    parser = argparse.ArgumentParser(
        description=(
            "Grok farm pool — total accounts + concurrency.\n"
            "Example: python run_pool.py --count 100 --concurrent 3"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "-n",
        "--count",
        type=int,
        default=cfg["count"],
        help=f"TOTAL accounts to create (default {cfg['count']}; 0 = infinite per worker)",
    )
    parser.add_argument(
        "-c",
        "--concurrent",
        type=int,
        default=cfg["concurrent"],
        dest="concurrent",
        help=f"how many browsers in parallel (default {cfg['concurrent']})",
    )
    # Alias kept so old scripts don't break
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help=argparse.SUPPRESS,  # hidden alias for --concurrent
    )
    parser.add_argument(
        "--stagger",
        type=float,
        default=cfg["stagger_sec"],
        dest="stagger_sec",
        help=f"seconds between starting each worker (default {cfg['stagger_sec']})",
    )
    parser.add_argument(
        "--proxy-file",
        default="",
        help="text file: one proxy URL per line",
    )
    parser.add_argument(
        "--proxy",
        action="append",
        default=[],
        help="proxy URL (repeatable); round-robin to workers",
    )
    parser.add_argument(
        "--display",
        choices=["headed", "offscreen", "headless"],
        default=cfg.get("display") or ("offscreen" if platform_is_mac() else "headed"),
        help="headed | offscreen | headless",
    )
    parser.add_argument("--headless", action="store_true", help="shortcut → headless")
    parser.add_argument("--offscreen", action="store_true", help="shortcut → offscreen")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print split plan only, do not start browsers",
    )
    parser.add_argument(
        "--tui",
        action="store_true",
        help="launch live Terminal UI dashboard (farm_tui.py) instead of raw logs",
    )
    args = parser.parse_args()

    if args.tui:
        # Hand off to farm_tui with the same CLI flags (minus --tui)
        from farm_tui import run_tui

        # rebuild namespace without dry-run side effects
        return run_tui(args)

    concurrent = args.workers if args.workers is not None else args.concurrent
    total = args.count

    if concurrent < 1:
        raise SystemExit("--concurrent must be >= 1")
    if total < 0:
        raise SystemExit("--count must be >= 0")

    shares = split_workload(total, concurrent)
    n_workers = len(shares)

    if concurrent > 5 and platform_is_mac():
        print(
            f"[Warn] concurrent={concurrent} on macOS is aggressive; "
            "try 2–3 first."
        )

    display = "headless" if args.headless else ("offscreen" if args.offscreen else args.display)
    if display in ("bg", "background"):
        display = "offscreen"

    proxies = list(args.proxy) if args.proxy else list(cfg["proxies"])
    if args.proxy_file:
        proxies = load_proxy_file(args.proxy_file)

    if not SCRIPT.is_file():
        raise SystemExit(f"missing farm script: {SCRIPT}")

    python = sys.executable
    print("=" * 60)
    print("Grok farm pool")
    print(f"  python     : {python}")
    print(f"  total      : {total if total > 0 else '∞ (infinite)'}")
    print(f"  concurrent : {n_workers}")
    print(f"  split      : {shares}  (sum={sum(shares) if total > 0 else '∞'})")
    print(f"  stagger    : {args.stagger_sec}s")
    print(f"  display    : {display}")
    print(f"  proxies    : {len(proxies)} configured")
    print("-" * 60)
    print("  log tag   : [W2 3/33 · #70/100 · remW 30 · ✓2 ✗0]")
    print("              W=worker local/share  #=global index")
    print("              remW=sisa di worker ini  ✓/✗ = ok/fail worker")
    print("  phases    : START → FLOW ①..⑥ → OK/FAIL → SCORE")
    if display == "headed" and platform_is_mac():
        print("  [!] headed on Mac steals focus — prefer --offscreen while working")
    if display == "headless":
        print("  [!] headless: Turnstile may fail more; try --offscreen if stuck")
    if not proxies and n_workers > 1:
        print(
            "  [!] no proxies — all workers share your home IP. "
            "OK for a tiny test; add pool.proxies or --proxy for safer concurrent."
        )
    print("=" * 60)

    procs: list[subprocess.Popen] = []

    def _shutdown(signum=None, frame=None):
        print("\n[pool] stopping workers...")
        for p in procs:
            if p.poll() is None:
                p.terminate()
        deadline = time.time() + 8
        for p in procs:
            while p.poll() is None and time.time() < deadline:
                time.sleep(0.2)
            if p.poll() is None:
                p.kill()
        sys.exit(130 if signum else 0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    # Cumulative offsets so each worker can log global account index
    offsets: list[int] = []
    running_offset = 0
    for share in shares:
        offsets.append(running_offset)
        running_offset += share if total > 0 else 0

    for i, share in enumerate(shares):
        wid = str(i + 1)
        proxy = proxies[i % len(proxies)] if proxies else ""
        debug_port = 9300 + int(wid) * 20
        env = os.environ.copy()
        env["GROK_WORKER_ID"] = wid
        env["GROK_DEBUG_PORT"] = str(debug_port)
        env["GROK_DISPLAY"] = display
        env["GROK_WORKER_SHARE"] = str(share)
        env["GROK_POOL_TOTAL"] = str(total if total > 0 else 0)
        env["GROK_POOL_OFFSET"] = str(offsets[i])
        if proxy:
            env["GROK_BROWSER_PROXY"] = proxy
        else:
            env.pop("GROK_BROWSER_PROXY", None)
            env.pop("BROWSER_PROXY", None)

        # Each worker gets its slice of the total (--count for child = accounts THIS worker runs)
        cmd = [
            python,
            str(SCRIPT),
            "--count",
            str(share),
            "--worker-id",
            wid,
            "--display",
            display,
        ]
        g_from = offsets[i] + 1 if total > 0 else 0
        g_to = offsets[i] + share if total > 0 else 0
        print(
            f"[pool] worker {wid}/{n_workers}: {share} account(s)"
            + (f"  global#{g_from}–{g_to}" if total > 0 else "")
            + f"  cdp≈{debug_port}"
            + (f"  proxy={_mask_proxy(proxy)}" if proxy else "  proxy=(none)")
        )
        if args.dry_run:
            print(f"       cmd: {' '.join(cmd)}")
        else:
            env.setdefault("PYTHONUNBUFFERED", "1")
            procs.append(
                subprocess.Popen(
                    cmd,
                    cwd=str(ROOT),
                    env=env,
                )
            )

        if i + 1 < n_workers and args.stagger_sec > 0:
            print(f"[pool] stagger sleep {args.stagger_sec}s ...")
            if not args.dry_run:
                time.sleep(args.stagger_sec)

    if args.dry_run:
        print("[pool] dry-run done")
        return 0

    print(f"[pool] {len(procs)} workers running — Ctrl+C to stop all")
    codes = [p.wait() for p in procs]
    ok = sum(1 for c in codes if c == 0)
    print(f"[pool] done: {ok}/{len(codes)} workers exit 0  codes={codes}")
    return 0 if all(c == 0 for c in codes) else 1


if __name__ == "__main__":
    raise SystemExit(main())
