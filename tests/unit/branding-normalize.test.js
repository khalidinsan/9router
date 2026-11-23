import { describe, it, expect } from "vitest";

import {
  normalizeBranding,
  brandPalette,
  BRANDING_FALLBACK,
} from "../../src/lib/branding.js";

const luminance = (hex) => {
  const v = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

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
      accent: BRANDING_FALLBACK.accent,
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

  it("accepts only 6-digit hex accents", () => {
    expect(normalizeBranding({ accent: "#3B82F6" }).accent).toBe("#3b82f6");
    for (const bad of ["blue", "#fff", "3b82f6", null, 123]) {
      expect(normalizeBranding({ accent: bad }).accent).toBe(BRANDING_FALLBACK.accent);
    }
  });
});

describe("brandPalette", () => {
  it("derives a full Tailwind ramp from the accent", () => {
    const palette = brandPalette("#3b82f6");
    expect(Object.keys(palette).sort()).toEqual(
      ["100", "200", "300", "400", "50", "500", "600", "700", "800", "900"].sort(),
    );
    expect(palette["500"]).toBe("#3b82f6");
    for (const hex of Object.values(palette)) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("darkens as the step grows", () => {
    const palette = brandPalette("#3b82f6");
    expect(luminance(palette["50"])).toBeGreaterThan(luminance(palette["500"]));
    expect(luminance(palette["600"])).toBeLessThan(luminance(palette["500"]));
    expect(luminance(palette["900"])).toBeLessThan(luminance(palette["700"]));
  });
});
