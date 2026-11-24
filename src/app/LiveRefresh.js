"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Re-fetches the server component tree on an interval. router.refresh() swaps
// the RSC payload in place — no document reload, no scroll jump, and client
// DOM state (the API-key accordion checkboxes) survives. Paused while the tab
// is hidden so a board left open overnight doesn't keep hitting the DB.
export default function LiveRefresh({ seconds = 0 }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!seconds) return;
    let cancelled = false;
    let timer;
    let clearSyncing;

    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        setSyncing(true);
        router.refresh();
        clearSyncing = setTimeout(() => {
          if (!cancelled) setSyncing(false);
        }, 900);
      }
      timer = setTimeout(tick, seconds * 1000);
    };

    timer = setTimeout(tick, seconds * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(clearSyncing);
    };
  }, [seconds, router]);

  if (!seconds) {
    return <span className="size-1.5 rounded-full bg-gray-600" title="Live refresh off" />;
  }

  return (
    <span
      className={`inline-block size-1.5 rounded-full transition-colors duration-300 ${
        syncing ? "bg-emerald-400" : "bg-emerald-400/30"
      }`}
      title={`Live — refreshing every ${seconds}s`}
    />
  );
}
