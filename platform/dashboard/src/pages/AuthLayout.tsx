import type { ReactNode } from "react";
import { PublicLayout } from "../public/PublicLayout.tsx";

/** Sign-in, sign-up and check-email: the public top bar and footer around one narrow card. */
export function AuthLayout({ children, current }: { children: ReactNode; current?: "signin" | "signup" }) {
  return (
    <PublicLayout current={current}>
      <main className="auth-main">
        <div className="auth-card fade-in">{children}</div>
      </main>
    </PublicLayout>
  );
}
