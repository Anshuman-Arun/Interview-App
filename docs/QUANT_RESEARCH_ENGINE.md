# Deterministic Quant Research Interview Engine

## Purpose

`packages/local-compute/src/quant-research/` implements a standalone, application-owned Quant Research interview subsystem. It owns seeded scenario generation, candidate action validation, exact/deterministic mechanics, stage progression, perturbations, replay, and structured numerical evidence. It deliberately does not call providers or own dialogue.

The deterministic core remains separate from Quant Trader/market-making code and provider dialogue. A narrow `QuantResearchCoordinator` in `packages/interview-engine` bridges the core to the existing `SessionWriter` append-only event path without giving providers authority over scenario mechanics.

## Definition format

Every scenario is created from an explicit definition:

```ts
{
  family: "BAYESIAN_UPDATING" | "SAMPLING_ESTIMATION" |
    "EXPERIMENTAL_ALLOCATION" | "MODEL_COMPARISON" |
    "CONSTRAINED_OPTIMIZATION",
  version: "1.0.0",
  generatorVersion: "quant-research-generator-v1",
  rngVersion: "xorshift32-rejection-v1",
  seed: number,
  config: { ...family-specific bounded configuration... }
}
```

Definitions are strict runtime-validated plain objects. `parseQuantResearchDefinition()` returns a detached, runtime-frozen canonical definition/config suitable for authoritative replay persistence. Unknown fields, accessor-backed values, unsupported scenario/generator/RNG versions, unsafe seeds, malformed bounds, deadlocked experiment budgets, no-op perturbations, non-meaningful outlier settings, zero-noise sampling/model configurations, and oversized configurations are rejected before scenario generation. Generated hidden state is then checked against family-specific invariants before use, including meaningful Bayesian updates, non-degenerate reachable samples, unambiguous experimental evidence, and perturbations that actually change the exact optimal allocation/solution.

## Deterministic seed semantics

The engine never uses ambient randomness. `DeterministicRng` is seeded from the explicit safe-integer seed plus a namespace containing the family, scenario version, generator version, and RNG version. The scenario definition itself carries both `generatorVersion` and `rngVersion`. Runtime parsing rejects incompatible generator or RNG semantics rather than silently replaying a persisted seed under a different implementation. All random-looking observations and latent parameters are generated during initialization. State inspection does not consume RNG state.

Identical `(family, version, generatorVersion, rngVersion, seed, config)` inputs therefore produce identical hidden state and, for an identical ordered action sequence, identical public state, evidence, and result. Public state/results/diagnostics retain the non-secret scenario/generator/RNG compatibility tuple so replay identity is not reduced to the scenario version alone. The compatibility registry is likewise keyed by the full tuple and is bounded independently of the family count so historical implementations can coexist for replay. Golden version-1 fixtures pin representative generated instances so an RNG/generator change cannot silently retain the same compatibility tuple.

## Hidden, public, and authoritative state

The implementation separates four concerns:

- **Application-hidden mechanics**: latent means/models/centers, unrevealed observations, deterministic sample ordering, exact optima, and other scoring references.
- **Candidate-visible state**: `getState()` returns only the current prompt, deliberately revealed data, stage/status, and public resource limits. It never returns numerical scoring evidence while the interview is still in progress.
- **Authoritative engine state**: accepted structured actions, current stage, revealed observations/summaries, deterministic evidence, and completion status.
- **Authoritative persistence snapshot**: `getAuthoritativePersistenceSnapshot()` deliberately contains generated hidden parameters, exact grading references, and `QUANT_RESEARCH_VERIFIER_VERSION`. This application-only record is persisted for reproducibility and tamper detection. It must never be projected into candidate/provider context.

`getDiagnostics()` is intentionally narrow and does not return the seed, configuration, latent truth, unrevealed observations, or exact scoring references. While a scenario is in progress, `getResult()` returns only status/identity/action count plus empty metrics/evidence; final deterministic evidence is released only after completion. `getState()`/`getResult()` return detached structured clones so caller mutation cannot alter engine state. `getAcceptedActions()` returns a fresh runtime-frozen canonical action list suitable for persistence rather than a mutable clone of authoritative history.

