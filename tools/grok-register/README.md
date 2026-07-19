# Grok CLI Register (bundled farm)

Python farm used by **9router → Dashboard → Add Account → Grok CLI (Register)**.

You normally **do not** run this manually. Open 9router and use **Setup environment** / **Run Grok Register** in the UI.

## What it does

1. Creates catch-all emails + registers on x.ai (Playwright Chromium)
2. Reads OTP via Gmail IMAP
3. Converts SSO → Grok Build OAuth
4. Imports into 9router as provider `grok-cli`

## One-time setup (if UI Setup fails)

```bash
cd tools/grok-register

# Farm (same flags as standalone grok-register)
.venv/bin/python pool.py -n 20 -c 3 --stagger 5 --offscreen

# Optional terminal dashboard
.venv/bin/python pool.py --tui -n 20 -c 3 --offscreen
# or:
.venv/bin/python farm_tui.py -n 20 -c 3 --offscreen
# Use system Python 3.10–3.13
python3 setup_env.py
# Edit config
cp config.example.json config.json   # if not created
# fill email.domain, imap_user, imap_pass, grok_cli.base_url
```

## Manual CLI (optional)

```bash
.venv/bin/python pool.py -n 10 -c 2 --offscreen
```

## Config

See `config.example.json`. Important:

- `email.*` — catch-all domain + Gmail app password
- `grok_cli.enabled: true` + `base_url: http://127.0.0.1:20127`
