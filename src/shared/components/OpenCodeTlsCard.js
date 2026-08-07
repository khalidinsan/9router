"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Toggle from "./Toggle";
import Badge from "./Badge";

// TLS-mode toggle for the opencode (oc/*) free provider.
//
// opencode.ai/zen fingerprints the TLS client: requests straight from Node
// (OpenSSL) always land in a permanently exhausted anonymous bucket
// (FreeUsageLimitError 429), while bun (BoringSSL — the same stack as the
// opencode TUI) rides the healthy bucket. The "bun" mode relays upstream
// requests through the local bun sidecar; "direct" sends them straight from
// Node, which matches any other HTTP client but will 429 on the free tier.
//
// Stored in settings as providerStrategies.opencode.tlsMode ("bun" | "direct").
const DEFAULT_MODE = "bun";

export default function OpenCodeTlsCard() {
  const [mode, setMode] = useState(DEFAULT_MODE);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        if (cancelled) return;
        const override = (data.providerStrategies || {}).opencode || {};
        if (override.tlsMode === "bun" || override.tlsMode === "direct") {
          setMode(override.tlsMode);
        } else {
          setMode(DEFAULT_MODE);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async (nextMode) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const updated = { ...current };
      updated.opencode = { ...(current.opencode || {}), tlsMode: nextMode };
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save opencode TLS mode error:", e);
    } finally {
      setSaving(false);
    }
  }, []);

  const handleToggle = (checked) => {
    const nextMode = checked ? "bun" : "direct";
    setMode(nextMode);
    save(nextMode);
  };

  const isBun = mode === "bun";

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-blue-500/10 text-blue-500">
          <span className="material-symbols-outlined text-[20px]">shield_lock</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">
            Upstream TLS mode
            <span className="ml-2">
              {savedFlash && (
                <Badge variant="success">Saved</Badge>
              )}
            </span>
          </p>
          <p className="text-xs text-text-muted">
            How oc/* requests connect to opencode.ai/zen
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <Toggle
          checked={isBun}
          onChange={handleToggle}
          disabled={saving}
          label="Bun TLS relay (recommended)"
          description={isBun
            ? "Route upstream through the local bun relay — same TLS fingerprint as the opencode TUI, healthy rate-limit bucket."
            : "Send straight from Node — the anonymous free tier will 429 (Node/OpenSSL fingerprint is throttled)."}
          className="flex-wrap"
        />
        <Badge variant={isBun ? "success" : "error"}>
          {isBun ? "Bun relay" : "Direct"}
        </Badge>
      </div>
    </Card>
  );
}