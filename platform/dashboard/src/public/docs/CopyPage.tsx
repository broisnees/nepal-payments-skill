import { DEFAULT_ENDPOINT } from "@paynp/shared";
import { useState } from "react";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Menu } from "../../components/ui.tsx";

/** "Copy page" beside a doc's title: the page's Markdown for an LLM, or the page opened in an assistant. */
export function CopyPage({ slug, markdown }: { slug: string; markdown: string }) {
  const [label, setLabel] = useState("Copy page");
  const mdUrl = `/docs/${slug}.md`;
  const prompt = encodeURIComponent(`Read ${DEFAULT_ENDPOINT}${mdUrl} and help me with it.`);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setLabel("Copied");
    } catch {
      setLabel("Copy failed");
    }
    setTimeout(() => setLabel("Copy page"), 1600);
  };
  const items: { icon: IconName; title: string; sub: string; href: string }[] = [
    { icon: "file", title: "View as Markdown", sub: "Plain text of this page", href: mdUrl },
    { icon: "sparkles", title: "Open in ChatGPT", sub: "Ask questions about this page", href: `https://chatgpt.com/?hints=search&q=${prompt}` },
    { icon: "bot", title: "Open in Claude", sub: "Ask questions about this page", href: `https://claude.ai/new?q=${prompt}` },
    { icon: "search", title: "Open in Perplexity", sub: "Ask questions about this page", href: `https://www.perplexity.ai/search/new?q=${prompt}` },
    { icon: "code", title: "llms.txt", sub: "Every page, for agents", href: "/llms.txt" },
  ];
  return (
    <div className="copy-page">
      <button type="button" className="btn btn-sm" onClick={() => void copy()}>
        <Icon name={label === "Copied" ? "check" : "copy"} />
        {label}
      </button>
      <Menu
        align="end"
        trigger={({ open, toggle, id }) => (
          <button type="button" className="btn btn-sm btn-icon" aria-label="More ways to use this page" aria-expanded={open} aria-controls={id} aria-haspopup="menu" onClick={toggle}>
            <Icon name="chevronDown" />
          </button>
        )}
      >
        {(close) => (
          <>
            <button
              className="menu-item copy-page-item"
              onClick={() => {
                close();
                void copy();
              }}
            >
              <Icon name="copy" />
              <span>
                <span className="ink">Copy page</span>
                <span className="subtle">Markdown for an LLM</span>
              </span>
            </button>
            {items.map((it) => (
              <a key={it.title} className="menu-item copy-page-item" href={it.href} target={it.href.startsWith("http") ? "_blank" : undefined} rel="noopener" onClick={close}>
                <Icon name={it.icon} />
                <span>
                  <span className="ink">{it.title}</span>
                  <span className="subtle">{it.sub}</span>
                </span>
              </a>
            ))}
          </>
        )}
      </Menu>
    </div>
  );
}
