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
- built-in metadata/factories for the existing mock and Gemini API adapters;
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
should be excluded. `createProviderConfigurationFingerprintMaterial` is deterministic and
is derived from that secret-reference-free form. It is canonical fingerprint *material*, not a
digest; diagnostics callers should hash it rather than log the material itself.

Raw credentials are obtained only at runtime through `ProviderSecretResolver`. Factories receive a frozen resolver facade scoped to the exact credential reference selected by the resolved configuration.

## Built-ins

`registerBuiltInProviders()` registers:

- `mock-model / mock-default`
- `gemini-api / gemini-2.5-flash`

The Gemini definition describes the existing adapter only. Registration does not mark Gemini
as production-approved, does not bypass provider policy, and does not change its existing
fail-closed behavior under no-metered policy.

No automatic routing, fallback, escalation, settings UI, or interview-runtime integration is
implemented here.


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
