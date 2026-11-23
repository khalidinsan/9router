import LoginClient from "./LoginClient";

// The client page is a leaf, but the tab title comes from the root layout's
// branding metadata — prerendering would freeze the label at build time.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return <LoginClient />;
}
