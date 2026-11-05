import type { ReactNode } from "react";
import { Logo } from "../components/Icon.tsx";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-top">
        <span className="brand-mark">
          <Logo />
          paynp
        </span>
      </div>
      <main className="auth-main">
        <div className="auth-card fade-in">{children}</div>
      </main>
      <footer className="auth-foot">
        <span>Every payment, every gateway, one place.</span>
        <span className="hide-sm">Times in Nepal time</span>
      </footer>
    </div>
  );
}
