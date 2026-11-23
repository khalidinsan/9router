import { getBranding } from "@/lib/branding";

export const dynamic = "force-dynamic";

export default async function manifest() {
  const branding = await getBranding();
  return {
    name: `${branding.name} - ${branding.tagline}`,
    short_name: branding.shortName,
    description: 'One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: branding.accent,
    orientation: 'portrait-primary',
    icons: branding.faviconUrl
      ? [
          { src: branding.faviconUrl, sizes: 'any', type: 'image/png' },
          { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
        ]
      : [
          {
            src: '/icons/icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
          },
          {
            src: '/icons/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
          },
          {
            src: '/icons/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
  }
}
