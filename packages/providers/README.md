# Provider control plane

This package separates provider description/configuration from provider execution policy.

## Public surface

The control plane provides:

- stable provider/model identities and immutable registered definitions;
- tri-state capability declarations, with unknown support kept explicit and distinct from known incompatibility;
- deterministic provider/model enumeration and lookup;
- validated, export-safe provider configuration;
- opaque runtime secret references and a credential resolver boundary;
- informational readiness states;
- deterministic capability requirement matching and configuration resolution;
- adapter-factory resolution without executing interview turns;
- built-in metadata/factories for the mock, Gemini API, and supervised Antigravity CLI adapters;
- plain diagnostics metadata and deterministic configuration fingerprint material.

## Safety boundary

Registration, configuration, readiness, and adapter-factory availability are descriptive only.
They do not authorize provider execution.

All actual provider work must still pass through the existing provider execution/policy path,
including data-use and metered-usage enforcement, billing verification, cancellation handling,
and output validation.

An `AVAILABLE` readiness state therefore means only that the configured provider appears
mechanically usable. It does not mean a particular interview context is approved to leave the
application.

## Configuration and secrets

`ProviderConfiguration` may contain an opaque `credentialRef`, but never raw credentials.
Provider-specific `settings` are bounded, plain JSON data. Validation rejects accessors,
prototype-bearing/special-key objects, cycles, sparse or side-property arrays, non-finite values,
oversized structures, credential-like keys, and common credential payloads. Provider-specific
validators are required to return data that passes the same validation again. Sanitized control-plane records use null prototypes so absent optional fields cannot be reintroduced through inherited prototype pollution.

Use `toPersistableProviderConfiguration` before export/persistence when secret references
should be excluded; the result remains valid provider-configuration data with the reference
removed. `createProviderConfigurationFingerprintMaterial` is deterministic and additionally
retains only the non-secret credential purpose so API-key/token modes remain distinguishable
without exposing which credential is selected. It is canonical fingerprint *material*, not a
digest; diagnostics callers should hash it rather than log the material itself.

Raw credentials are obtained only at runtime through `ProviderSecretResolver`. Factories receive a frozen resolver facade scoped to the exact credential reference selected by the resolved configuration.

## Built-ins

`registerBuiltInProviders()` registers:

- `mock-model / mock-default`
- `gemini-api / gemini-2.5-flash`
- `antigravity-cli / gemini-3.7-flash-medium`

The Gemini definition describes the existing API-key adapter only. Registration does not mark
Gemini as production-approved, does not bypass provider policy, and does not change its existing
fail-closed behavior under no-metered policy.

The Antigravity definition describes the documented headless `agy` CLI contract rather than
a generic shell command. It uses one fresh process per reasoning turn, one `stream-json`
`user` event on stdin, native JSON-schema structured output, and no `--continue` or
`--conversation` state. The adapter rejects tool/subagent events and validates the terminal
`structured_output` again with the application-owned `InterviewerProposalSchema`. Process
execution is injected by the trusted server/local-runtime layer; provider configuration cannot
choose an executable path or arbitrary process environment.

Antigravity authentication is deliberately outside provider/session state. The trusted runtime
relies only on the CLI's documented OS-native keyring sign-in and does not inspect, copy, persist,
or return those credentials.
Before using this provider, run `agy` interactively once outside Interview App and complete
sign-in. A supervised/headless interview does not perform onboarding; if cached authentication is
unavailable, the CLI exits and the turn fails closed.

On Windows, validate that the production isolation boundary can still recover that cached
Credential Manager session without starting a model turn:

```bash
corepack pnpm smoke:antigravity-readiness
```

The smoke first launches the exact production stream-json argument set and sends a deliberately
unsupported control message. Antigravity must emit the pinned `init` envelope (empty tool list,
strict permission mode, exact agent/model/schema) and terminate with a zero-turn `ERROR` result,
so the resolved tool surface is verified without model inference. It then runs the read-only
`/usage` command with the same agent/model selections to verify cached authentication and quota
lookup. The smoke checks piped-process shutdown as well and deliberately does not print any
account/quota payload. Each supervised turn receives a fresh temporary CLI profile rather
than the user's normal `~/.gemini` profile. That profile pins strict tool review,
non-workspace access off, AI-credit fallback off, telemetry off, an empty custom-agent tool list,
and deny-all fine-grained permission rules. The concrete Windows path does not depend on
Antigravity terminal sandbox mode because that CLI feature is not currently supported on Windows.
The isolated profile does not inherit the user's normal CLI customizations; instead it contains
one application-owned documented custom agent with an empty tool list and subagent invocation
disabled. Runtime admission additionally requires the CLI's `init.tools` list to be empty.
The CLI self-updater is disabled for the supervised child.

Antigravity remains a remote inference path even though the client process is local. Its model
capabilities therefore declare both local process execution and remote execution, conservative
remote data use, and unknown metered-execution status. The standalone adapter remains fail-closed
under no-metered policy unless a trusted runtime supplies current billing evidence.

The concrete Windows application runtime requires the audited `agy 1.1.25` stream-json
contract, including the later 1.1.x fixes for restored-keyring account state,
headless stream integrity, and piped stdout/stderr shutdown. forces AI-credit fallback off, leaves `modelProvider` absent, and does not inherit
API-key/custom-endpoint environment variables. The CLI still authenticates through its OS-native
account keyring, which can represent subscription, enterprise, or Google Cloud project modes.
Those local profile restrictions therefore do not prove that incremental spend is technically
impossible. The production runtime does not fabricate `ACCOUNT_QUOTA` evidence; default
no-metered policy fails closed before remote inference. Personal use requires the trusted-host
opt-in `INTERVIEW_ALLOW_METERED_REMOTE_REASONING=1`, which permits metered-unknown execution
without weakening the separately enforced remote data-use boundary.

No automatic routing, fallback, escalation, provider settings UI, or secret-bearing session
configuration is implemented here.


## Registration and factory hardening

Provider definitions are validated as plain data, reject duplicate provider/model identities and
internally contradictory capability declarations, and are copied/frozen at registration. Batch
registration is atomic. Executable definitions bind a declared adapter version to a captured
factory function.

Adapter creation remains descriptive setup, not execution admission. A resolved factory accepts
only control-plane resolutions, converts factory/credential failures to fixed typed errors, and
checks the returned adapter's execution identity/capabilities against registered metadata where
the existing `ReasoningProvider` interface exposes a corresponding fact. It still does not call
`createSession()`; production session creation remains exclusively behind the existing provider
execution/policy boundary.


## Supervised CLI trust boundary

`SupervisedCliReasoningProvider` is the reusable provider-side half of the CLI boundary. It
knows only a narrow injected executor contract: bounded argument strings, bounded stdin,
bounded stdout/stderr byte budgets, an execution deadline, cancellation signal, and a
process-start acknowledgement. It cannot import child-process APIs or select an executable.

The trusted process half lives in `packages/local-runtime`. The concrete Antigravity desktop
runtime is currently Windows-only: Windows execution uses an application-owned Job Object
bootstrap so the provider is created suspended, assigned to a kill-on-job-close containment
object before it executes, and given only stdin/stdout/stderr handles. Non-Windows application
composition fails closed instead of claiming POSIX process-group containment is equivalent for
hostile descendants that can re-session themselves.

This split preserves the frozen architecture rule that provider adapters are untrusted
realization engines and do not gain general filesystem/process authority. Future Ollama,
llama.cpp, or Codex-like adapters can reuse the same executor seam while defining their own
application-owned executable identities and exact output protocols.
