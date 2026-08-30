# Local Compute Response Framing

The local Python worker uses protocol-v1 NDJSON over its private standard-output pipe. The Node supervisor treats that pipe as an untrusted process boundary even though both processes run locally.

## Bounded framing

`LocalComputeWorkerClient` scans raw stdout bytes for LF delimiters and retains at most `maxResponseLineBytes` for the current frame. It checks the bound while chunks arrive, before converting the frame to text or parsing JSON. A worker therefore cannot bypass the configured limit by withholding a newline and forcing `readline` to accumulate an unbounded string.

The delimiter is not part of the payload limit. CR, when present before LF, remains part of the JSON whitespace and counts toward the conservative byte bound.

## Admission order

Each complete frame passes these gates in order:

1. byte bound during accumulation;
2. fatal UTF-8 decoding;
3. JSON decoding;
4. strict response-envelope validation;
5. pending RequestId lookup;
6. request-operation and source-revision matching.

Failure at any framing, encoding, schema, correlation, or basis gate rejects all pending work and interrupts the entire local process with `INTERRUPT_LOCAL_PROCESS` semantics. Phase 0 has no honest per-request worker cancellation primitive.

Duplicate responses for a completed RequestId remain harmless. Multiple complete frames delivered in one operating-system chunk and one frame split across multiple chunks are both supported.

## Non-authority

Bounded framing does not make worker output authoritative. The application-side Local Compute Coordinator still reproduces transcript normalization and token counts independently before appending a semantic accepted-result event.
