# Grok CLI Register (bundled farm)

Python farm used by **9router → Dashboard → Add Account → Grok CLI (Register)**.

Synced 1:1 with standalone [grok-register](https://github.com/khalidinsan/grok-register) (flash-aligned):

- **Camoufox** default engine + Chromium fallback
- **PKCE OAuth** (`referrer=grok-build`) → chat **usable** probe → inject only USABLE
- **Headless** default on Linux/Windows · **offscreen** on macOS · optional `virtual`/Xvfb
- Proxy pool + health check · humanized catch-all emails · multi-worker TUI

You normally **do not** run this manually. Open 9router and use **Setup environment** / **Run Grok Register** in the UI.

## What it does

1. Creates humanized catch-all emails + registers on `accounts.x.ai` (Camoufox)
2. Reads OTP via Gmail IMAP
3. Settle → browser **PKCE** OAuth (`grok-build`) → chat usable probe
4. Imports into 9router as provider `grok-cli` (direct marker when launched from UI)

## One-time setup (if UI Setup fails)

```bash
cd tools/grok-register
python3 setup_env.py
# installs: requirements, Playwright Chromium, Camoufox browser
# creates config.json from example if missing
```

Edit IMAP + `grok_cli` in `config.json`, **or** fill them on the 9router Add Account page (preferred).

## Manual CLI (optional)

```bash
# Farm (same flags as standalone)
.venv/bin/python pool.py -n 20 -c 2 --stagger 5 --offscreen   # Mac
.venv/bin/python pool.py -n 20 -c 2 --headless                # Linux/VPS
.venv/bin/python pool.py -u -c 2 --headless                   # unlimited

# TUI dashboard
.venv/bin/python farm_tui.py -u -c 2 --offscreen
# or:
.venv/bin/python pool.py --tui -n 20 -c 3 --offscreen

# Linux helper (auto xvfb when needed)
./run_linux.sh pool.py -u -c 2
```

## Display / engine (flash-aligned)

| Platform | Default display | Default engine |
|----------|-----------------|----------------|
| Linux / VPS | `headless` | `camoufox` |
| Windows | `headless` | `camoufox` |
| macOS | `offscreen` | `camoufox` |

```bash
--headless | --virtual | --offscreen | --headed
export GROK_HEADLESS=true
export GROK_BROWSER_ENGINE=camoufox
```

## Config

See `config.example.json`. Important:

- `email.*` — catch-all domain + Gmail app password (`local_style: human`)
- `browser.engine` — `camoufox` (default) | `chromium`
- `grok_cli.enabled: true`
- `grok_cli.oauth_mode: pkce` + `inject_policy: usable`
- From UI: `NINEROUTER_IMPORT_MODE=direct` (set by runner; marker import)

## File map (standalone ↔ bundled)

| Standalone | Bundled |
|------------|---------|
| `DrissionPage_example.py` | `farm.py` (+ shim) |
| `run_pool.py` | `pool.py` (+ shim) |
| `email_register.py` | `email_imap.py` (+ shim) |
| — | `setup_env.py` (9router UI only) |
