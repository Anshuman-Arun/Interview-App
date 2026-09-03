# Live Oxford formal interpretation

## Authority model

Production Oxford analysis remains:

```text
committed candidate language
    -> fallible formal interpreter
    -> application schema/source/protocol admission
    -> deterministic verifier
    -> authoritative evidence
    -> pedagogical policy
```

The interpreter is never a correctness oracle. Interpretation confidence means only confidence that the proposed formal object represents what the candidate meant. Liam's deterministic admission currently requires confidence `1`, so the live adapter asks the provider to emit a candidate only when that interpretation is fully unambiguous and to abstain otherwise. This threshold is about interpretation fidelity, not mathematical correctness. A provider cannot commit evidence, cannot mark a claim verified, and cannot bypass `InterpretationCoordinator` or the deterministic verifier registry.

## Provider selection and policy

The default live adapter derives formal interpretation identity from the session's explicitly configured reasoning provider. The only production provider currently supported for this purpose is the supervised Antigravity `gemini-3.7-flash-medium` runtime supplied by the provider work in PR #100.

There is no hidden provider fallback. Mock, legacy/unconfigured, unsupported, unavailable, or differently selected providers abstain unless the application explicitly injects another `FormalInterpretationProvider`.

Before a real interpretation inference starts, the selected provider is resolved by `ProviderRuntimeResolver` and admitted through `openProviderExecutionSession`. This preserves the normal provider availability, capability, data-use, metered-usage, billing-verification, and runtime policy boundary. A policy or runtime failure becomes an interpretation abstention; it does not fall back to mock execution.

The production composition creates one `ApplicationProviderAdapterRuntimeSource` and shares it between interviewer generation and formal interpretation. The formal adapter therefore reuses the #100 `SupervisedProcessRunner` and executor rather than creating another raw CLI supervisor. The Windows runtime source returns one stable frozen runtime object for repeated resolution of the selected Antigravity model; CI asserts that stability.

## Separate purpose-specific call

Formal interpretation is a distinct provider request, not interviewer realization and not Delivery generation. Antigravity receives a dedicated `formal-interpreter` agent with:

- no tools;
- no subagents;
- inherited customizations disabled;
- the same restricted application-owned runtime profile;
- its own bounded process timeout and byte limits;
- a request-specific JSON schema.

The prompt contains only:

- the exact committed source identity and source span;
- the public problem prompt and given information needed for disambiguation;
- the exact allowed formal protocol identities for that problem/version;
- compact syntax guidance for supported protocols;
- the strict result contract.

It does not include the canonical solution, protected disclosures, interviewer hidden reasoning, unrelated model output, credentials, or board-image semantics.

Candidate text is explicitly delimited as application data. Instructions embedded in candidate text, including requests to output `VERIFIED`, have no authority.

## Schema and bounds

The provider must return the existing `InterpretationProviderResultSchema` shape. The Antigravity call additionally supplies a request-specific JSON schema that fixes the request/source/target identity and restricts protocols to the exact Oxford analysis profile.

Production currently asks for at most one independently verifiable atomic claim per call. Liam's existing admission semantics treat multiple distinct candidates as ambiguous, so the model is instructed to choose one clear atomic claim or abstain rather than manufacture a compound interpretation. The request-specific schema also fixes candidate confidence to `1`; if interpretation confidence would be lower, the model must return `candidates: []`. This remains below the domain-wide candidate bound and prevents claim explosion.

Extra provider fields, prose around JSON, wrong request/source/problem/version identity, unsupported protocols, non-finite confidence, oversized output, tool activity, schema disagreement, and malformed formal statements are rejected or safely abstained. The application does not heuristically repair malformed formal syntax into something that happens to verify.

## Abstention

`candidates: []` is a normal outcome. The model is instructed to abstain for strategy comments, incomplete or ambiguous ideas, unsupported theorem statements, uncertain pronouns, or text that depends on an unresolved whiteboard reference.

No board image is sent in this PR. Board semantic observations remain Agent Noah's responsibility and can be combined with language only through a future authoritative-source integration.

## Timing, cancellation, and stale results

The outer student-reasoning budget remains 1.5 seconds. The supervised formal subprocess request has a 1.25-second process budget plus bounded stdout/stderr/stdin sizes.

`StudentReasoningAnalysisCoordinator` continues to abandon a request on timeout or source supersession. It now also asks cancellable formal providers to abort local execution best-effort. Shutdown uses the same path. `InterpretationCoordinator` remains authoritative for suppressing late/stale results, so physical cancellation success is never required for safety.

Typed input and final speech transcripts converge at the same committed-turn analysis path. Interim STT text is not interpreted.

## Recovery

The existing deterministic request/source identity and Liam's recovery semantics are unchanged. Already admitted deterministic verification work resumes from the persisted application-owned formal statement. The application does not rerun the fallible interpreter merely because deterministic verification can be recomputed after recovery.

Provider disappearance during a session causes new formal analysis to abstain. Previously committed deterministic evidence remains authoritative.

## Validation and smoke testing

Automated tests use deterministic provider/runtime fixtures; CI does not require Antigravity credentials. The focused tests cover:

- a supported claim that becomes deterministic `VERIFIED` evidence;
- a mathematically false claim that becomes deterministic `CONTRADICTED` with no false correctness evidence;
- prompt-injection-like candidate text requesting `VERIFIED`;
- provider attempts to add an authoritative correctness field;
- unauthorized protocol output;
- provider policy/runtime denial before inference;
- no-metered billing denial before subprocess execution;
- exact echoed source-span mismatch;
- trailing prose around otherwise valid JSON;
- physical subprocess abort on cancellation;
- stable shared Antigravity runtime identity on Windows;
- the dedicated no-tools Antigravity agent profile;
- existing formal source/protocol/staleness/recovery tests in the repository.

A real-provider performance smoke must be run on the supported Windows host with Antigravity 1.1.25 and the same configured account/policy used for interviews. CI intentionally cannot supply those credentials. Record at least several short supported claims plus strategy/ambiguous statements and report:

| Metric | Manual smoke result |
| --- | --- |
| Median interpretation latency | Not measured in credential-free CI |
| Approximate worst case below the application timeout | Not measured in credential-free CI |
| Abstention percentage on curated corpus | Not measured in credential-free CI |
| Malformed-result frequency | Not measured in credential-free CI |
| Deterministic verification acceptance rate | Not measured in credential-free CI |

Do not replace these with fixture timings: fixture latency does not measure the real provider. The safety behavior on timeout is already deterministic: formal analysis abstains and policy proceeds.

## Adversarial audit

Central question: **Can any fallible provider output become authoritative mathematical correctness without deterministic verification?**

**No.** Provider output can only propose an interpretation. Request-specific structured-output constraints are followed by application-owned schema/source/protocol admission, formal-statement canonicalization, deterministic verifier dispatch, and evidence admission. A provider's prose, confidence, attempted `VERIFIED` field, or apparent mathematical implication is never itself authoritative evidence.
