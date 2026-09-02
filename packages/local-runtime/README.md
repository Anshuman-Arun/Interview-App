# Local Runtime Lifecycle Manager

`packages/local-runtime` is a non-authoritative process lifecycle layer for local workers and model processes. It owns process mechanics only: registration, spawning, readiness, bounded diagnostics, restart limits, and shutdown. It does not own interview state, provider routing, model installation, speech semantics, or the existing local-compute request/response protocol.

## Lifecycle

A component moves through explicit `STOPPED`, `STARTING`, `READY`, `DEGRADED`, `STOPPING`, and `FAILED` states. `start()` calls for the same component coalesce onto the same in-flight startup operation. A process is never considered ready merely because `spawn()` succeeded.

Readiness strategies are pluggable and bounded by `startupTimeoutMs`:

- `STABLE_PROCESS`: the child must remain alive for a configured interval;
- `STDOUT_LINE`: trusted application code evaluates bounded, untrusted stdout lines;
- `STDOUT_JSON`: the manager parses a bounded line as JSON and passes `unknown` to the evaluator; malformed JSON is ignored rather than trusted;
- `HTTP_LOOPBACK`: polling is restricted to loopback HTTP, `localhost` is canonicalized to literal `127.0.0.1`, redirects are rejected, and injected fetch results are branded/inspected through intrinsic `Response` accessors before readiness logic uses them;
- `CUSTOM_LOCAL`: a trusted backend callback/probe can report readiness without giving the browser process access to spawning; callers remain responsible for keeping custom probe behavior local.

Readiness decisions may also carry a version handshake containing component, protocol, model/hash, and capability metadata. Definitions can require expected component/protocol versions; mismatches fail startup.

`DEGRADED` is observational only. `markDegraded()`/`markReady()` let a future local health monitor reflect process health without creating authoritative interview state.

## Spawning and environment

Commands are always represented as an executable plus argument array and are spawned with `shell: false`. The API has no arbitrary shell-string surface and is not exported to renderer/browser code.

The child environment is built from a platform-specific safe inheritance allowlist plus caller-selected inherited names, explicit non-secret values, and runtime-only secret values. Definitions and environment records are inspected as data-only structures and snapshotted before use, so later caller mutation or accessor-backed configuration cannot change execution. An explicitly injected parent environment is validated and snapshotted when the manager is constructed; the ambient process environment is filtered into a fresh per-component child environment at registration. The parent environment is never blindly copied into a worker, and environment definitions are never returned in status snapshots.

Runtime-only secret values are actively removed from captured output, readiness/failure details, and handshake metadata (including metadata keys) in addition to the repository diagnostics sanitizer. Status snapshots therefore expose no raw environment map or secret values.

## Output and crash records

Stdout/stderr are framed as bounded UTF-8 lines using a fixed per-line buffer, so hostile fragmentation cannot create unbounded allocation growth or repeated whole-line copying. Oversized or invalid lines become diagnostic markers instead of causing unbounded accumulation. Recent output is limited by both line count and byte count and carries a truncation marker after eviction when the configured byte budget can hold the full marker.

Unexpected exits record exit code, signal where available, timestamp, previous lifecycle state, and a sanitized bounded stderr tail. Retained output is evicted in bounded amortized time so sustained worker chatter cannot turn the line cap into repeated whole-buffer shifts. Output is observational diagnostics only.

## Restart policy

The default policy is `NEVER`. `ON_FAILURE` requires an explicit finite retry budget (capped at 100 retries) and supports bounded exponential backoff. The retry budget is shared across startup failures and later crashes until an explicit new `start()`/`restart()` operation resets it, preventing a process that repeatedly becomes ready and crashes from restarting forever. Deterministic version mismatches and invalid readiness/handshake contracts fail closed without consuming automatic retries; transient non-ready observations continue polling until the bounded startup timeout.

## Shutdown

`stop()` is idempotent. It requests graceful shutdown (EOF by default or a trusted local callback), waits `shutdownTimeoutMs`, escalates to termination, and then force-kills when necessary. A never-resolving asynchronous graceful hook cannot block escalation. On POSIX, managed children are placed in their own process group so escalation can target the tree. On Windows, bounded tree termination uses the absolute System32 `taskkill.exe` path with `/T`, adding `/F` for final force, and never enables Node's shell option.

`stopAll()` stops components sequentially in reverse registration order and waits for each managed child to terminate. It continues attempting to stop the remaining components if one fails, then reports an aggregate failure rather than returning success while a known managed child is still alive.

Node core cannot create Windows Job Objects, and no portable API can retain a durable Windows tree handle after the root process exits. Tree-aware `taskkill /T` escalation is therefore verified when escalation owns a live root process; if that mechanism is unavailable, shutdown fails closed rather than treating a root-only kill as proof that descendants are gone. A component with unverified residual-tree cleanup cannot be started again until cleanup can be verified. A Windows root that exits before tree-aware escalation cannot provide the same descendant-absence guarantee through Node core alone. Local components must not daemonize or intentionally leave long-lived descendants behind.

## Supervised one-shot execution

`SupervisedProcessRunner` is a separate one-shot process boundary for adapters that need a
fresh bounded child process per request rather than a long-lived ready/degraded component.

Executable definitions are registered by trusted application code and snapshotted before use.
The public execution request identifies only a registered executable ID plus bounded arguments,
stdin, output budgets, deadline, and cancellation signal; it cannot supply an executable path,
working directory, environment, or home-profile contents. Executables must be absolute regular
files and symbolic-link indirection is rejected. If the executable exists at runner construction,
its device/inode/size/mtime identity is pinned immediately; if it is initially unavailable, the
first successful execution pins it. Every later execution must match the pinned identity before
spawn and is checked again immediately after spawn, so upgrades/replacements require an explicit
application-runtime restart and detectable replacement races fail closed.

Each execution uses `shell: false`, bounded stdin/stdout/stderr, fatal UTF-8 validation for
returned stdout, and optional private temporary working directories. Definitions may also request
a fresh isolated home directory populated only with a bounded set of application-owned files.
Home/profile environment variables are redirected to that temporary directory for the child and
the directory is removed after every execution, preventing provider conversation/settings state
from crossing turns through ordinary home-profile files. Stderr content is never returned through
the result surface. Timeout, cancellation, output-budget violations, unsafe executable
replacement, and unverifiable isolation cleanup fail closed.

On POSIX, each one-shot process receives its own process group. Cancellation escalates from
group SIGTERM to SIGKILL, and a normally exiting root is followed by a residual process-group
check so descendants cannot intentionally remain in that owned group.

On Windows, cancellation uses the same absolute System32 `taskkill.exe /T` mechanism as the
long-lived manager while the root process is alive. Node core still cannot prove descendant
absence after a Windows root exits before tree-aware cleanup owns it; one-shot providers must
therefore not intentionally daemonize or detach descendants. A provider requiring a stronger
Windows guarantee must use a runtime with Job Object ownership rather than claiming this runner
provides that guarantee.

The one-shot boundary is non-authoritative. It does not parse provider semantics, own interview
state, or decide billing/data-use policy.

## Relationship to local-compute

`packages/local-compute` keeps its existing bounded NDJSON protocol and admission behavior unchanged in this PR. A later integration can use `LocalRuntimeManager` to own the Python worker process while retaining the existing protocol client, without changing the worker schema or interview semantics.

No Ollama, Moonshine, Kokoro, Silero, GPU discovery, downloads, remote execution, or model-specific startup behavior is implemented here.
