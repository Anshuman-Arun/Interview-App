# Local model assets

`packages/model-assets` is a mechanical, non-authoritative byte-management boundary for versioned local artifacts. It does not execute artifacts, start workers, select interview providers, or know interview/session semantics.

## Manifest and resolution

Every artifact uses a strict schema-version-1 manifest containing stable family/artifact identifiers, version, artifact type, optional platform/architecture/variant constraints, a portable leaf filename, exact byte size, lowercase SHA-256, and an HTTP(S) provenance URL. Optional model/protocol/license/source metadata is bounded.

Manifest and resolution objects must be JSON-like own data records. Inherited fields, accessors/getters, proxies, symbol keys, unknown fields, malformed identifiers/digests, embedded URL credentials, path separators, trailing-dot names, Windows device filenames, and the reserved `manifest.json` payload filename are rejected before their values can influence filesystem or network behavior.

`resolveAssetManifest` requires an exact family/version and exact requested variant. Platform and architecture constraints are compatibility predicates: a generic artifact may match any target, while platform/architecture-specific matches are preferred by specificity. Equally specific matches fail as ambiguous; unsupported targets fail explicitly. `resolveAssetForCurrentPlatform` validates its request before reading/spreading it and then binds the request to the current Node platform/architecture.

### Manifest source trust boundary

Manifest structure is treated as hostile data and is validated accordingly, but **network destination authority is application-owned**. Production callers must select manifests from an application-controlled registry or equivalent trusted configuration; `install()` is not a general-purpose downloader for arbitrary user-, model-, document-, or remote-supplied URLs.

The package deliberately does not claim SSRF protection for an attacker who is allowed to choose an otherwise-valid initial HTTP(S) `sourceUrl`. In particular, the URL validator does not reject loopback, link-local, or private-network destinations and does not implement DNS-rebinding defenses. If third-party or user-supplied manifests are supported later, the application must add an explicit origin/egress policy before passing them to this package (or this package must gain such a policy) rather than relying on redirect validation alone.

## Cache layout

The caller supplies an absolute cache root. The manager canonicalizes it, pins the filesystem identity of the root and its two fixed managed parents, and creates only these managed namespaces:

```text
<root>/
  artifacts/<64-hex installation key>/
    manifest.json
    <portable filename>
  artifacts/.model-assets-delete-<uuid>/   # removal/recovery tombstone
  tmp/<64-hex installation key>-<uuid>/
    ...staging files...
  tmp/.model-assets-delete-<uuid>/         # removal/recovery tombstone
```

The installation key is a SHA-256 fingerprint of bounded artifact identity/integrity fields, so manifest strings are never used as directory names. Manifest-controlled writes are restricted to a validated portable leaf filename. The fixed `artifacts/` and `tmp/` parents must remain the same real directories and must be on the same filesystem so publication can use directory rename.

Staged payload and metadata files are created exclusively with mode `0600` where supported, verified against the staging-directory filesystem identity, and written through already-open file handles. The manager rechecks staged and installed path/file identities around integrity verification and publication.

Removal is bounded and flat rather than recursively trusting cache contents. A managed entry is first atomically detached to a same-parent cache-local tombstone. Regular files and symlinks can then be unlinked without following symlink targets. Unexpected nested real directories are refused. Crash-left manager tombstones can be retried by the explicit cleanup APIs.

## Install and integrity lifecycle

Remote install and local import use the same publication discipline:

```text
validated staging directory
→ exclusively create payload file
→ bounded stream/copy through the open payload handle
→ close transfer handle
→ exclusively create/write bounded manifest metadata
→ exact size + SHA-256 verification of staged payload
→ reconcile an existing destination only after replacement verification
→ revalidate staging directory, payload, metadata, and cache topology
→ atomic same-filesystem directory rename into artifacts/
→ revalidate published directory, payload, metadata, and cache topology
→ INSTALLED
```

The manager never publishes a partially downloaded file as an installation. Verification hashes a stable opened file and then proves the pathname still refers to the same unchanged file before success. Cached manifests are likewise bounded, read through stable handles, parsed as fatal UTF-8/JSON, schema-validated, and identity-checked after reading.

A corrupt existing installation is not deleted merely because a repair starts: the replacement must stage and pass integrity verification first. If replacement download/import fails, the old corrupt entry remains observable as corrupt. There is no separately persisted “installed” flag; installed state is always derived from current filesystem structure and integrity.

On cancellation, timeout, network failure, size mismatch, digest mismatch, or failed publication, active staging is cleaned where safely possible. A cleanup failure may leave only manager-owned cache-local staging/tombstone state for later explicit cleanup; it does not turn partial bytes into an installed artifact.

## Download and import bounds

HTTP downloads are streamed to disk without buffering the full artifact. The downloader enforces:

- mandatory `maxArtifactBytes`;
- exact manifest-size enforcement, including chunked responses;
- strict decimal `Content-Length` parsing;
- bounded response headers;
- an overall timeout and cancellation;
- a hard redirect-depth ceiling;
- raw and canonicalized URL-length limits;
- HTTP/HTTPS only and no embedded URL credentials;
- HTTPS-downgrade rejection;
- cross-origin redirects rejected by default unless explicitly enabled.

Local imports also stream through a stable opened source file, require a regular non-symlink source, enforce expected/max sizes, and still pass the staged bytes through SHA-256 verification before publication.

## State, concurrency, and capacity

`inspect` derives `INSTALLED`/`CORRUPT` from current filesystem/integrity checks. Artifact-local operational inspection failures such as a configured verification limit are represented as `FAILED`; invalid/replaced fixed cache topology is treated as a cache-root safety error and rejects the operation instead of being mislabeled as artifact corruption.

`DOWNLOADING` and `VERIFYING` describe active work owned by that manager instance. Last-failure metadata is in-memory, bounded by `maxListEntries`, cleared after success/removal/temporary cleanup as appropriate, and never overrides verified filesystem truth.

Duplicate requests for the exact same artifact coalesce within one manager instance. Caller cancellation is reference-counted: cancelling one waiter does not abort work still needed by another waiter, while cancellation of the final waiter aborts the shared operation. Accepted cancellation signals are native, unmodified `AbortSignal` instances; fake/proxy/accessor-backed signal objects are rejected before use.

Separate manager instances using the same cache topology do not share the actual download/import operation. Within the same process they do coordinate cache reservations, publication/removal mutation, cleanup exclusion, active-install tracking, and overlapping finite cache limits. Overlapping installs honor the strictest active finite `maxCacheBytes`. This package does not claim a cross-process filesystem lock or download-coalescing protocol.

`maxCacheBytes` is optional. Capacity accounting includes recognized installed files, manager-owned stale staging/tombstone bytes, and in-flight reservations. Cache-level enumeration is bounded by `maxListEntries`; per-entry byte accounting fails closed after the fixed two-file managed layout rather than permitting an O(n²) hostile-cache scan. Explicit cleanup retains a separate bounded recovery traversal so flat corrupt entries can still be removed.

Capacity is checked before transfer and again immediately before publication so later cache growth cannot silently exceed the active limit. Free disk space is checked on the staging filesystem with `statfs` where supported, with write-time disk/quota errors as a backstop. There is no automatic eviction policy.

## Diagnostics compatibility

`getDiagnosticMetadata` returns only artifact ID, family ID, version, expected digest, status, and byte size. It intentionally omits source URLs and private filesystem paths. Trusted application code can request a verified installed path separately with `getInstalledPath`.

Specific model integrations, worker wiring, model selection UI, GPU discovery, Python/package installation, model execution, and runtime/provider routing are deliberately deferred. No real production model files are required by this package or its tests.
