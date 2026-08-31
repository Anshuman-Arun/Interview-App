# Local model assets

`packages/model-assets` is a mechanical, non-authoritative byte-management boundary for versioned local artifacts. It does not execute artifacts, start workers, select interview providers, or know interview/session semantics.

## Manifest and resolution

Every artifact uses a strict schema-version-1 manifest containing stable family/artifact identifiers, version, artifact type, optional platform/architecture/variant constraints, a portable leaf filename, exact byte size, lowercase SHA-256, and an HTTP(S) provenance URL. Optional model/protocol/license/source metadata is bounded. Embedded URL credentials, path separators, Windows device filenames, unknown fields, unsafe identifiers, and malformed digests are rejected.

`resolveAssetManifest` requires an exact family/version and exact requested variant. Platform and architecture constraints are treated as explicit compatibility predicates: a generic artifact may match any target, but an exact platform/architecture artifact is preferred by specificity. Equally specific matches fail as ambiguous; unsupported targets fail explicitly.

## Cache layout

The caller supplies an absolute cache root. The manager canonicalizes it and creates only these children:

```text
<root>/
  artifacts/<64-hex installation key>/
    manifest.json
    <portable filename>
  tmp/<64-hex installation key>-<uuid>/
    ...staging files...
```

The installation key is a SHA-256 fingerprint of the bounded artifact identity and integrity fields, so manifest strings are never used as directory names. All writes/removals are containment-checked. Existing symlink path components are rejected; recursive cleanup unlinks symlinks instead of following them.

## Install and integrity lifecycle

Remote install and local import use the same lifecycle:

```text
staging directory
→ bounded stream/copy
→ exact size + SHA-256 verification
→ write validated manifest metadata
→ atomic directory rename into artifacts/
→ INSTALLED
```

A final artifact directory is therefore never a partial download. On cancellation, timeout, network failure, size mismatch, digest mismatch, or publication failure, the staging directory is removed. Existing corrupt installations are never returned as usable paths.

HTTP downloads are streamed to disk with a hard artifact limit, exact manifest-size enforcement, an overall timeout, cancellation, bounded redirects, HTTPS-downgrade rejection, credential rejection, and cross-origin redirects disabled by default. No external network host is used by tests.

## State, concurrency, and capacity

`inspect` derives `INSTALLED`/`CORRUPT` from the filesystem and integrity checks; it does not persist an installed flag. `DOWNLOADING` and `VERIFYING` describe active in-process work. The last failed attempt is retained only as disposable in-memory observational metadata and never overrides filesystem verification.

Exact duplicate in-process installs coalesce onto one operation. Caller cancellation is reference-counted: cancelling one waiter does not abort shared work needed by another waiter, while cancellation of the final waiter aborts the transfer.

`maxArtifactBytes` is mandatory. `maxCacheBytes` is optional and checked with in-flight byte reservations. Free disk space is checked with `statfs` where the platform exposes it. There is no automatic eviction policy; callers can remove one artifact, clear stale temporary entries, or deterministically clear unused installation keys.

## Diagnostics compatibility

`getDiagnosticMetadata` returns only artifact ID, family ID, version, expected digest, status, and byte size. It intentionally omits source URLs and private filesystem paths. Trusted application code can request a verified installed path separately with `getInstalledPath`.

Specific model integrations, worker wiring, model selection UI, GPU discovery, Python/package installation, and runtime/provider routing are deliberately deferred.
