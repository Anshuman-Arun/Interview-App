export interface LocalTransportSecurity {
  readonly host: "127.0.0.1" | "::1";
  readonly allowedOrigins: ReadonlySet<string>;
  readonly clientToken: string;
}

const QUOTED_SECRET_ASSIGNMENT_PATTERN = /(["'])((?:[a-z][a-z0-9_-]*)?(?:authorization|api[-_]?key|access[-_]?token|client[-_]?token|token|secret))\1\s*:\s*(\[REDACTED\]|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:bearer|basic)\s+[^\s,;&}\x5d]+|[^\s,;&}\x5d]+)/giu;
const AUTHORIZATION_ASSIGNMENT_PATTERN = /\b((?:[a-z][a-z0-9_-]*)?authorization)\b\s*[:=]\s*(\[REDACTED\]|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:bearer|basic)\s+[^\s,;&}\x5d]+|[^\s,;&}\x5d]+)/giu;
const SECRET_ASSIGNMENT_PATTERN = /\b((?:[a-z][a-z0-9_-]*)?(?:api[-_]?key|access[-_]?token|client[-_]?token|token|secret))\b\s*[:=]\s*(\[REDACTED\]|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:bearer|basic)\s+[^\s,;&}\x5d]+|[^\s,;&}\x5d]+)/giu;

export function redactSecrets(text: string): string {
  const quotedKeysRedacted = text.replace(
    QUOTED_SECRET_ASSIGNMENT_PATTERN,
    (_match: string, keyQuote: string, key: string, value: string) =>
      `${keyQuote}${key}${keyQuote}:${redactValue(value)}`
  );

  const authorizationRedacted = quotedKeysRedacted.replace(
    AUTHORIZATION_ASSIGNMENT_PATTERN,
    (_match: string, key: string, value: string) =>
      `${key}=${redactValue(value)}`
  );

  return authorizationRedacted.replace(
    SECRET_ASSIGNMENT_PATTERN,
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
