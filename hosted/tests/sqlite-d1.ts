import { DatabaseSync } from "node:sqlite";
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from "../worker/store.ts";

class SQLiteStatement implements D1PreparedStatementLike {
  private values: unknown[] = [];
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  constructor(statement: ReturnType<DatabaseSync["prepare"]>) { this.statement = statement; }
  bind(...values: unknown[]): D1PreparedStatementLike {
    const bound = new SQLiteStatement(this.statement);
    bound.values = values;
    return bound;
  }
  async first<T>(): Promise<T | null> { return (this.statement.get(...this.values as never[]) as T | undefined) || null; }
  async all<T>(): Promise<D1ResultLike<T>> { return { success: true, results: this.statement.all(...this.values as never[]) as T[] }; }
  async run<T>(): Promise<D1ResultLike<T>> { this.statement.run(...this.values as never[]); return { success: true, results: [] }; }
}

export class SQLiteD1 implements D1DatabaseLike {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor(migration: string) {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) this.sqlite.exec(statement);
  }
  prepare(sql: string): D1PreparedStatementLike { return new SQLiteStatement(this.sqlite.prepare(sql)); }
  async batch<T>(statements: D1PreparedStatementLike[]): Promise<Array<D1ResultLike<T>>> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run<T>());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void { this.sqlite.close(); }
}
