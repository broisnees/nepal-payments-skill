// Public docs at /docs/:slug. Pages are Markdown files in ./content, rendered by lib/markdown.tsx.
import { DISPLAY_NAME } from "@paynp/shared";
import { useEffect } from "react";
import { Link, Navigate, NavLink, useLocation, useParams } from "react-router";
import { Icon } from "../../components/Icon.tsx";
import { Markdown, headings } from "../../lib/markdown.tsx";
import { PublicLayout } from "../PublicLayout.tsx";

const files = import.meta.glob("./content/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const source = (slug: string) => files[`./content/${slug}.md`];

export const DOCS: { group: string; pages: { slug: string; title: string }[] }[] = [
  {
    group: "Start",
    pages: [
      { slug: "introduction", title: "Introduction" },
      { slug: "quickstart", title: "Quickstart" },
    ],
  },
  {
    group: "Send events",
    pages: [
      { slug: "sdk", title: "SDK reference" },
      { slug: "cli", title: "CLI" },
      { slug: "events", title: "Events and redaction" },
      { slug: "projects", title: "Projects, environments and API keys" },
    ],
  },
  {
    group: "Use the dashboard",
    pages: [
      { slug: "alerts", title: "Alerts and channels" },
      { slug: "analytics", title: "Analytics and digests" },
      { slug: "operations", title: "Reconcile, refunds and exports" },
      { slug: "go-live", title: "Go-live checklist" },
      { slug: "status-page", title: "Status page" },
    ],
  },
  {
    group: "Run it",
    pages: [{ slug: "limits", title: "Self-hosting and limits" }],
  },
];
const FLAT = DOCS.flatMap((g) => g.pages);

export default function Docs() {
  const { slug = "" } = useParams();
  const loc = useLocation();
  const i = FLAT.findIndex((p) => p.slug === slug);
  const page = FLAT[i];
  const md = page ? source(page.slug) : undefined;

  useEffect(() => {
    if (!page) return;
    document.title = `${page.title} · ${DISPLAY_NAME} docs`;
    return () => {
      document.title = DISPLAY_NAME;
    };
  }, [page]);

  // New page: start at the top, or at the heading the link points to.
  useEffect(() => {
    const id = decodeURIComponent(loc.hash.slice(1));
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [slug, loc.hash]);

  if (!slug) return <Navigate to="/docs/introduction" replace />;
  if (!page || !md) return <Navigate to="/docs/introduction" replace />;
  const prev = FLAT[i - 1];
  const next = FLAT[i + 1];
  const toc = headings(md).filter((h) => h.depth === 2);
  const group = DOCS.find((g) => g.pages.includes(page))!;

  return (
    <PublicLayout current="docs">
      <div className="docs pub-container">
        <aside className="docs-side" aria-label="Docs">
          <details className="docs-picker">
            <summary>
              <span className="subtle">{group.group}</span>
              <span className="ink">{page.title}</span>
              <Icon name="chevronDown" className="subtle" />
            </summary>
            <SideNav />
          </details>
          <div className="docs-side-full">
            <SideNav />
          </div>
        </aside>
        <main className="docs-main">
          <article className="md" key={page.slug}>
            <p className="docs-eyebrow">{group.group}</p>
            <Markdown source={md} />
          </article>
          <nav className="docs-pager" aria-label="Previous and next">
            {prev ? (
              <Link to={`/docs/${prev.slug}`} className="docs-pager-link">
                <span className="subtle">Previous</span>
                <span className="ink">{prev.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link to={`/docs/${next.slug}`} className="docs-pager-link docs-pager-next">
                <span className="subtle">Next</span>
                <span className="ink">{next.title}</span>
              </Link>
            )}
          </nav>
        </main>
        {toc.length > 1 && (
          <nav className="docs-toc" aria-label="On this page">
            <p>On this page</p>
            {toc.map((h) => (
              <a key={h.id} href={`#${h.id}`}>
                {h.text}
              </a>
            ))}
          </nav>
        )}
      </div>
    </PublicLayout>
  );
}

function SideNav() {
  return (
    <>
      {DOCS.map((g) => (
        <div key={g.group} className="docs-group">
          <p>{g.group}</p>
          {g.pages.map((p) => (
            <NavLink key={p.slug} to={`/docs/${p.slug}`} className="docs-link" onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}>
              {p.title}
            </NavLink>
          ))}
        </div>
      ))}
    </>
  );
}
