# Upstream Sync — Agent Instructions

This repository is a **fork** of [`decolua/9router`](https://github.com/decolua/9router).
Periodically the upstream releases a new version (e.g. `v0.5.59`) and we must
merge it in, review conflicts together with the user, build, and deploy. This
document is the complete playbook — follow it exactly when a new upstream
version arrives.

---

## 0. Ground rules (read first)

- **The user decides on every conflict.** NEVER auto-resolve and commit a
  conflict without presenting the analysis: what local (fork) has, what
  upstream has, why they collide, and your recommendation. The user makes the
  final call for each conflict.
- **Chat API for Antigravity must stay `antigravity/cli/1.1.22`** (the CLI
  fingerprint). Do NOT switch the chat request User-Agent to the IDE one
  (`antigravity/ide/2.1.1`). The IDE UA is used ONLY by the web-search feature
  (`/v1/search` via `chatSearch.js`) — never for chat. Google rejects old CLI
  versions (403/404), and switching chat to IDE is a regression.
- **Never touch these while syncing** unless a conflict explicitly demands a
  decision: our local bug fixes must survive the merge:
  - `open-sse/executors/antigravity.js` — `project: "aicode-consumers"`
    fallback, UA `1.1.22`, empty-parts history drop (400 fix), terminal SSE
    normalization (ResponseAborted fix).
  - `open-sse/providers/registry/antigravity.js` — CLI UA in transport headers.
- Work happens on a dedicated branch (`sync-v<version>`), never directly on
  `master`. After the user tests manually and approves, merge to master.

---

## 1. Recon (read-only, nothing changes)

```bash
git remote -v                      # expect: origin = khalidinsan/9router, upstream = decolua/9router
git status -sb                     # must be clean before starting
git log --oneline -1               # current HEAD
git branch -a                      # see existing sync branches
git tag -l 'v0.5.*' | sort -V | tail -5   # local known versions
```

Fetch upstream (updates `refs/remotes/upstream/*` + tags):

```bash
git fetch upstream
```

Then measure the divergence:

```bash
git merge-base upstream/master HEAD          # last common ancestor (last synced version)
git log --oneline <merge-base>..upstream/master   # commits upstream added since our sync
git rev-list --left-right --count upstream/master...HEAD   # behind / ahead
```

Report to the user:
- last synced version (the merge-base is usually a `# v0.5.XX` commit),
- how many upstream commits are new,
- which upstream commits touch files we also changed (those will conflict).

## 2. Prepare the sync branch

The user's preference: **delete the old sync branch, create a fresh one named
after the upstream version.**

```bash
# delete old branch (local + remote) — only after user approval
git branch -D <old-sync-branch>
git push origin --delete <old-sync-branch>

# create new branch from master
git checkout -b sync-v0.5.59      # or whatever the version is
```

## 3. Merge upstream

```bash
git merge upstream/master
```

Expect conflicts. Run:

```bash
git status --short | grep '^UU'
git log --oneline <merge-base>..upstream/master -- <conflicted-file>   # which upstream commits touched it
```

## 4. Conflict analysis — present before resolving

For each conflict, present: **local vs upstream vs why + recommendation**.
Classification used in v0.5.59 sync:

| Type | Meaning | Example |
|---|---|---|
| ✅ take upstream | our side is dead/empty/superseded | `opencode.js` empty `MESSAGES_MODELS`, upstream `RESPONSES_MODELS`; golden snapshot deleted by upstream |
| 📝 combine (`@both`) | both sides add different things | new imports, new providers, new usage handlers |
| 🤔 manual merge | both rewrite the same logic; must hand-merge | `chat.js` / `auth.js` fallback logic; `BaseUrlSelect.js` state/effects |

**Tooling:** conflict blocks can be resolved via `write({ path: "conflict://<N>", content })`
with `@ours` / `@theirs` / `@both` shorthand. For manual merges, read both
sides (ours = HEAD, theirs = upstream/master), then rewrite the file.

**Careful with `@both` on the same lines** — it concatenates and can produce
duplicate declarations (`const shouldFallback` twice in `chat.js`, duplicate
imports in `registry/index.js`, duplicated `const lockedConns` in `auth.js`).
After any `@both`, verify with `node --check` and fix duplicates manually.

**Registry numbering:** `open-sse/providers/registry/index.js` imports are
numbered (`p120`, `p121`, …). When both sides add providers, renumber the new
ones to free slots (e.g. upstream `xquik` → `p126`) and keep both lists. Never
leave two `import pNNN` lines with the same number.

## 5. Known conflict patterns (from v0.5.59)

- **CHANGELOG.md** — keep our `# Unreleased` section on top, add upstream's
  `# v0.5.XX` section below; strip markers only.
- **`open-sse/executors/antigravity.js`** — combine import lines; upstream adds
  `ANTIGRAVITY_PROMPT_REWRITES`, we add `INTERNAL_REQUEST_HEADER`. Both are
  needed. Chat UA stays CLI.
- **`open-sse/handlers/search/chatSearch.js`** — upstream adds an
  `antigravity` web-search entry using `ANTIGRAVITY_IDE_USER_AGENT`. This is
  INTENTIONAL: search uses the IDE fingerprint, chat does not. Keep it.
- **`src/sse/handlers/chat.js` / `src/sse/services/auth.js`** — upstream adds
  antigravity quota-aware routing; we have grok-cli safety + pinned-request
  logic. Merge both: quota cache filter + grok-cli hard-block filter coexist in
  the same `availableConnections` filter; the antigravity 409/429 branch uses
  `handleAntigravityQuotaError` and skips persisting a model lock.
- **`tests/translator/__snapshots__/golden-url-header.test.js.snap`** —
  upstream deleted it deliberately (it drifted). Follow upstream: `git rm`.
- **New provider files** (e.g. `xquik.js`, `ollama-search.js`) — accept; then
  wire them into `registry/index.js` imports + array with a fresh number.

## 6. Verify the merge (before committing)

```bash
# no leftover markers
grep -rn "<<<<<<< HEAD\|>>>>>>> upstream/master" --include="*.js" --include="*.md" open-sse/ src/ tests/ || true

# syntax-check every conflicted file
node --check <file>            # for each file that had conflicts

# registry numbering sanity
grep -n "^import p" open-sse/providers/registry/index.js   # no duplicate numbers
```

## 7. Commit the merge, build, deploy

```bash
git add -A
git commit -m "merge: sync with upstream v<version>"
git push -u origin sync-v<version>
```

Build (user expects `build:prod`):

```bash
npm run build:prod
```

**If the build fails** (e.g. `ANTIGRAVITY_IDE_BASE_URL is not defined`):
find the missing import, add it, commit separately
(`fix(antigravity): import shared …`), push. In v0.5.59 the registry's new
`searchViaChat` block referenced `ANTIGRAVITY_IDE_BASE_URL` from
`open-sse/providers/shared.js` — the import was missing after the merge.

Deploy — the server runs under a **LaunchAgent** (`com.9router`), NOT a plain
process:

```bash
# reload plist changes (env vars) — kickstart alone does NOT reload the plist
launchctl bootout gui/$(id -u)/com.9router
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.9router.plist
# or, when only restarting with an unchanged plist:
launchctl kickstart -k gui/$(id -u)/com.9router

# verify
lsof -nP -iTCP:20127 -sTCP:LISTEN        # expect *:20127 (LAN bind via NINEROUTER_BIND_HOST=0.0.0.0)
tail -5 ~/Library/Logs/9router.log
```

## 8. Smoke test (never skip)

```bash
# chat through the live server (Antigravity CLI UA must be used)
curl -s http://127.0.0.1:20127/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <test-api-key>" \
  -d '{"model":"ag/gemini-3.7-flash-high","messages":[{"role":"user","content":"Reply with exactly: OK"}],"stream":false,"max_tokens":30}'
# expect 200 + content "OK"
```

Check the gateway log shows `📊 DONE` (not `DISCONNECT: ResponseAborted`).

Then tell the user it's ready for **manual testing**. Only after their approval:

```bash
git checkout master
git merge sync-v<version>
git push
```

## 9. Reminders

- Unit tests: `npx vitest run tests/unit/...` — note ~77 pre-existing failures
  exist from a module-resolution issue (`open-sse/` bare specifier from
  `src/`), unrelated to syncs. Judge with `tests/__baseline__/verify-*.mjs`.
- After merging to master, the user may ask to delete the sync branch — clean
  up both local and remote.
- If the server must stay reachable from the LAN, keep
  `NINEROUTER_BIND_HOST=0.0.0.0` in the LaunchAgent plist.
