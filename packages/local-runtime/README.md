# Local Runtime Lifecycle Manager

`packages/local-runtime` is a non-authoritative process lifecycle layer for local workers and model processes. It owns process mechanics only: registration, spawning, readiness, bounded diagnostics, restart limits, and shutdown. It does not own interview state, provider routing, model installation, speech semantics, or the existing local-compute request/response protocol.

## Lifecycle

A component moves through explicit `STOPPED`, `STARTING`, `READY`, `DEGRADED`, `STOPPING`, and `FAILED` states. `start()` calls for the same component coalesce onto the same in-flight startup operation. A process is never considered ready merely because `spawn()` succeeded.

Readiness strategies are pluggable and bounded by `startupTimeoutMs`:

- `STABLE_PROCESS`: the child must remain alive for a configured interval;
- `STDOUT_LINE`: trusted application code evaluates bounded, untrusted stdout lines;
- `STDOUT_JSON`: the manager parses a bounded line as JSON and passes `unknown` to the evaluator; malformed JSON is ignored rather than trusted;
- `HTTP_LOOPBACK`: polling is restricted to loopback HTTP, `localhost` is canonicalized to literal `127.0.0.1`, and redirects are rejected;
- `CUSTOM_LOCAL`: a trusted backend callback/probe can report readiness without giving the browser process access to spawning; callers remain responsible for keeping custom probe behavior local.

Readiness decisions may also carry a version handshake containing component, protocol, model/hash, and capability metadata. Definitions can require expected component/protocol versions; mismatches fail startup.

`DEGRADED` is observational only. `markDegraded()`/`markReady()` let a future local health monitor reflect process health without creating authoritative interview state.

## Spawning and environment

Commands are always represented as an executable plus argument array and are spawned with `shell: false`. The API has no arbitrary shell-string surface and is not exported to renderer/browser code.

The child environment is built from a platform-specific safe inheritance allowlist plus caller-selected inherited names, explicit non-secret values, and runtime-only secret values. Definitions and environment records are inspected as data-only structures and snapshotted at registration, so later caller mutation or accessor-backed configuration cannot change execution. The parent environment is never blindly copied, and environment definitions are never returned in status snapshots.

Runtime-only secret values are actively removed from captured output, readiness/failure details, and handshake metadata (including metadata keys) in addition to the repository diagnostics sanitizer. Status snapshots therefore expose no raw environment map or secret values.

## Output and crash records

Stdout/stderr are framed as bounded UTF-8 lines using a fixed per-line buffer, so hostile fragmentation cannot create unbounded allocation growth or repeated whole-line copying. Oversized or invalid lines become diagnostic markers instead of causing unbounded accumulation. Recent output is limited by both line count and byte count and carries a `[TRUNCATED]` marker after eviction.

Unexpected exits record exit code, signal where available, timestamp, previous lifecycle state, and a sanitized bounded stderr tail. Output is observational diagnostics only.

## Restart policy

The default policy is `NEVER`. `ON_FAILURE` requires an explicit finite retry budget (capped at 100 retries) and supports bounded exponential backoff. The retry budget is shared across startup failures and later crashes until an explicit new `start()`/`restart()` operation resets it, preventing a process that repeatedly becomes ready and crashes from restarting forever. Deterministic version mismatches are not automatically retried.

## Shutdown

`stop()` is idempotent. It requests graceful shutdown (EOF by default or a trusted local callback), waits `shutdownTimeoutMs`, escalates to termination, and then force-kills when necessary. A never-resolving asynchronous graceful hook cannot block escalation. On POSIX, managed children are placed in their own process group so escalation can target the tree. On Windows, bounded tree termination uses the absolute System32 `taskkill.exe` path with `/T`, adding `/F` for final force, and never enables Node's shell option.

`stopAll()` stops components sequentially in reverse registration order and waits for each managed child to terminate. It continues attempting to stop the remaining components if one fails, then reports an aggregate failure rather than returning success while a known managed child is still alive.

Node core cannot create Windows Job Objects, and no portable API can control descendants that deliberately daemonize/disassociate from the managed process tree. Local components are therefore required not to daemonize; ordinary child trees are handled by the escalation path above.

## Relationship to local-compute

`packages/local-compute` keeps its existing bounded NDJSON protocol and admission behavior unchanged in this PR. A later integration can use `LocalRuntimeManager` to own the Python worker process while retaining the existing protocol client, without changing the worker schema or interview semantics.

No Ollama, Moonshine, Kokoro, Silero, GPU discovery, downloads, remote execution, or model-specific startup behavior is implemented here.
