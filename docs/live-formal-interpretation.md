# Live formal interpretation for Oxford reasoning

## Authority boundary

Production Oxford reasoning analysis remains a strict chain:

committed candidate language -> fallible formal interpretation -> application validation -> deterministic verifier -> authoritative evidence -> pedagogical policy.

A provider result never directly becomes correctness evidence. InterpretationCoordinator continues to require exact request/source/target/protocol binding, statement-schema validation and canonicalization, and deterministic verifier execution before any CORRECT evidence can be committed. Production adds a problem-specific target-admission layer before that verifier: the committed sentence must be relevant to the configured Oxford claim family, every numeric literal in the formal statement must be grounded in that exact committed sentence, and the statement must match the target's permitted arithmetic claim shape. A provider can propose a false but source-faithful statement; the deterministic verifier then returns CONTRADICTED. A provider cannot substitute an unrelated true arithmetic fact or import a different number from the problem prompt and turn that into target correctness.

## Provider selection

The production formal interpreter derives from the exact session-configured reasoning provider. The first supported live adapter is Antigravity CLI / Gemini 3.7 Flash Medium, reusing the application-owned supervised runtime introduced for interviewer generation.

Selection is fail-closed. The session must explicitly select the supported Antigravity provider/model, ProviderRuntimeResolver must resolve that exact selection, the normal provider policy must admit its billing/data-use behavior, and the same supervised runtime must be available. Otherwise formal interpretation returns an empty candidate set.

There is no fallback to mock, Gemini API, another paid provider, or an application default when the selected provider cannot perform formal interpretation.

## Separate request and runtime

Formal interpretation is not interviewer generation. It has a deterministic application-owned formal request identity, a dedicated no-tools formal-interpreter agent, its own native JSON schema and purpose-specific prompt, a 1.25 second supervised process budget, a 1.5 second end-to-end pre-policy analysis deadline, a 256 KiB stdout bound, a 64 KiB stderr bound, a 16,384-character aggregate formal-statement bound, and an AbortSignal propagated from supersession/timeout to the supervised process.

StudentReasoningAnalysisCoordinator still runs before pedagogical policy selection. Timeout or provider unavailability produces no new deterministic evidence and policy continues from application-owned state.

## Interpretation-specific context

The model receives only the exact candidate source text/span, the exact public Oxford problem prompt and public given information, target claim identity, protocols authorized by the Oxford formal-analysis catalog for that exact problem/version, small protocol-shape guidance, and the expected output contract.

Application provenance is deliberately not sent to or chosen by the model. Session ID, InputEpisode ID, Turn ID, event IDs, generation/request IDs, revision counters, and verification target provenance remain application-owned. After a minimal structured model proposal is parsed, the adapter attaches the exact request/source/target provenance from the authoritative request before Liam's admission layer sees the result.

The model does not receive canonical solutions, protected disclosure material, interviewer hidden reasoning graphs, credentials, unrelated prior provider output, previous conversation state, or internal session/turn/event identifiers. Candidate text is explicitly framed as untrusted data, so candidate instructions do not alter the interpreter's authority or verifier path.

## Schema contract

The Antigravity call uses native structured output and then application-side validation. The model-facing schema contains only the proposal fields the model is actually allowed to choose: candidate ID, authorized protocol reference, formal-statement JSON string, and interpretation confidence. It permits only confidence 1 and at most one atomic candidate. The model cannot emit source provenance, request/session/turn identifiers, target/evidence fields, correctness status, or application revisions because those fields are absent from the schema.

The stream parser additionally requires the exact model, dedicated formal-interpreter agent, strict permission mode, zero tools/subagents, one successful turn, exact schema echo, strict JSON with no duplicate keys or trailing prose, canonical equality between textual response and structured_output, and bounded candidate/formal-statement output. Only after that minimal payload passes parsing does the adapter attach exact application-owned request/source/target provenance and validate the resulting InterpretationProviderResultSchema object.

Inside Liam's coordinator, after the existing defensive provider parse and exact source/target/protocol checks but before deterministic verifier dispatch, application-owned Oxford admission enforces target relevance and source grounding. A request-relevance check runs after persisted-verification recovery but before fresh provider execution, so irrelevant turns do not incur model work while crash recovery remains deterministic. Candidate admission constrains the local mathematical claim shape without deciding truth: source-faithful false claims still reach the deterministic verifier and can become CONTRADICTED, while invented numerals, unrelated true arithmetic, prompt-number substitution, tautological replacements, and mixed valid/invalid candidate sets fail closed. Symbolic/deictic language that would require inventing an unstated concrete integer abstains until a richer deterministic protocol can represent it. InterpretationCoordinator remains authoritative for provider parsing, source/target/protocol identity, candidate ambiguity, statement schema/canonicalization, verifier authorization, staleness, and verification-result admission.

