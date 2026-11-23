import { getSettings } from "@/lib/localDb";
import { APP_CONFIG } from "@/shared/constants/config";

// Whitelabel defaults: the product ships as 9Router, and every deployment can
// rename it from Settings → Branding without rebuilding.
export const BRANDING_FALLBACK = {
  name: APP_CONFIG.name,
  shortName: "9Router",
  tagline: "AI Infrastructure Management",
};

const MAX_LENGTH = 60;

function clean(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_LENGTH) : fallback;
}

export function normalizeBranding(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const customName = clean(source.name, "");
  const name = customName || BRANDING_FALLBACK.name;
  return {
    name,
    // A custom name without a short name follows the name (one rename, both
    // surfaces); stock deployments keep the shorter product label.
    shortName: clean(source.shortName, customName ? name : BRANDING_FALLBACK.shortName),
    tagline: clean(source.tagline, BRANDING_FALLBACK.tagline),
  };
}

export async function getBranding() {
  try {
    const settings = await getSettings();
    return normalizeBranding(settings?.branding);
  } catch {
    return normalizeBranding(null);
  }
}
