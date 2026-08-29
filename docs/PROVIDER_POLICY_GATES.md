# Provider Policy Gates

## Purpose

Provider eligibility is decided by application-owned deterministic policy before a provider may be used. This gate separates two independent concerns:

1. whether provider data use is within the configured privacy boundary;
2. whether the configured billing mode permits the provider.

This slice does not implement or enable any real provider adapter. Provider-specific experiments still have to produce independently audited evidence before they can pass this generic gate.

## Data-use ordering

The allowed data-use ordering is:

```text
LOCAL_ONLY
  < REMOTE_NO_TRAINING
  < REMOTE_MAY_BE_USED_FOR_IMPROVEMENT
```

A provider is rejected when its declared data-use class is more permissive than `ProviderPolicy.maximumDataUse`.

This check is always performed, including when `allowMeteredUsage=true`. Paying for a provider never relaxes the privacy boundary.

## No-metered mode

When `allowMeteredUsage=false`, all of the following are required:

- billing verification is present;
- the verification passes the strict runtime `BillingVerificationSchema`;
- the enforcement mechanism and evidence adapter version are nonblank after trimming;
- the evidence adapter version exactly matches the active adapter version;
- `spendImpossible=true`;
- billing class is either `VERIFIED_FREE_ONLY` or `ACCOUNT_QUOTA`;
- the evidence timestamp is not in the future;
- the evidence age is no greater than the configured freshness maximum.

A billing label is therefore insufficient by itself. An allowed billing class still fails if the evidence does not prove technical no-spend enforcement.

`METERED` and `UNKNOWN` fail closed in no-metered mode even if malformed or contradictory evidence claims that spend is impossible.

The freshness boundary is inclusive: evidence whose age equals `billingVerificationMaxAgeMs` is current; one millisecond beyond the boundary is stale.

## Metered-enabled mode

When `allowMeteredUsage=true`, billing verification is not required by this generic gate.

The following checks still apply:

- provider policy configuration must be structurally valid;
- the active adapter version must be nonblank;
- the policy clock must be valid when supplied;
- provider data use must remain within the configured privacy maximum.

Enabling metered usage is therefore not a global bypass.

## Runtime validation

Although TypeScript callers use domain interfaces, billing evidence is accepted as untrusted runtime input by the policy boundary and is validated with `BillingVerificationSchema.safeParse`.

The gate also rejects:

- non-finite, zero, or negative billing-verification freshness windows;
- unrecognized runtime data-use policy values;
- non-boolean runtime `allowMeteredUsage` values;
- invalid application clocks;
- blank adapter versions;
- strict-schema violations such as unknown billing-evidence fields;
- invalid ISO timestamps;
- blank enforcement-mechanism/evidence-version strings.

Malformed configuration never defaults to permissive behavior.

## Deterministic rejection codes

`ProviderPolicyError.code` is one of:

- `INVALID_POLICY`
- `INVALID_ADAPTER_VERSION`
- `INVALID_CLOCK`
- `DATA_USE_EXCEEDS_POLICY`
- `MISSING_BILLING_VERIFICATION`
- `INVALID_BILLING_VERIFICATION`
- `ADAPTER_VERSION_MISMATCH`
- `SPEND_NOT_PROVEN_IMPOSSIBLE`
- `BILLING_CLASS_FORBIDDEN`
- `VERIFICATION_FUTURE`
- `VERIFICATION_STALE`

These codes are intended for application control flow and diagnostics. Error messages are fixed policy descriptions and do not include billing-evidence objects, enforcement strings, credentials, or provider response material.

## Authority and security boundary

This policy module:

- imports only domain contracts/runtime billing schema;
- creates no events;
- does not mutate session state;
- does not persist billing evidence;
- does not call a provider;
- does not perform account/network probes;
- does not infer that a provider is safe merely because it is free-labeled;
- does not weaken data-use policy when metered use is enabled.

Real provider adapters must separately demonstrate the provider-specific enforcement mechanism described by the architecture freeze. This generic gate validates evidence; it does not manufacture that evidence.
