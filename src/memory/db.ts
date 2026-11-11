import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const databasePath = resolve(
  process.cwd(),
  process.env.DATABASE_PATH ?? "./data/memory.db"
);

mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma("foreign_keys = ON");

const schemaCandidates = [
  fileURLToPath(new URL("../../db/schema.sql", import.meta.url)),
  fileURLToPath(new URL("../../../db/schema.sql", import.meta.url)),
  resolve(process.cwd(), "db/schema.sql")
];
const schemaPath = schemaCandidates.find((candidate) =>
  existsSync(candidate)
);

if (!schemaPath) {
  throw new Error("Unable to locate the SQLite schema file.");
}

db.exec(readFileSync(schemaPath, "utf8"));
