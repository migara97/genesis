import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "orderflow.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const schemaCandidates = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql"),
  path.resolve(process.cwd(), "src/schema.sql"),
  path.resolve(process.cwd(), "apps/api/src/schema.sql"),
];
const schemaPath = schemaCandidates.find((candidate) => fs.existsSync(candidate));
if (!schemaPath) {
  throw new Error(`Market schema not found. Looked in ${schemaCandidates.join(", ")}`);
}
db.exec(fs.readFileSync(schemaPath, "utf8"));

export function saveOrder(order: unknown): void {
  const id = (order as { id: string }).id;
  db.prepare(
    "INSERT OR REPLACE INTO orders (id, payload, created_at) VALUES (?, ?, ?)",
  ).run(id, JSON.stringify(order), Date.now());
}

export function listOrders(limit = 100): unknown[] {
  const rows = db
    .prepare("SELECT payload FROM orders ORDER BY created_at DESC LIMIT ?")
    .all(limit) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload));
}

export function setMeta(key: string, value: unknown): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    key,
    JSON.stringify(value),
  );
}

export function getMeta<T>(key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;
  return JSON.parse(row.value) as T;
}
