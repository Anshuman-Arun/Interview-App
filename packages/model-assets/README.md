# Local model assets

`packages/model-assets` is a mechanical, non-authoritative byte-management boundary for versioned local artifacts. It does not execute artifacts, start workers, select interview providers, or know interview/session semantics.

## Manifest and resolution

Every artifact uses a strict schema-version-1 manifest containing stable family/artifact identifiers, version, artifact type, optional platform/architecture/variant constraints, a portable leaf filename, exact byte size, lowercase SHA-256, and an HTTP(S) provenance URL. Optional model/protocol/license/source metadata is bounded. Embedded URL credentials, path separators, Windows device filenames, unknown fields, unsafe identifiers, and malformed digests are rejected.

`resolveAssetManifest` requires an exact family/version and exact requested variant. Platform and architecture constraints are explicit compatibility predicates: a generic artifact may match any target, while platform/architecture-specific matches are preferred by specificity. Equally specific matches fail as ambiguous; unsupported targets fail explicitly.

## Cache layout

The caller supplies an absolute cache root. The manager canonicalizes it, pins the filesystem identity of the root and its two fixed managed parents, and creates only these managed namespaces:

```text
<root>/
  artifacts/<64-hex installation key>/
    manifest.json
    <portable filename>
  artifacts/.model-assets-delete-<uuid>/   # transient/removal-recovery tombstone
  tmp/<64-hex installation key>-<uuid>/
    ...staging files...
  tmp/.model-assets-delete-<uuid>/         # transient/removal-recovery tombstone
```

The installation key is a SHA-256 fingerprint of bounded artifact identity and integrity fields, so manifest strings are never used as directory names. Manifest-controlled writes are restricted to a validated portable leaf filename. The fixed `artifacts/` and `tmp/` parents must remain the same real directories and must be on the same filesystem so directory publication can use atomic rename.

Removal is bounded and flat rather than recursive. A managed entry is first atomically detached to a cache-local tombstone. Regular files and symlinks can then be unlinked without following symlink targets. Unexpected nested real directories are refused instead of recursively deleting arbitrary content. Crash-left manager tombstones can be retried by the explicit cleanup APIs.

## Install and integrity lifecycle

Remote install and local import use the same publication discipline:

```text
validated staging directory
→ bounded stream/copy into an exclusively-created payload file
→ write bounded manifest metadata
→ exact size + SHA-256 verification of the staged payload
→ reconcile an existing destination only after the replacement verified
→ revalidate staged payload/manifest identity and cache topology
→ atomic directory rename into artifacts/
→ revalidate the published directory, payload, metadata, and cache topology
→ INSTALLED
```

The manager never publishes a partially downloaded file as an installation. File and directory identities are checked around verification/publication so pathname replacement or later mutation is not silently accepted. A corrupt existing installation is not deleted merely because a repair starts: the replacement must stage and verify first. If replacement download/import fails, the old corrupt entry remains observable as corrupt.

On cancellation, timeout, network failure, size mismatch, digest mismatch, or failed publication, the active staging entry is cleaned up where safely possible. A cleanup failure leaves only manager-owned cache-local state for later explicit cleanup; it does not create a separate persisted “installed” flag.

HTTP downloads are streamed to disk with a hard artifact limit, exact manifest-size enforcement, bounded response headers, an overall timeout, cancellation, a hard redirect-depth ceiling, HTTPS-downgrade rejection, embedded-credential rejection, and cross-origin redirects disabled by default. Tests use local fixture servers rather than external model hosts.

## State, concurrency, and capacity

`inspect` derives `INSTALLED`/`CORRUPT` from the current filesystem and integrity checks; it does not persist an installed flag. Operational inspection failures are reported as `FAILED` rather than being mislabeled as corruption. `DOWNLOADING` and `VERIFYING` describe active work owned by that manager instance. The last failed attempt is disposable in-memory observational metadata and never overrides verified filesystem state.

Duplicate requests for the same artifact coalesce within one manager instance. Caller cancellation is reference-counted: cancelling one waiter does not abort work still needed by another waiter, while cancellation of the final waiter aborts that shared operation.

Separate manager instances using the same cache topology do not share a download operation. Within the same process, however, they coordinate cache reservations, publication/removal mutation, cleanup exclusion, active-install tracking, and overlapping finite cache limits. When such installs overlap, admission honors the strictest active finite `maxCacheBytes`. This package does not claim a cross-process filesystem lock/coalescing protocol; cross-process publication races remain protected by verified staging plus atomic rename/race recovery.

`maxArtifactBytes` is mandatory. `maxCacheBytes` is optional and accounts for managed installed files, manager-owned stale staging/tombstone bytes, and in-flight reservations. Capacity is checked before transfer and rechecked immediately before publication so later cache growth cannot silently exceed the active limit. Free disk space is checked on the staging filesystem with `statfs` where supported, with write-time disk/quota errors as a backstop.

There is no automatic eviction policy. Callers can remove one artifact, clear manager-owned temporary/tombstone entries, or deterministically clear unused installation keys. Enumeration and cleanup are explicitly bounded.

## Diagnostics compatibility

`getDiagnosticMetadata` returns only artifact ID, family ID, version, expected digest, status, and byte size. It intentionally omits source URLs and private filesystem paths. Trusted application code can request a verified installed path separately with `getInstalledPath`.

Specific model integrations, worker wiring, model selection UI, GPU discovery, Python/package installation, model execution, and runtime/provider routing are deliberately deferred. No real production model files are required by this package or its tests.
