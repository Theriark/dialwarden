// The Drizzle schema matches the migrated tables (dev-work-plan P1-A step 2;
// code review M9, test review F4). The migration SQL is written by hand, so
// this test is what keeps the two in step: tables, columns (type, NOT NULL,
// primary key), unique columns, named indexes, CHECK constraints and foreign
// keys. Column defaults are not compared.
import Database from "better-sqlite3";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";
import { schema } from "./schema.js";

let sqlite: Database.Database;

beforeAll(async () => {
  sqlite = new Database(":memory:");
  // A fresh database takes no pre-migration copy, so no data folder is used.
  await migrate(sqlite, { dataDir: "/nonexistent", now: () => new Date() });
});

afterAll(() => {
  sqlite.close();
});

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface IndexRow {
  name: string;
  unique: number;
  origin: string;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

const byName = <T extends { name: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => a.name.localeCompare(b.name));

// SQLite lists the foreign keys of a table in reverse order of declaration.
const byFrom = <T extends { from: string | undefined }>(items: T[]): T[] =>
  [...items].sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""));

/** PRAGMA rows; the table name comes from the Drizzle schema, never input. */
function pragma<T>(name: string, table: string): T[] {
  return sqlite.prepare(`PRAGMA ${name}("${table}")`).all() as T[];
}

function indexColumns(index: string): string[] {
  return pragma<{ name: string }>("index_info", index).map((row) => row.name);
}

const tables = Object.values(schema) as SQLiteTable[];

describe("Drizzle schema and migrations", () => {
  it("has the same tables", () => {
    const rows = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'",
      )
      .all() as { name: string }[];
    const migrated = rows.map((row) => row.name).sort();
    const declared = tables.map((table) => getTableConfig(table).name).sort();
    expect(declared).toEqual(migrated);
  });

  for (const table of tables) {
    const config = getTableConfig(table);

    describe(config.name, () => {
      it("has the same columns", () => {
        const declared = config.columns.map((column) => ({
          name: column.name,
          type: column.getSQLType().toUpperCase(),
          notNull: column.notNull,
          primaryKey: column.primary,
        }));
        const migrated = pragma<ColumnRow>("table_info", config.name).map(
          (row) => ({
            name: row.name,
            type: row.type.toUpperCase(),
            notNull: row.notnull === 1,
            primaryKey: row.pk > 0,
          }),
        );
        expect(byName(declared)).toEqual(byName(migrated));
      });

      it("has the same unique columns and named indexes", () => {
        const indexes = pragma<IndexRow>("index_list", config.name);
        const uniqueColumns = indexes
          .filter((index) => index.origin === "u")
          .flatMap((index) => indexColumns(index.name))
          .sort();
        const declaredUnique = config.columns
          .filter((column) => column.isUnique)
          .map((column) => column.name)
          .sort();
        expect(declaredUnique).toEqual(uniqueColumns);

        const named = indexes
          .filter((index) => index.origin === "c")
          .map((index) => ({
            name: index.name,
            unique: index.unique === 1,
            columns: indexColumns(index.name),
          }));
        const declared = config.indexes.map((index) => ({
          name: index.config.name,
          unique: index.config.unique,
          columns: index.config.columns.map(
            (column) => (column as { name: string }).name,
          ),
        }));
        expect(byName(declared)).toEqual(byName(named));
      });

      it("has the same CHECK constraints and foreign keys", () => {
        const sqlRow = sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
          .get(config.name) as { sql: string };
        const checks = sqlRow.sql.match(/\bCHECK\s*\(/gi) ?? [];
        expect(config.checks).toHaveLength(checks.length);

        const migrated = pragma<ForeignKeyRow>(
          "foreign_key_list",
          config.name,
        ).map((row) => ({
          from: row.from,
          table: row.table,
          to: row.to,
          onDelete: row.on_delete.toUpperCase(),
        }));
        const declared = config.foreignKeys.map((key) => {
          const reference = key.reference();
          return {
            from: reference.columns[0]?.name,
            table: getTableConfig(reference.foreignTable).name,
            to: reference.foreignColumns[0]?.name,
            onDelete: (key.onDelete ?? "no action").toUpperCase(),
          };
        });
        expect(byFrom(declared)).toEqual(byFrom(migrated));
      });
    });
  }
});
