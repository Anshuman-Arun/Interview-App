import { createHash } from "node:crypto";
import {
  CommandEnvelopeSchema,
  CommandFingerprintSchema,
  CommandIdentitySchema,
  type CommandEnvelope,
  type CommandFingerprint
} from "../../domain/src/index.js";

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Command fingerprint input is not JSON-compatible");
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function fingerprintCommand(envelope: CommandEnvelope, identity: unknown): CommandFingerprint {
  const parsedEnvelope = CommandEnvelopeSchema.parse(envelope);
  const parsedIdentity = CommandIdentitySchema.parse(identity);
  return CommandFingerprintSchema.parse(createHash("sha256")
    .update(canonicalJson({ envelope: parsedEnvelope, identity: parsedIdentity }))
    .digest("hex"));
}