## Confidence and abstention

confidence means confidence that the formal object exactly represents what the candidate meant. It never means probability the mathematical claim is true. The current deterministic admission threshold remains 1, so anything less than exact interpretation confidence abstains from deterministic verification.

The prompt encourages an empty candidates array for incomplete, ambiguous, strategic, unsupported, or whiteboard-dependent statements. Whiteboard semantics are intentionally not added here.

Production asks for at most one atomic candidate. If the language needs multiple distinct interpretations, the model must abstain. The coordinator independently retains its ambiguity checks, so alternate injected providers still cannot force a choice among distinct meanings.

## Cancellation and recovery

InterpretationCoordinator.cancel() and abandon() abort a provider-owned AbortController. The provider races runtime resolution and billing/policy admission against that signal, rechecks authoritative source freshness after asynchronous control-plane boundaries, and passes the same signal into the supervised process runner. A resolver or billing verifier that ignores cancellation therefore cannot permanently consume an interpretation slot. Admission-session close is best-effort cleanup and cannot block bounded completion. Late output remains suppressed by existing current-request and verification-admission checks.

Recovery behavior is unchanged: if deterministic verification work was already durably admitted, the coordinator resumes or recomputes from the persisted application formal statement before considering provider execution. The fallible interpreter is not rerun merely because the process restarted. Repeated analysis of the same authoritative source uses the deterministic formal-analysis request identity and cached request result.

Typed input and final speech transcripts share the same committed-turn path. Interim STT text is never interpreted.

## Billing and data-use policy

Formal interpretation is real provider execution. The production adapter resolves the exact session-selected provider through ProviderRuntimeResolver and opens a guarded provider execution session solely to execute the existing billing/data-use admission. Only after that admission succeeds can the separate formal interpreter execute.

Antigravity remains denied by the default no-metered policy unless the trusted host explicitly opts into its declared billing/data-use behavior. Formal interpretation cannot bypass that rule by calling the supervised executable directly.

## Automated validation

Credential-free fixtures cover valid target-relevant interpretation leading to deterministic VERIFIED, source-faithful false interpretation leading to deterministic CONTRADICTED, unrelated arithmetic skipped before provider execution, prompt-number substitution rejected before verification, unrelated true-statement substitution rejected before verification, tautological target substitutions rejected, mixed valid/target-inadmissible candidate sets rejected as a whole, provider abstention, prompt-injection-like candidate text, trailing prose, correctness/evidence-field smuggling, provider attempts to choose application-owned provenance, tool/subagent activity, oversized output, non-finite confidence, physical cancellation, unsupported configured providers, billing/data-use denial, analysis timeout, deterministic request idempotence, repeated resolver calls that never settle without permanently exhausting capacity, and a source becoming stale while runtime resolution is in flight without sending the stale candidate text to inference.

Existing formal-admission tests continue to cover wrong source spans, previous-turn sources, unauthorized protocols, wrong problem/version, duplicate/ambiguous candidates, stale results, deterministic-verifier disagreement, and recovery of persisted verifier work.

## Real Antigravity smoke

The real smoke is intentionally separate from CI because GitHub-hosted runners must not require user credentials or a paid/subscription session.

On the trusted Windows host with the reviewed Antigravity profile available, set INTERVIEW_ALLOW_METERED_REMOTE_REASONING to 1 only after intentionally accepting the selected account's billing/data-use behavior, then run:

    corepack pnpm smoke:formal-interpretation

The command first runs the exact product launch/readiness checks so one-time executable hashing and zero-turn profile verification are not counted as interpretation latency. If the measured corpus repeatedly exceeds the 1.25/1.5 second budgets, change those bounds only with the smoke evidence recorded rather than extending the synchronous interview path speculatively. It then prints median interpretation latency, approximate worst-case latency, abstention rate, malformed-result rate, deterministic-verification acceptance rate, and per-sample statuses.

Do not report fixture timings as real-provider timings. Record the JSON emitted by this command in the PR before treating it as real latency evidence.

## Adversarial audit question

**Can any fallible provider output become authoritative mathematical correctness without deterministic verification?**

No. Provider output is schema-constrained but still untrusted. The only path to authoritative correctness remains application admission followed by an authorized deterministic verifier and verification-result admission.
