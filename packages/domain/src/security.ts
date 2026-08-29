export interface LocalTransportSecurity {
  readonly host: "127.0.0.1" | "::1";
  readonly allowedOrigins: ReadonlySet<string>;
  readonly clientToken: string;
}

const SECRET_PATTERN = /(authorization|api[-_]?key|token|secret)\s*[:=]\s*[^\s,;]+/giu;
export const redactSecrets = (text: string): string => text.replace(SECRET_PATTERN, "$1=[REDACTED]");

