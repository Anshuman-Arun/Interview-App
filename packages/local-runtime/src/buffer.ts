import { sanitizeDiagnosticText } from "../../diagnostics/src/index.js";
import type { LocalOutputSnapshot } from "./types.js";

const TRUNCATED_MARKER = "[TRUNCATED]";
const MALFORMED_MARKER = "[MALFORMED_OUTPUT]";

export class BoundedLineBuffer {
  private readonly lines: string[] = [];
  private bytes = 0;
  private truncated = false;

  public constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number,
    private readonly secretValues: readonly string[]
  ) {}

  public push(rawLine: string): void {
    let line = rawLine;
    for (const secret of this.secretValues) {
      if (secret.length > 0) line = line.split(secret).join("[REDACTED]");
    }
    line = sanitizeDiagnosticText(line);
    if (line.length === 0) return;

    const fitted = fitUtf8(line, this.maxBytes);
    if (fitted !== line) this.truncated = true;
    const fittedBytes = Buffer.byteLength(fitted, "utf8");
    this.lines.push(fitted);
    this.bytes += fittedBytes;

    while (this.lines.length > this.maxLines || this.bytes > this.maxBytes) {
      const removed = this.lines.shift();
      if (removed === undefined) break;
      this.bytes -= Buffer.byteLength(removed, "utf8");
      this.truncated = true;
    }
  }

  public markMalformed(): void {
    this.push(MALFORMED_MARKER);
  }

  public snapshot(): LocalOutputSnapshot {
    const lines = this.truncated ? [TRUNCATED_MARKER, ...this.lines] : [...this.lines];
    return Object.freeze({ lines: Object.freeze(lines), truncated: this.truncated });
  }
}

export class BoundedLineFramer {
  private pending = Buffer.alloc(0);
  private droppingOversizeLine = false;

  public constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onMalformed: () => void
  ) {}

  public append(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);

      if (!this.droppingOversizeLine) {
        if (this.pending.length + fragment.length > this.maxLineBytes) {
          this.pending = Buffer.alloc(0);
          this.droppingOversizeLine = true;
          this.onMalformed();
        } else if (fragment.length > 0) {
          this.pending = this.pending.length === 0
            ? Buffer.from(fragment)
            : Buffer.concat([this.pending, fragment], this.pending.length + fragment.length);
        }
      }

      if (newline === -1) return;
      if (!this.droppingOversizeLine) this.emitPending();
      this.pending = Buffer.alloc(0);
      this.droppingOversizeLine = false;
      offset = newline + 1;
    }
  }

  public flush(): void {
    if (this.droppingOversizeLine) {
      this.pending = Buffer.alloc(0);
      this.droppingOversizeLine = false;
      return;
    }
    if (this.pending.length > 0) this.emitPending();
    this.pending = Buffer.alloc(0);
  }

  private emitPending(): void {
    let lineBuffer = this.pending;
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
