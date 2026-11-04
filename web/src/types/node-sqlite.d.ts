// Minimal types for Node's built-in SQLite (node:sqlite, Node 22.5+), which
// the installed @types/node predates. Only what lib/cloud.ts uses.
declare module "node:sqlite" {
  type Value = null | number | bigint | string | Uint8Array;
  export class StatementSync {
    all(...params: Value[]): Record<string, unknown>[];
    get(...params: Value[]): Record<string, unknown> | undefined;
    run(...params: Value[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
