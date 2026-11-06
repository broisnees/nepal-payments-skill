// The public face: the same top bar and footer as the skill site (bordered segmented bar, product switch, shared
// footer columns), on the dashboard's tokens. Used by the landing page, the docs and the sign-in/sign-up pages.
import { DISPLAY_NAME, REPO_URL, SKILL_SITE_NAME, SKILL_SITE_URL, type Me } from "@paynp/shared";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Icon, Logo } from "../components/Icon.tsx";
import { ThemeButton } from "../components/Shell.tsx";
import { useQuery } from "../lib/query.ts";
import "../styles/public.css";

type Current = "home" | "docs" | "signin" | "signup";

export function PublicLayout({ current, children, wide }: { current?: Current; children: ReactNode; wide?: boolean }) {
  return (
    <div className="pub" data-wide={wide || undefined}>
      <a className="pub-skip" href="#main">
        Skip to content
      </a>
      <PublicNav current={current} />
      <div id="main" className="pub-body">
        {children}
      </div>
      <PublicFooter />
    </div>
  );
}

function PublicNav({ current }: { current?: Current }) {
  // A signed-in visitor gets a way back to the dashboard. A 401 here is expected and only hides that link.
  const me = useQuery<Me>("/api/me", { staleMs: 5 * 60_000 });
  const signedIn = !!me.data;
  return (
    <header className="pub-nav-wrap">
      <nav className="pub-nav pub-container" aria-label="Primary">
        <Link className="pub-cell pub-brand" to="/" aria-label={`${DISPLAY_NAME} home`}>
          <Logo size={22} />
        </Link>
        <div className="pub-products" role="group" aria-label="Products">
          <a className="pub-cell pub-product" href={SKILL_SITE_URL} title={`${SKILL_SITE_NAME}: the open-source skill and gateway adapters`}>
            Skill
          </a>
          <Link className="pub-cell pub-product" to="/" aria-current={current === "home" ? "page" : "true"}>
            {DISPLAY_NAME}
          </Link>
        </div>
        <Link className="pub-cell" to="/docs" aria-current={current === "docs" ? "page" : undefined}>
          Docs
        </Link>
        <a className="pub-cell hide-md" href="/status">
          Status
        </a>
        <span className="pub-spacer" />
        <a className="pub-cell hide-md" href={REPO_URL} rel="noopener">
          <Icon name="code" />
          GitHub
        </a>
        <span className="pub-cell pub-theme hide-sm">
          <ThemeButton />
        </span>
        {signedIn ? (
          <Link className="pub-cell pub-cta" to="/">
            Dashboard
          </Link>
        ) : (
          <>
            <Link className="pub-cell hide-sm" to="/signin" aria-current={current === "signin" ? "page" : undefined}>
              Sign in
            </Link>
            <Link className="pub-cell pub-cta" to="/signup" aria-current={current === "signup" ? "page" : undefined}>
              Sign up
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="pub-footer pub-container">
      <div className="pub-footer-top">
        <div className="pub-footer-intro">
          <span className="pub-brand-sm">
            <Logo size={18} />
            {DISPLAY_NAME}
          </span>
          <p className="muted">Every payment, every gateway, one place. Built for the ten Nepali gateways the {SKILL_SITE_NAME} skill covers.</p>
          <span className="pub-footer-theme">
            <ThemeButton />
            <span className="subtle">Theme</span>
          </span>
        </div>
        <nav className="pub-footer-cols" aria-label="Footer">
          <div>
            <p>Products</p>
            <a href={SKILL_SITE_URL}>Skill</a>
            <Link to="/">{DISPLAY_NAME}</Link>
          </div>
          <div>
            <p>Developers</p>
            <Link to="/docs">Docs</Link>
            <a href={`${SKILL_SITE_URL}/blog/`}>Blog</a>
            <a href={REPO_URL} rel="noopener">
              GitHub
            </a>
            <a href="/status">Status</a>
          </div>
        </nav>
      </div>
      <div className="pub-footer-bottom">
        <span>Not affiliated with or endorsed by any payment provider. Provider names belong to their owners.</span>
        <span>Times in Nepal time</span>
      </div>
    </footer>
  );
}
