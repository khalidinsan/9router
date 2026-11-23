import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/localDb";
import { APP_CONFIG } from "@/shared/constants/config";

// Whitelabel defaults: the product ships as 9Router, and every deployment can
// rename it (and pick its own accent colour + logo) from Settings → Branding
// without rebuilding.
export const BRANDING_FALLBACK = {
  name: APP_CONFIG.name,
  shortName: "9Router",
  tagline: "AI Infrastructure Management",
  accent: "#E56A4A",
};

export const DEFAULT_ACCENT = BRANDING_FALLBACK.accent;

const MAX_LENGTH = 60;
const ASSET_DIR = path.join(DATA_DIR, "branding");

// Kept small on purpose: these are chrome assets, not uploads.
const ASSET_TYPES = {
  logo: { maxBytes: 512 * 1024, ext: ["png", "svg", "webp", "jpg"] },
  favicon: { maxBytes: 256 * 1024, ext: ["png", "svg", "ico"] },
};

const MIME_BY_EXT = {
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  jpg: "image/jpeg",
  ico: "image/x-icon",
};

function clean(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_LENGTH) : fallback;
}

function cleanAccent(value) {
  if (typeof value !== "string") return BRANDING_FALLBACK.accent;
  const hex = value.trim();
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : BRANDING_FALLBACK.accent;
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hslToHex({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

// Tailwind-style 50…900 ramp derived from one accent, so a single colour pick
// restyles every `brand-*` utility without touching the stylesheet.
export function brandPalette(accent) {
  const base = cleanAccent(accent);
  const hsl = rgbToHsl(hexToRgb(base));
  const lightness = {
    50: 0.96,
    100: 0.9,
    200: 0.79,
    300: 0.68,
    400: 0.58,
    500: hsl.l,
    600: Math.max(0.12, hsl.l - 0.1),
    700: Math.max(0.1, hsl.l - 0.19),
    800: Math.max(0.08, hsl.l - 0.28),
    900: Math.max(0.06, hsl.l - 0.36),
  };
  // Pale steps lose saturation so they stay usable as backgrounds.
  const palette = {};
  for (const [step, l] of Object.entries(lightness)) {
    const s = Number(step) <= 100 ? hsl.s * 0.55 : hsl.s;
    palette[step] = hslToHex({ h: hsl.h, s, l });
  }
  palette[500] = base;
  return palette;
}

function assetPath(type, ext) {
  return path.join(ASSET_DIR, `${type}.${ext}`);
}

/** First existing file wins; returns { buffer, mime, version } or null. */
export function readBrandingAsset(type) {
  const spec = ASSET_TYPES[type];
  if (!spec) return null;
  for (const ext of spec.ext) {
    const file = assetPath(type, ext);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      return {
        file,
        ext,
        mime: MIME_BY_EXT[ext],
        version: Math.floor(stat.mtimeMs).toString(36),
      };
    } catch {
      /* try the next extension */
    }
  }
  return null;
}

export function brandingAssetUrl(type) {
  const asset = readBrandingAsset(type);
  return asset ? `/api/branding/asset?type=${type}&v=${asset.version}` : null;
}

/** Accepts a data: URL, enforces the per-type mime/size limits, replaces others. */
export function saveBrandingAsset(type, dataUrl) {
  const spec = ASSET_TYPES[type];
  if (!spec) throw new Error("Unknown branding asset type");
  if (typeof dataUrl !== "string") throw new Error("Asset data is required");

  const match = /^data:image\/(png|svg\+xml|webp|jpeg|x-icon|vnd\.microsoft\.icon);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new Error("Unsupported image format");

  const ext =
    match[1].toLowerCase() === "svg+xml" ? "svg" :
    match[1].toLowerCase() === "jpeg" ? "jpg" :
    match[1].toLowerCase() === "x-icon" || match[1].toLowerCase() === "vnd.microsoft.icon" ? "ico" :
    match[1].toLowerCase();
  if (!spec.ext.includes(ext)) throw new Error(`Unsupported ${type} format`);

  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length) throw new Error("Empty image");
  if (buffer.length > spec.maxBytes) {
    throw new Error(`${type} must be smaller than ${Math.round(spec.maxBytes / 1024)}KB`);
  }

  fs.mkdirSync(ASSET_DIR, { recursive: true });
  for (const other of spec.ext) {
    if (other !== ext) {
      try {
        fs.unlinkSync(assetPath(type, other));
      } catch {
        /* not present */
      }
    }
  }
  fs.writeFileSync(assetPath(type, ext), buffer, { mode: 0o644 });
  return brandingAssetUrl(type);
}

export function removeBrandingAsset(type) {
  const spec = ASSET_TYPES[type];
  if (!spec) return;
  for (const ext of spec.ext) {
    try {
      fs.unlinkSync(assetPath(type, ext));
    } catch {
      /* not present */
    }
  }
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
    accent: cleanAccent(source.accent),
  };
}

export async function getBranding() {
  let settings = null;
  try {
    settings = await getSettings();
  } catch {
    /* first boot / build: fall back to defaults */
  }
  const branding = normalizeBranding(settings?.branding);
  return {
    ...branding,
    logoUrl: brandingAssetUrl("logo"),
    faviconUrl: brandingAssetUrl("favicon"),
    palette: brandPalette(branding.accent),
  };
}
