export interface LocalTransportSecurity {
  readonly host: "127.0.0.1" | "::1";
  readonly allowedOrigins: ReadonlySet<string>;
  readonly clientToken: string;
}

const QUOTED_SECRET_ASSIGNMENT_PATTERN = /(["'])((?:[a-z][a-z0-9]*[-_])*(?:authorization|api[-_]?key|access[-_]?token|client[-_]?token|token|secret))\1\s*:\s*("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[a-z][a-z0-9+.-]*\s+[^\s,;&}\]]+|[^\s,;&}\]]+)/giu;
const UNQUOTED_SECRET_ASSIGNMENT_PATTERN = /\b((?:[a-z][a-z0-9]*[-_])*(?:authorization|api[-_]?key|access[-_]?token|client[-_]?token|token|secret))\b\s*[:=]\s*("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[a-z][a-z0-9+.-]*\s+[^\s,;&}\]]+|[^\s,;&}\]]+)/giu;

export function redactSecrets(text: string): string {
  const quotedKeysRedacted = text.replace(
    QUOTED_SECRET_ASSIGNMENT_PATTERN,
    (_match: string, keyQuote: string, key: string, value: string) =>
      `${keyQuote}${key}${keyQuote}:${redactValue(value)}`
  );

  return quotedKeysRedacted.replace(
    UNQUOTED_SECRET_ASSIGNMENT_PATTERN,
    (_match: string, key: string, value: string) =>
      `${key}=${redactValue(value)}`
  );
}

function redactValue(value: string): string {
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.at(-1) === quote) {
    return `${quote}[REDACTED]${quote}`;
  }
  return "[REDACTED]";
}
