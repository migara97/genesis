import fs from "node:fs";
import path from "node:path";

/**
 * Apply corporate TLS settings before outbound HTTPS.
 * Prefer NODE_EXTRA_CA_CERTS (Node built-in) or TLS_CA_FILE.
 * TLS_INSECURE=1 disables verification — local/dev behind broken MITM only.
 */
export function applyTlsEnv(): { mode: "default" | "ca_file" | "insecure"; detail: string } {
  const insecure =
    process.env.TLS_INSECURE === "1" || process.env.TLS_INSECURE?.toLowerCase() === "true";
  if (insecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    return {
      mode: "insecure",
      detail: "TLS_INSECURE=1 — certificate verification disabled (dev only)",
    };
  }

  const caFile = process.env.TLS_CA_FILE?.trim();
  if (caFile) {
    const resolved = path.resolve(caFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`TLS_CA_FILE not found: ${resolved}`);
    }
    // Node merges NODE_EXTRA_CA_CERTS into the trust store for undici/fetch/ws.
    process.env.NODE_EXTRA_CA_CERTS = resolved;
    return { mode: "ca_file", detail: `Using TLS_CA_FILE=${resolved}` };
  }

  if (process.env.NODE_EXTRA_CA_CERTS) {
    return {
      mode: "ca_file",
      detail: `Using NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}`,
    };
  }

  return { mode: "default", detail: "System trust store (no TLS override)" };
}
