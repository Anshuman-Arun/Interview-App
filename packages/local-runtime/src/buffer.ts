import { sanitizeDiagnosticText } from "../../diagnostics/src/index.js";
import type { LocalOutputSnapshot } from "./types.js";

const TRUNCATED_MARKER = "[TRUNCATED]";
const MALFORMED_MARKER = "[MALFORMED_OUTPUT]";
const REDACTED_MARKER = "[REDACTED]";

const MAX_REDACTION_REGEX_PATTERNS = 128;
const MAX_REDACTION_REGEX_SOURCE_LENGTH = 64 * 1024;

type RedactionMatcher =
  | { readonly kind: "REGEX"; readonly regex: RegExp }
  | { readonly kind: "LITERAL"; readonly literal: string };

const redactionMatcherCache = new WeakMap<readonly string[], readonly RedactionMatcher[]>();

export function redactKnownSecrets(value: string, secretValues: readonly string[]): string {
  if (value.length === 0 || secretValues.length === 0) return value;
  const matchers = redactionMatchers(secretValues);
  let mask: Uint8Array | undefined;

  for (const matcher of matchers) {
    if (matcher.kind === "LITERAL") {
      if (matcher.literal.length > value.length) continue;
      let searchFrom = 0;
      for (;;) {
        const match = value.indexOf(matcher.literal, searchFrom);
        if (match < 0) break;
        mask ??= new Uint8Array(value.length);
        mask.fill(1, match, match + matcher.literal.length);
        searchFrom = match + 1;
      }
      continue;
    }

    const regex = matcher.regex;
    regex.lastIndex = 0;
    for (;;) {
      const match = regex.exec(value);
      if (match === null) break;
      const matched = match[1];
      if (matched !== undefined && matched.length > 0) {
        mask ??= new Uint8Array(value.length);
        mask.fill(1, match.index, match.index + matched.length);
      }
      // The lookahead is intentionally zero-width so overlapping secret
      // occurrences are found. Advance manually to guarantee progress.
      regex.lastIndex = match.index + 1;
    }
  }

  if (mask === undefined) return value;

  const output: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (mask[index] === 1) {
      while (index < value.length && mask[index] === 1) index += 1;
      output.push(REDACTED_MARKER);
      continue;
    }
    const start = index;
    while (index < value.length && mask[index] !== 1) index += 1;
    output.push(value.slice(start, index));
  }
  return output.join("");
}

function redactionMatchers(secretValues: readonly string[]): readonly RedactionMatcher[] {
  const cached = redactionMatcherCache.get(secretValues);
  if (cached !== undefined) return cached;

  const orderedSecrets = [...secretValues]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);

  const matchers: RedactionMatcher[] = [];
  let batch: { readonly original: string; readonly escaped: string }[] = [];
  let batchSourceLength = 0;

  const flushBatch = (): void => {
    if (batch.length === 0) return;
    const source = `(?=(${batch.map((entry) => entry.escaped).join("|")}))`;
    try {
      matchers.push(Object.freeze({ kind: "REGEX", regex: new RegExp(source, "g") }));
    } catch {
      for (const entry of batch) {
        matchers.push(Object.freeze({ kind: "LITERAL", literal: entry.original }));
      }
    }
    batch = [];
    batchSourceLength = 0;
  };

  for (const secret of orderedSecrets) {
    const escaped = escapeRegexLiteral(secret);
    const nextSourceLength = batchSourceLength + escaped.length + (batch.length === 0 ? 0 : 1);
    if (batch.length > 0
        && (batch.length >= MAX_REDACTION_REGEX_PATTERNS
          || nextSourceLength > MAX_REDACTION_REGEX_SOURCE_LENGTH)) {
      flushBatch();
    }
    if (escaped.length > MAX_REDACTION_REGEX_SOURCE_LENGTH) {
      matchers.push(Object.freeze({ kind: "LITERAL", literal: secret }));
      continue;
    }
    batch.push(Object.freeze({ original: secret, escaped }));
    batchSourceLength += escaped.length + (batch.length === 1 ? 0 : 1);
  }
  flushBatch();

  const frozen = Object.freeze(matchers);
  redactionMatcherCache.set(secretValues, frozen);
  return frozen;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

export class BoundedLineBuffer {
  private readonly lines: string[] = [];
  private head = 0;
  private bytes = 0;
  private truncated = false;

