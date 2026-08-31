# Provider control plane

This package separates provider description/configuration from provider execution policy.

## Public surface

The control plane provides:

- stable provider/model identities and immutable registered definitions;
- tri-state capability declarations, with unknown support kept explicit;
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
Provider-specific `settings` are JSON-safe and reject secret-like keys such as API keys,
tokens, cookies, passwords, and authorization fields.

Use `toPersistableProviderConfiguration` before export/persistence when secret references
should be excluded. `createProviderConfigurationFingerprintMaterial` is deterministic and
is derived from that secret-reference-free form.

Raw credentials are obtained only at runtime through `ProviderSecretResolver`.

## Built-ins

`registerBuiltInProviders()` registers:

- `mock-model / mock-default`
- `gemini-api / gemini-2.5-flash`

The Gemini definition describes the existing adapter only. Registration does not mark Gemini
as production-approved, does not bypass provider policy, and does not change its existing
fail-closed behavior under no-metered policy.

No automatic routing, fallback, escalation, settings UI, or interview-runtime integration is
implemented here.