The coordinator persists the canonical definition returned by `parseQuantResearchDefinition()`, not a caller-owned mutable input object, together with the application-only authoritative persistence snapshot. The engine does not expose a convenience definition getter. Provider/candidate projection remains limited to `getState()`; the persisted seed, generated parameters, and grading references stay behind the application-owned event boundary.

## Candidate action protocol

Supported strict actions are:

- `SUBMIT_PROBABILITY`
- `REQUEST_OBSERVATION`
- `SUBMIT_NUMERIC_ESTIMATE`
- `ALLOCATE_SAMPLE`
- `CHOOSE_OPTION`
- `SUBMIT_PARAMETERS`

Every action requires an `actionId` matching a bounded safe identifier format. `parseQuantResearchAction()` returns a detached runtime-frozen canonical action (including a frozen parameter vector when present). Validated numeric values are canonicalized so JavaScript negative zero is stored as ordinary zero, preserving identity across JSON-style persistence/replay. Actions reject unknown fields and malformed numeric values, including NaN, infinity, unsafe/non-integral counts, numeric estimates/parameters outside the finite `[-1_000_000, 1_000_000]` domain, sparse/accessor-backed vectors, out-of-domain probabilities, oversized vectors, invalid options, and impossible stage/action combinations.

Accepted action IDs are unique within a scenario. Reuse is rejected. Definition/action/registry/replay validation rejects synchronous reentrancy triggered by hostile Proxy traps. Candidate transitions compute and clone their public transition projection before committing authoritative state, so validation/projection failures do not leave a partially committed action. Every accepted transition also revalidates family-specific stage/history invariants: fixed-flow families require the exact legal action-kind and evidence sequence for the current stage, while sampling requires a request-only prefix whose counts exactly reproduce the revealed deterministic prefix followed by the allowed estimate actions. Stored stage data such as the experimental initial allocation and model first choice is cross-checked against the corresponding accepted action.

## Scenario families

### Bayesian updating

A Beta/Bernoulli interview moves through prior predictive calibration, a revealed deterministic observation batch, a posterior update, and a changed-prior perturbation. Count arithmetic is kept exact through a narrow internal rational seam before conversion for candidate-facing probability comparison.

### Sampling and estimation

The candidate chooses how many observations to request from a seeded finite population, commits an estimate of the latent center, then revises after a disclosed contamination/outlier perturbation. Sample-efficiency credit reflects both observation economy and the achieved numerical quality, so stopping early with an unusable estimate is not treated as efficient. Evidence includes numerical correctness, sample efficiency, adaptation, and robustness.

### Experimental allocation

The candidate allocates a bounded budget between two noisy experiments, with every comparison allocation requiring at least one observation from each arm, sees deterministic sample summaries whose ordering is validated not to contradict the latent mean ordering, selects the higher-mean option, and then reallocates after experiment costs change. The information objective is the reciprocal variance of the estimated mean difference, using the exact variance of the engine's discrete-uniform noise model; allocation quality is compared with the exact bounded frontier under the same feasibility rules as the candidate action.

### Model comparison

The candidate distinguishes a constant versus linear latent data-generating family from deterministic noisy observations and reassesses after a single disclosed outlier perturbation. The generated intercept and slope remain private authoritative parameters. Initialization validates their generator bounds and verifies every baseline point lies within the disclosed additive-noise radius of that exact latent trend; linear instances also use the disclosed minimum slope magnitude, making the baseline families deterministically distinguishable. After perturbation, the public state preserves both baseline and perturbed observations. Evidence captures initial correctness, robustness, and consistency.

### Constrained optimization

The candidate chooses two nonnegative integer parameters for a seeded linear/interacting objective under explicit box and budget constraints, then adapts after budget/penalty changes. Generated variants are rejected if the base and perturbed problems share an exact optimum, so an unchanged optimal answer cannot receive full adaptation credit. The engine enumerates the bounded feasible set to own the exact optimum and objective-quality evidence.

