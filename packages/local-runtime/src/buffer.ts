import { sanitizeDiagnosticText } from "../../diagnostics/src/index.js";
import type { LocalOutputSnapshot } from "./types.js";

const TRUNCATED_MARKER = "[TRUNCATED]";
const MALFORMED_MARKER = "[MALFORMED_OUTPUT]";
const REDACTED_MARKER = "[REDACTED]";

interface RedactionSegment {
  readonly text: string;
  readonly redacted: boolean;
}

export function redactKnownSecrets(value: string, secretValues: readonly string[]): string {
  let segments: readonly RedactionSegment[] = [{ text: value, redacted: false }];
  let changed = false;

  for (const secret of secretValues) {
    if (secret.length === 0) continue;
    const next: RedactionSegment[] = [];

    for (const segment of segments) {
      if (segment.redacted || segment.text.length === 0) {
        next.push(segment);
        continue;
      }

      let start = 0;
      let match = segment.text.indexOf(secret, start);
      if (match < 0) {
        next.push(segment);
        continue;
      }

      changed = true;
      while (match >= 0) {
        if (match > start) {
          next.push({ text: segment.text.slice(start, match), redacted: false });
        }
        next.push({ text: REDACTED_MARKER, redacted: true });
        start = match + secret.length;
        match = segment.text.indexOf(secret, start);
      }
      if (start < segment.text.length) {
        next.push({ text: segment.text.slice(start), redacted: false });
      }
    }

    segments = next;
  }

  if (!changed) return value;
  return segments.map((segment) => segment.text).join("");
}

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
    let line = redactKnownSecrets(rawLine, this.secretValues);
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

  public clear(): void {
    this.lines.length = 0;
    this.bytes = 0;
    this.truncated = false;
  }

  public snapshot(): LocalOutputSnapshot {
    const lines = [...this.lines];
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
    this.pending = Buffer.alloc(maxLineBytes);
  }

  public append(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);

      if (!this.droppingOversizeLine) {
        if (this.pendingBytes + fragment.length > this.maxLineBytes) {
          this.clearPending();
          this.droppingOversizeLine = true;
          this.onMalformed();
        } else if (fragment.length > 0) {
          fragment.copy(this.pending, this.pendingBytes);
          this.pendingBytes += fragment.length;
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
