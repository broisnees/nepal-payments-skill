// Parsing with @babel/parser and the few AST helpers the codemod needs.
import { parse, type ParserPlugin } from "@babel/parser";
import type * as t from "@babel/types";
import { extname } from "node:path";

export type { t };

export function parseFile(code: string, file: string): t.File | null {
  const ext = extname(file);
  const plugins: ParserPlugin[] = [".ts", ".mts", ".cts"].includes(ext) ? ["typescript"] : ext === ".tsx" ? ["typescript", "jsx"] : ["jsx"];
  try {
    return parse(code, {
      sourceType: "module",
      plugins,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
  } catch {
    return null; // not valid code: leave the file alone
  }
}

/** Visits every node, parents first. Return false from `visit` to skip a node's children. */
export function walk(node: t.Node, visit: (n: t.Node, parent: t.Node | null) => boolean | void, parent: t.Node | null = null): void {
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments" || key === "extra") continue;
    const v = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c === "object" && typeof (c as t.Node).type === "string") walk(c as t.Node, visit, node);
    } else if (v && typeof v === "object" && typeof (v as t.Node).type === "string") walk(v as t.Node, visit, node);
  }
}

/** Names a module exports (declarations, specifiers, re-exports with a source). */
export function exportedNames(ast: t.File): Set<string> {
  const out = new Set<string>();
  for (const s of ast.program.body) {
    if (s.type === "ExportNamedDeclaration") {
      const d = s.declaration;
      if (d && (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id) out.add(d.id.name);
      if (d?.type === "VariableDeclaration") for (const v of d.declarations) if (v.id.type === "Identifier") out.add(v.id.name);
      for (const sp of s.specifiers) {
        if (sp.type === "ExportSpecifier") out.add(sp.exported.type === "Identifier" ? sp.exported.name : sp.exported.value);
      }
    } else if (s.type === "ExportDefaultDeclaration") out.add("default");
  }
  return out;
}

export const lineStart = (code: string, pos: number) => code.lastIndexOf("\n", pos - 1) + 1;
export const indentAt = (code: string, pos: number) => /^[ \t]*/.exec(code.slice(lineStart(code, pos)))![0];

/** The quote and the statement terminator the file already uses. */
export function styleOf(code: string, ast: t.File): { q: string; semi: string } {
  const imp = ast.program.body.find((s) => s.type === "ImportDeclaration") as t.ImportDeclaration | undefined;
  const q = imp ? code[imp.source.start!] : (/["']/.exec(code)?.[0] ?? '"');
  const first = ast.program.body[0];
  const semi = first ? (code[first.end! - 1] === ";" ? ";" : "") : ";";
  return { q: q === "'" ? "'" : '"', semi };
}

/** Last top-level import, or null. */
export function lastImport(ast: t.File): t.ImportDeclaration | null {
  let last: t.ImportDeclaration | null = null;
  for (const s of ast.program.body) if (s.type === "ImportDeclaration") last = s;
  return last;
}

/** True when a multi-line template literal sits inside [start, end): re-indenting there would change a string. */
export function hasMultilineTemplate(node: t.Node, code: string): boolean {
  let found = false;
  walk(node, (n) => {
    if (n.type === "TemplateLiteral" && code.slice(n.start!, n.end!).includes("\n")) found = true;
    return !found;
  });
  return found;
}
