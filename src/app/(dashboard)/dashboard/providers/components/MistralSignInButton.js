"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

// "Login with browser" for Mistral: runs the Vibe CLI sign-in flow so the key
// it mints is a *Vibe* key (Vibe Code allowance) instead of a Studio key
// (Studio API allowance). Both are Bearer keys against the same endpoint; only
// the quota bucket differs.
export default function MistralSignInButton({ onConnected, size = "sm" }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const timerRef = useRef(null);
  const deadlineRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(
    async (processId) => {
      try {
        const res = await fetch(
          `/api/oauth/mistral/browser-sign-in?processId=${encodeURIComponent(processId)}`,
          { cache: "no-store" },
        );
        const data = await res.json().catch(() => ({}));

        if (data.status === "success") {
          stopPolling();
          setBusy(false);
          setStatus("");
          if (typeof onConnected === "function") onConnected();
          return;
        }
        if (data.status === "pending") return;

        stopPolling();
        setBusy(false);
        setStatus("");
        setError(data.message || data.error || `Sign-in ${data.status || "failed"}`);
      } catch (err) {
        stopPolling();
        setBusy(false);
        setStatus("");
        setError(err?.message || "Sign-in polling failed");
      }
    },
    [onConnected, stopPolling],
  );

  const handleStart = async () => {
    setBusy(true);
    setError("");
    setStatus("Waiting for the browser sign-in…");
    try {
      const res = await fetch("/api/oauth/mistral/browser-sign-in", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.signInUrl) {
        setError(data.error || "Could not start Mistral sign-in");
        setBusy(false);
        setStatus("");
        return;
      }

      window.open(data.signInUrl, "_blank", "noopener,noreferrer");
      deadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
      stopPolling();
      timerRef.current = setInterval(() => {
        if (Date.now() > deadlineRef.current) {
          stopPolling();
          setBusy(false);
          setStatus("");
          setError("Sign-in timed out — try again");
          return;
        }
        poll(data.processId);
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setError(err?.message || "Could not start Mistral sign-in");
      setBusy(false);
      setStatus("");
    }
  };

  return (
    <>
      <Button
        size={size}
        icon="login"
        variant="secondary"
        disabled={busy}
        onClick={handleStart}
        title="Sign in through the browser to mint a Vibe-type API key (bills the Vibe Code allowance, not the Studio API allowance)"
      >
        {busy ? "Waiting for browser…" : "Login Browser (Vibe)"}
      </Button>
      {status && <p className="w-full text-xs text-text-muted">{status}</p>}
      {error && <p className="w-full text-xs text-red-500 break-words">{error}</p>}
    </>
  );
}

MistralSignInButton.propTypes = {
  onConnected: PropTypes.func,
  size: PropTypes.oneOf(["sm", "md", "lg"]),
};
