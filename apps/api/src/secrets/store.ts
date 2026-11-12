import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";

db.exec(`
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

const ALLOWED = new Set(["BINANCE_API_KEY", "BINANCE_API_SECRET", "BYBIT_API_KEY", "BYBIT_API_SECRET"]);

function keyMaterial(): Buffer {
  return createHash("sha256").update(config.encryptionKey).digest();
}

function encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decrypt(row: { ciphertext: string; iv: string; tag: string }): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyMaterial(),
    Buffer.from(row.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function listSecretsMasked(): {
  name: string;
  masked: string;
  updatedAt: number;
  present: boolean;
}[] {
  const rows = db
    .prepare("SELECT name, ciphertext, iv, tag, updated_at FROM secrets ORDER BY name")
    .all() as { name: string; ciphertext: string; iv: string; tag: string; updated_at: number }[];
  return rows.map((row) => {
    let masked = "****";
    try {
      masked = mask(decrypt(row));
    } catch {
      masked = "(decrypt failed — check ENCRYPTION_KEY)";
    }
    return { name: row.name, masked, updatedAt: row.updated_at, present: true };
  });
}

export function upsertSecret(name: string, value: string): { name: string; masked: string } {
  if (!ALLOWED.has(name)) {
    throw new Error(`Secret name not allowed: ${name}`);
  }
  if (!value.trim()) throw new Error("Secret value required");
  const enc = encrypt(value.trim());
  const now = Date.now();
  db.prepare(
    `INSERT INTO secrets (name, ciphertext, iv, tag, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag, updated_at=excluded.updated_at`,
  ).run(name, enc.ciphertext, enc.iv, enc.tag, now);
  return { name, masked: mask(value.trim()) };
}

/** Re-encrypt all rows with current ENCRYPTION_KEY (after key change, caller must decrypt with old key first). */
export function rotateEncryption(oldKey: string): { rotated: number } {
  const rows = db
    .prepare("SELECT name, ciphertext, iv, tag FROM secrets")
    .all() as { name: string; ciphertext: string; iv: string; tag: string }[];
  const oldMaterial = createHash("sha256").update(oldKey).digest();
  let rotated = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        oldMaterial,
        Buffer.from(row.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(row.tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const enc = encrypt(plain);
      db.prepare(
        `UPDATE secrets SET ciphertext=?, iv=?, tag=?, updated_at=? WHERE name=?`,
      ).run(enc.ciphertext, enc.iv, enc.tag, Date.now(), row.name);
      rotated += 1;
    }
  });
  tx();
  return { rotated };
}

export function readSecret(name: string): string | null {
  const row = db.prepare("SELECT ciphertext, iv, tag FROM secrets WHERE name = ?").get(name) as
    | { ciphertext: string; iv: string; tag: string }
    | undefined;
  if (!row) return null;
  try {
    return decrypt(row);
  } catch {
    return null;
  }
}

/** LIVE credentials: DB secret first, else env fallback (never returned to UI). */
export function resolveBinanceCredentials(): { apiKey: string; apiSecret: string } {
  return {
    apiKey: readSecret("BINANCE_API_KEY") || config.binanceApiKey || "",
    apiSecret: readSecret("BINANCE_API_SECRET") || config.binanceApiSecret || "",
  };
}
