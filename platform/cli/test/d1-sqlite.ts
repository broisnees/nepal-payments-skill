// The slice of the D1 API the worker's ingest and health queries use, over node:sqlite, so the worker's own
// SQL can run in Node for the parity test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSqlite } from "../src/dev/store.ts";

type Row = Record<string, unknown>;
interface Stmt {
  sql: string;
  args: unknown[];
  bind(...args: unknown[]): Stmt;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export async function d1(): Promise<{ DB: { prepare(sql: string): Stmt; batch(s: Stmt[]): Promise<{ results: Row[]; meta: { changes: number } }[]> }; close(): void } | null> {
  const sqlite = await loadSqlite();
  if (!sqlite) return null;
  const db = new (sqlite as unknown as { DatabaseSync: new (p: string) => any }).DatabaseSync(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "../../worker/migrations/0001_init.sql"), "utf8"));
  const exec = (s: Stmt) => {
    const st = db.prepare(s.sql);
    const args = s.args.map((a) => (a === undefined ? null : a));
    if (/^\s*select\b/i.test(s.sql) || /\breturning\b/i.test(s.sql)) {
      const results = st.all(...args) as Row[];
      return { results: results.map((r) => ({ ...r })), meta: { changes: results.length } };
    }
    const r = st.run(...args) as { changes: number | bigint };
    return { results: [], meta: { changes: Number(r.changes) } };
  };
  const make = (sql: string, args: unknown[] = []): Stmt => ({
    sql,
    args,
    bind: (...a) => make(sql, a),
    first: async <T,>() => (exec(make(sql, args)).results[0] as T) ?? null,
    all: async <T,>() => ({ results: exec(make(sql, args)).results as T[] }),
    run: async () => ({ meta: exec(make(sql, args)).meta }),
  });
  return {
    DB: {
      prepare: (sql) => make(sql),
      async batch(stmts) {
        db.exec("BEGIN");
        try {
          const out = stmts.map(exec);
          db.exec("COMMIT");
          return out;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    close: () => db.close(),
  };
}
