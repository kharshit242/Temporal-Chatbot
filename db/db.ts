import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, "..");

const databasePath =
  process.env.DATABASE_PATH ?? "./data/memory.db";

const resolvedDatabasePath = path.resolve(
  projectRoot,
  databasePath
);

const dataDirectory = path.dirname(resolvedDatabasePath);

fs.mkdirSync(dataDirectory, { recursive: true });

export const db = new Database(resolvedDatabasePath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schemaPath = path.resolve(
  projectRoot,
  "db/schema.sql"
);

const schema = fs.readFileSync(schemaPath, "utf-8");

db.exec(schema);

export function closeDatabase(): void {
  db.close();
}