## Evidence and scoring

The engine emits deterministic structured evidence rather than pretending to grade communication from text. Evidence categories include:

- numerical correctness;
- calibration;
- adaptation;
- sample efficiency;
- consistency;
- objective quality;
- constraint discipline;
- robustness.

Evidence scores are bounded to `[0, 100]`. For exact allocation/optimization objectives, a non-optimal solution is capped below 100 even if a percentage ratio would otherwise round upward; category and overall aggregation likewise return 100 only when every constituent score is 100. Repeated evidence within a category is averaged first, then the final overall score averages the category-level metrics so a category does not gain accidental weight merely by appearing at more stages. Post-perturbation adaptation scores reflect quality under the changed conditions rather than rewarding an unchanged poor answer. The summaries describe what was checked without revealing the hidden reference value.

Threshold comparisons use a small machine-precision allowance so mathematically symmetric answers on a scoring boundary are not split solely by binary floating-point representation. Bayesian posterior/update perturbation scores combine absolute numerical tolerance with progress from the stale reference toward the changed target; simply repeating the old prior/posterior therefore receives zero update/adaptation credit.

## Persistence and replay

The vertical slice uses the repository's existing authoritative persistence path rather than a parallel store. `QuantResearchCoordinator` is layered above the deterministic core and writes only through `SessionWriter`; `SessionWriter` remains the sole authority allowed to append to the WAL-backed SQLite `session_events` stream.

A fresh Quant Research session atomically records:

1. `SESSION_STARTED`;
2. `PROBLEM_PRESENTED`, where the family is the v1 template/problem ID and the scenario version is the problem version; and
3. `QUANT_RESEARCH_SCENARIO_INITIALIZED`, containing the canonical definition plus the generated-parameter/grading snapshot and deterministic verifier version.

Each accepted candidate action records one `QUANT_RESEARCH_ACTION_ACCEPTED` event. The final accepted action atomically records the action, `QUANT_RESEARCH_SCENARIO_COMPLETED` with deterministic rubric evidence/result, and `SESSION_COMPLETED`. Historical events are never rewritten by the coordinator.

The persisted initialization record carries the reproducibility tuple required for parameterized problems: template/family ID, scenario/problem version, generator version, RNG implementation/version, seed, generated parameters, validated grading references, and verifier version.

Pure replay remains available through `replayQuantResearch(definition, actions)`. Durable session replay uses `replayQuantResearchSessionState()` / `QuantResearchCoordinator.replay()`: it regenerates the scenario from the stored canonical definition, compares the regenerated hidden snapshot against the stored one, reapplies every action in sequence through normal validation/transitions, and requires any stored completion result to match the independently recomputed deterministic result. Schema-valid tampering of hidden generated parameters, actions, compatibility metadata, or grading results therefore fails closed rather than silently becoming new authority.

Replay inputs and persisted arrays are bounded to the same scenario/action resource domains.

## Resource limits

Current hard bounds include:

- 32-bit unsigned safe seed domain;
- maximum 64 accepted actions;
- maximum 64 compatibility-registry entries;
- maximum 32 observations requested by any one action/config path;
- bounded populations and observation vectors;
- maximum eight numeric parameters per generic parameter action;
- finite numeric estimate/parameter domain of `[-1_000_000, 1_000_000]`;
- bounded experiment budgets/costs/noise;
- bounded optimization dimensions and brute-force search domain;
- action identifiers limited to 64 safe characters.

Family transitions enforce tighter semantic limits where appropriate.

## Intentionally deferred integration

This PR does not implement:

- Quant Trader interview behavior;
- provider/model dialogue for Quant Research;
- generic `TurnCoordinator` text-answer translation into structured Quant actions;
- UI mode selection;
- voice, vision, whiteboard, or Electron wiring;
- generic language-model post-session evaluation.

The authoritative SessionWriter/SQLite event-log integration required by this Quant Research vertical slice is implemented here. Future UI/provider work should call the coordinator and project only its public `state`/`result`, never the authoritative persistence snapshot.
