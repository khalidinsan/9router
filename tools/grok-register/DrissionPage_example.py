"""Shim: standalone name → bundled farm.py (9router tools/grok-register)."""
from farm import *  # noqa: F403

if __name__ == "__main__":
    raise SystemExit(main())  # noqa: F405
