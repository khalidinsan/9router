"use client";

import { useEffect, useState } from "react";

// Client mirror of src/lib/branding.js. The login page renders before auth, so
// branding must come from a public endpoint; every other surface reuses this
// module-level cache instead of refetching per component.
export const BRANDING_DEFAULT = {
  name: "9Router Proxy",
  shortName: "9Router",
  tagline: "AI Infrastructure Management",
};

let cache = null;
let inflight = null;

export function invalidateBrandingCache() {
  cache = null;
  inflight = null;
}

function loadBranding() {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/branding", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        inflight = null;
        if (!data) return null;
        cache = { ...BRANDING_DEFAULT, ...data };
        return cache;
      })
      .catch(() => {
        inflight = null;
        return null;
      });
  }
  return inflight;
}

export function useBranding() {
  const [branding, setBranding] = useState(cache || BRANDING_DEFAULT);

  useEffect(() => {
    let alive = true;
    loadBranding().then((value) => {
      if (alive && value) setBranding(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return branding;
}
