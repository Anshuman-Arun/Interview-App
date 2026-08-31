import { createHash } from "node:crypto";
import { sanitizeDiagnosticValue } from "./sanitize.js";
import type { DiagnosticValue, Sha256Fingerprint } from "./types.js";

function canonicalize(value: DiagnosticValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

export function canonicalizeDiagnosticConfiguration(configuration: unknown): string {
  return canonicalize(sanitizeDiagnosticValue(configuration) ?? null);
}

export function fingerprintDiagnosticConfiguration(configuration: unknown): Sha256Fingerprint {
  return createHash("sha256")
    .update(canonicalizeDiagnosticConfiguration(configuration), "utf8")
    .digest("hex");
}
