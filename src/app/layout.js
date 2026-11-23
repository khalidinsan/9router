import { Inter } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "material-symbols/outlined.css";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { getBranding } from "@/lib/branding";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export async function generateMetadata() {
  const branding = await getBranding();
  return {
    title: `${branding.name} - ${branding.tagline}`,
    description: "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
    icons: {
      icon: branding.faviconUrl || "/favicon.svg",
    },
  };
}

export async function generateViewport() {
  const branding = await getBranding();
  return { themeColor: branding.accent };
}

// Only the accent that differs from the shipped stylesheet needs overriding;
// `:root:root` outranks the globals.css declarations regardless of order.
function accentCss(palette, accent) {
  const vars = Object.entries(palette)
    .map(([step, hex]) => `--color-brand-${step}:${hex};`)
    .join("");
  return `:root:root{${vars}--color-primary:${accent};--color-primary-hover:${palette[600]};}`;
}

export default async function RootLayout({ children }) {
  const branding = await getBranding();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <style
          id="brand-accent"
          dangerouslySetInnerHTML={{ __html: accentCss(branding.palette, branding.accent) }}
        />
        {/* Apply persisted theme before first paint so a reload does not flash the
            default (light) theme before the client store hydrates. Mirrors the
            zustand-persist "theme" key and the `dark` class applyTheme() sets. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('theme');var t=s?(JSON.parse(s).state||{}).theme:'system';t=t||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t==='system'&&m)){document.documentElement.classList.add('dark')}}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `var d=document,r=d.documentElement,f=function(){r.classList.add('fonts-loaded')};if(d.fonts&&d.fonts.load){d.fonts.load('24px "Material Symbols Outlined"').then(f).catch(f);setTimeout(f,3000)}else{f()}`,
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider>
          <RuntimeI18nProvider>
            {children}
          </RuntimeI18nProvider>
        </ThemeProvider>
        <GoogleAnalytics gaId={"G-LC959F603F"} />
      </body>
    </html>
  );
}