  public constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number,
    private readonly secretValues: readonly string[]
  ) {}

  public push(rawLine: string): void {
    this.pushSanitized(sanitizeDiagnosticText(redactKnownSecrets(rawLine, this.secretValues)));
  }

  public pushInternal(rawLine: string): void {
    this.pushSanitized(sanitizeDiagnosticText(rawLine));
  }

  public markMalformed(): void {
    this.pushInternal(MALFORMED_MARKER);
  }

  private pushSanitized(line: string): void {
    if (line.length === 0) return;

    const fitted = fitUtf8(line, this.maxBytes);
    if (fitted !== line) this.truncated = true;
    const fittedBytes = Buffer.byteLength(fitted, "utf8");
    this.lines.push(fitted);
    this.bytes += fittedBytes;

    while (this.lines.length - this.head > this.maxLines || this.bytes > this.maxBytes) {
      const removed = this.lines[this.head];
      if (removed === undefined) break;
      this.lines[this.head] = "";
      this.head += 1;
      this.bytes -= Buffer.byteLength(removed, "utf8");
      this.truncated = true;
    }
    this.compact();
  }

  public clear(): void {
    this.lines.length = 0;
    this.head = 0;
    this.bytes = 0;
    this.truncated = false;
  }

  public snapshot(): LocalOutputSnapshot {
    const lines = this.lines.slice(this.head);
    let bytes = this.bytes;

    if (this.truncated) {
      const marker = fitUtf8(TRUNCATED_MARKER, this.maxBytes);
      const markerBytes = Buffer.byteLength(marker, "utf8");
      while (lines.length >= this.maxLines || bytes + markerBytes > this.maxBytes) {
        const removed = lines.shift();
        if (removed === undefined) break;
        bytes -= Buffer.byteLength(removed, "utf8");
      }
      if (markerBytes <= this.maxBytes && lines.length < this.maxLines) lines.unshift(marker);
    }

    return Object.freeze({ lines: Object.freeze(lines), truncated: this.truncated });
  }

  private compact(): void {
    if (this.head < 1_024 || this.head * 2 < this.lines.length) return;
    this.lines.splice(0, this.head);
    this.head = 0;
  }
}

export class BoundedLineFramer {
  private readonly pending: Buffer;
  private pendingBytes = 0;
  private droppingOversizeLine = false;

  public constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onMalformed: () => void
  ) {
    this.pending = Buffer.alloc(maxLineBytes + 1);
  }

  public append(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);

      if (!this.droppingOversizeLine && fragment.length > 0) {
        const nextBytes = this.pendingBytes + fragment.length;
        const provisionalTerminalCr = nextBytes === this.maxLineBytes + 1
          && fragment.at(-1) === 0x0d;
        if (nextBytes > this.maxLineBytes && !provisionalTerminalCr) {
          this.clearPending();
          this.droppingOversizeLine = true;
          this.onMalformed();
        } else {
          fragment.copy(this.pending, this.pendingBytes);
          this.pendingBytes = nextBytes;
        }
      }

      if (newline === -1) return;
      if (!this.droppingOversizeLine) this.emitPending();
      this.clearPending();
      this.droppingOversizeLine = false;
      offset = newline + 1;
    }
  }

  public flush(): void {
    if (this.droppingOversizeLine) {
      this.clearPending();
      this.droppingOversizeLine = false;
      return;
    }
    if (this.pendingBytes > 0) this.emitPending();
    this.clearPending();
  }

  private clearPending(): void {
    this.pendingBytes = 0;
  }

  private emitPending(): void {
    let lineBuffer = this.pending.subarray(0, this.pendingBytes);
    if (lineBuffer.at(-1) === 0x0d) lineBuffer = lineBuffer.subarray(0, -1);
    try {
      const line = new TextDecoder("utf-8", { fatal: true }).decode(lineBuffer);
      this.onLine(line);
    } catch {
      this.onMalformed();
    }
  }
}

function fitUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  if (maxBytes <= Buffer.byteLength(TRUNCATED_MARKER, "utf8")) return TRUNCATED_MARKER.slice(0, maxBytes);
  const budget = maxBytes - Buffer.byteLength(TRUNCATED_MARKER, "utf8");
  let prefix = bytes.subarray(0, budget).toString("utf8");
  if (prefix.endsWith("\uFFFD")) prefix = prefix.slice(0, -1);
  return `${prefix}${TRUNCATED_MARKER}`;
}
