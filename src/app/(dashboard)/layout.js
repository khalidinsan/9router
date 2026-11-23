import { DashboardLayout } from "@/shared/components";

// The tab title comes from the root layout's branding metadata; without this the
// dashboard shell is prerendered with the label captured at build time.
export const dynamic = "force-dynamic";

export default function DashboardRootLayout({ children }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
