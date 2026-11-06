// A small Markdown renderer for the docs: headings (with anchors), paragraphs, lists, tables, blockquote notes,
// fenced code (with a copy button and light highlighting), and inline code, bold, italics and links.
// Only the subset the docs use; content is our own, so no HTML passthrough.
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { CodeBlock } from "../components/ui.tsx";

export interface Heading {
  depth: 2 | 3;
  text: string;
  id: string;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

type Block =
  | { kind: "h"; depth: 1 | 2 | 3; text: string }
  | { kind: "p"; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "note"; text: string };

function parse(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  const isBreak = (l: string) => /^(#{1,3} |```|> |\s*[-*] |\s*\d+\. |\|)/.test(l) || !l.trim();
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3}) (.*)$/.exec(l);
    if (h) {
      out.push({ kind: "h", depth: h[1].length as 1 | 2 | 3, text: h[2].trim() });
      i++;
      continue;
    }
    if (l.startsWith("```")) {
      const lang = l.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      out.push({ kind: "code", lang, code: body.join("\n") });
      continue;
    }
    if (l.startsWith("> ")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^> ?/, ""));
      out.push({ kind: "note", text: body.join(" ") });
      continue;
    }
    if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = splitRow(lines[i++]);
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
      }
      out.push({ kind: "table", head: rows[0] ?? [], rows: rows.slice(1) });
      continue;
    }
    const li = /^\s*([-*]|\d+\.) (.*)$/.exec(l);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*]|\d+\.) (.*)$/.exec(lines[i]);
        if (m) items.push(m[2]);
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += " " + lines[i].trim();
        else break;
        i++;
      }
      out.push({ kind: ordered ? "ol" : "ul", items });
      continue;
    }
    const para: string[] = [l];
    i++;
    while (i < lines.length && !isBreak(lines[i])) para.push(lines[i++]);
    out.push({ kind: "p", text: para.join(" ") });
  }
  return out;
}

/** Splits a table row on pipes that are not inside backticks or escaped. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let code = false;
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (ch === "`") {
      code = !code;
      cur += ch;
    } else if (ch === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Inline: `code`, **bold**, *em*, [text](href). */
export function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = key;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={n++}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={n++}>{inline(m[2], n * 100)}</strong>);
    else if (m[3] !== undefined) out.push(<em key={n++}>{inline(m[3], n * 100)}</em>);
    else {
      const href = m[5];
      const label = inline(m[4], n * 100);
      out.push(
        href.startsWith("/") && !href.startsWith("/status") ? (
          <Link key={n++} className="inline-link" to={href}>
            {label}
          </Link>
        ) : (
          <a key={n++} className="inline-link" href={href} rel={href.startsWith("http") ? "noopener" : undefined}>
            {label}
          </a>
        ),
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Quiet highlighting: comments, strings, a few keywords. Enough to read, never wrong in a misleading way. */
export function highlight(code: string, lang: string): ReactNode[] {
  const shell = lang === "bash" || lang === "sh" || lang === "env";
  const re = shell
    ? /(#[^\n]*)|("(?:\\.|[^"\\])*"|'[^']*')/g
    : /(\/\/[^\n]*|--[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`[^`]*`)|\b(?:import|from|export|const|let|await|async|function|return|if|else|new|type|interface|default)\b/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(code))) {
    // `--` is a comment only in SQL; elsewhere (flags, decrements) leave it alone.
    if (m[1]?.startsWith("--") && lang !== "sql") continue;
    if (shell && m[1] && m.index > 0 && !/\s/.test(code[m.index - 1])) continue;
    if (m.index > last) out.push(code.slice(last, m.index));
    if (m[1]) out.push(<span key={n++} className="c-dim">{m[1]}</span>);
    else if (m[2]) out.push(<span key={n++} className="c-str">{m[2]}</span>);
    else out.push(<span key={n++} className="c-key">{m[0]}</span>);
    last = re.lastIndex;
  }
  out.push(code.slice(last));
  return out;
}

export function headings(md: string): Heading[] {
  return parse(md)
    .filter((b): b is Extract<Block, { kind: "h" }> => b.kind === "h" && b.depth > 1)
    .map((b) => ({ depth: b.depth as 2 | 3, text: b.text.replace(/`/g, ""), id: slug(b.text) }));
}

export function Markdown({ source }: { source: string }) {
  const blocks = parse(source);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h": {
            if (b.depth === 1) return <h1 key={i}>{inline(b.text)}</h1>;
            const id = slug(b.text);
            const H = b.depth === 2 ? "h2" : "h3";
            return (
              <H key={i} id={id}>
                <a className="md-anchor" href={`#${id}`}>
                  {inline(b.text)}
                </a>
              </H>
            );
          }
          case "p":
            return <p key={i}>{inline(b.text)}</p>;
          case "note":
            return (
              <aside key={i} className="md-note">
                <p>{inline(b.text)}</p>
              </aside>
            );
          case "code":
            return (
              <div key={i} className="md-code" data-lang={b.lang || undefined}>
                <CodeBlock code={b.code}>{highlight(b.code, b.lang)}</CodeBlock>
              </div>
            );
          case "ul":
          case "ol": {
            const L = b.kind;
            return (
              <L key={i}>
                {b.items.map((it, k) => (
                  <li key={k}>{inline(it)}</li>
                ))}
              </L>
            );
          }
          case "table":
            return (
              <div key={i} className="md-table" tabIndex={0} role="region" aria-label="Table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, k) => (
                        <th key={k}>{inline(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, k) => (
                      <tr key={k}>
                        {r.map((c, j) => (
                          <td key={j}>{inline(c)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
        return <Fragment key={i} />;
      })}
    </>
  );
}
