import { describe, it, expect } from "vitest";

import { normalizeBranding, BRANDING_FALLBACK } from "../../src/lib/branding.js";

describe("normalizeBranding", () => {
  it("falls back to the shipped product label", () => {
    expect(normalizeBranding(null)).toEqual(BRANDING_FALLBACK);
    expect(normalizeBranding({})).toEqual(BRANDING_FALLBACK);
  });

  it("lets a custom name carry the short name when only the name is set", () => {
    expect(normalizeBranding({ name: "Sumedang Gateway" })).toEqual({
      name: "Sumedang Gateway",
      shortName: "Sumedang Gateway",
      tagline: BRANDING_FALLBACK.tagline,
    });
  });

  it("trims, collapses whitespace and caps length", () => {
    const branding = normalizeBranding({
      name: "  Sumedang   Gateway  ",
      shortName: "S",
      tagline: "x".repeat(200),
    });
    expect(branding.name).toBe("Sumedang Gateway");
    expect(branding.shortName).toBe("S");
    expect(branding.tagline).toHaveLength(60);
  });

  it("ignores non-string values", () => {
    const branding = normalizeBranding({ name: 42, shortName: null, tagline: [] });
    expect(branding).toEqual(BRANDING_FALLBACK);
  });
});
