# Runtime diagnostics

`packages/diagnostics` is a local-only, observational diagnostics and reproducibility layer. It must not make authoritative interview decisions or mutate session, evidence, delivery, disclosure, grading, or verification state.

## Public API

- `captureRuntimeFingerprint(...)` records only metadata that is available locally or explicitly supplied by the caller. Runtime platform, architecture, and Node version come from the current process; optional application/build, Python, event-schema, problem, provider, verifier, and worker metadata are omitted when unavailable.
- `fingerprintDiagnosticConfiguration(...)` accepts bounded, plain JSON-compatible configuration, sanitizes it, canonicalizes object keys with locale-independent ordering, and computes a SHA-256 fingerprint. Object insertion order does not affect the result, and recognized secret values are redacted before hashing. Unsupported, cyclic, accessor-bearing, sparse, or over-limit input fails with `DiagnosticConfigurationError` instead of silently collapsing distinct configurations to the same representation.
- `sanitizeDiagnosticValue(...)`, `sanitizeDiagnosticRecord(...)`, and `sanitizeErrorMetadata(...)` recursively redact credential-bearing keys and reuse the domain `redactSecrets(...)` behavior for diagnostic strings, with additional protection for standalone bearer tokens and common API-key forms.
- `TimingRecorder` provides caller-owned monotonic timing spans with success/failure/cancelled outcomes, sanitized operation names/tags, deeply immutable samples, and bounded retention. `aggregateTimings(...)` reports count/min/max/mean/p50/p95 plus outcome counts.
- `SubsystemHealthSchema` represents informational `HEALTHY`, `DEGRADED`, `UNAVAILABLE`, and `UNKNOWN` states for persistence, providers, verifiers, local workers, renderer, whiteboard, and future voice/vision components.
- `createDiagnosticSnapshot(...)` assembles runtime metadata, timings, aggregates, health, and explicitly supplied extra metadata into a JSON-serializable snapshot. `serializeDiagnosticSnapshot(...)` emits JSON.

## Secret and privacy boundary

Snapshots do not automatically inspect or include interview transcripts, private solutions, session events, provider prompts, or credentials. Callers should pass only metadata required for diagnostics. Every caller-controlled string surface, including runtime/component identifiers, timing operation names, tags, health fields, errors, and extra fields, is sanitized again while assembling or serializing a snapshot.

Configuration fingerprints are hashes of sanitized canonical data. Recognized secret fields therefore do not affect the fingerprint and are not included in the hash payload.

Sanitization is bounded by exported limits for nesting, node count, array items, object entries, key length, and string length. Timing recorders use a bounded recent-sample window and report their dropped-sample count. Snapshots retain bounded recent timing and health observations and enforce a serialized byte limit. Accessor properties are never invoked; unsupported or uninspectable objects are replaced with fixed markers. Sanitization remains defense in depth and does not authorize deliberately passing sensitive interview content or credentials into diagnostics.

## Deferred integration points

This package deliberately does not modify current runtime subsystems. Later integrations can pass:

- the existing event schema version constant from `packages/events`;
- provider identity plus `toDiagnosticProviderCapabilities(...)` output from the existing provider capability contract;
- verifier identifiers/versions from registered deterministic verifiers;
- worker version/capability metadata from the existing local-worker health response;
- operation timings around context compilation, provider calls, verification, local workers, delivery, STT/TTS, and vision;
- subsystem health observations collected by the owning runtime.

Diagnostics failure must be handled as non-authoritative: consumers should be able to drop diagnostic data without changing interview behavior.
