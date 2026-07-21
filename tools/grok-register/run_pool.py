"""Shim: standalone name → bundled pool.py (9router tools/grok-register)."""
from pool import *  # noqa: F403

if __name__ == "__main__":
    raise SystemExit(main())  # noqa: F405
