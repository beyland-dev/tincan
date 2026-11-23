import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { TincanError } from "@beyland/tincan-protocol";

export type SqlParam = null | undefined | number | bigint | boolean | string | Uint8Array;
export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

/**
 * The synchronous SQL surface the store needs. The native `Vault` satisfies it as is; tests use
 * {@link nodeSqliteDb}. Parameters are positional (`?`), booleans bind as 0/1 and `undefined` as NULL.
 */
export interface Db {
  readonly inTransaction: boolean;
  exec(sql: string, params?: SqlParam[]): { changes: number; lastInsertRowid: number };
  /** Runs `;`-separated statements without parameters. */
  execBatch(sql: string): void;
  query<T = Row>(sql: string, params?: SqlParam[]): T[];
  /**
   * Runs `body` in an immediate transaction: committed if it returns, rolled back if it throws.
   * `body` must be synchronous. Transactions don't nest.
   */
  transaction<T>(body: () => T): T;
}

/** Adapts a `node:sqlite` database to {@link Db}, matching the Vault's behaviour. */
export function nodeSqliteDb(db: DatabaseSync): Db {
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  const bind = (params: SqlParam[] = []): SQLInputValue[] =>
    params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));

  return {
    get inTransaction() {
      return db.isTransaction;
    },
    exec(sql, params) {
      const result = prepare(sql).run(...bind(params));
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    execBatch(sql) {
      db.exec(sql);
    },
    query<T>(sql: string, params?: SqlParam[]): T[] {
      return prepare(sql).all(...bind(params)) as T[];
    },
    transaction<T>(body: () => T): T {
      if (db.isTransaction) throw new TincanError("INVALID_INPUT", "A transaction is already open");
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = body();
        if (result instanceof Promise) {
          result.catch(() => {});
          throw new TincanError("INVALID_INPUT", "A transaction body must be synchronous");
        }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
