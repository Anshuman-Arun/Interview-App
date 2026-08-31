# Curated Problem Authoring

## Purpose

Main interview questions are curated application-owned content. They are not generated dynamically at runtime. This authoring layer makes new Oxford Mathematics and Quant problems consistent while preserving the existing `InterviewProblem` runtime contract.

## Runtime-schema boundary

The current domain schema has first-class fields for the public prompt, given information, topics, difficulty, reasoning graph, protected disclosures, canonical solution, and verification notes. It does **not** have first-class fields for mode, category, title, an ordered hint sequence, or separate follow-up prompts.

This change deliberately does not redesign that domain schema. Instead:

- `CuratedProblemSpec` is an authoring-only representation inside `packages/problems`;
- `authorCuratedProblem` compiles it into the existing `InterviewProblem` shape;
- mode, category, title, review status, and follow-up prompts remain catalog authoring metadata;
- the category is also included in `interviewer.topics` so existing topic-based runtime selection can see it;
- five graduated hint **stages** compile to ordinary protected disclosures, while `minimumDisclosureLevel` comes from the explicit manual semantic review registry and is never inferred from stage position;
- each hint disclosure must be referenced by at least one reasoning milestone;
- follow-ups remain authoring metadata, while generalizations/extensions use the existing reasoning-graph `extensions` field.

If those distinctions need runtime semantics later, they should be added by a separate architecture change rather than per-problem runtime conditionals.

## Required authoring shape

Every new curated problem should define:

- a stable problem ID and human-readable title;
- mode (`OXFORD_MATHEMATICS` or `QUANT`) and a primary category;
- topic metadata and difficulty;
- a fully specified public prompt and any given information;
- meaningful reasoning approaches and milestones;
- graph edges representing logical progress, including alternate routes where genuinely known;
- common errors or misconceptions;
- follow-up questions and extension/generalization prompts;
- exactly five graduated hints;
- a private canonical solution and verification notes;
- an explicit `expert-review` flag when a later mathematical/content audit is warranted.

Do not add a fake deterministic verifier. Verification metadata belongs only where a real verifier already exists or is naturally applicable.

## Hint convention

New problems use exactly five authored hint levels:

1. **Orientation** — identify a useful representation, quantity, or question without choosing the solution path for the candidate.
2. **Useful observation** — surface a relevant local fact or comparison.
3. **Structural idea** — expose the central technique or decomposition.
4. **Strong intermediate clue** — give the key equation/count/bijection/recurrence needed to finish.
5. **Near-solution guidance** — state the final structural step or formula while still leaving justification to the candidate.

These numbers are pedagogical stage positions only. They do **not** determine `minimumDisclosureLevel`. Each protected fact is classified separately on the frozen semantic disclosure scale by `CURATED_DISCLOSURE_LEVELS`; exact equations, posterior values, decisive intermediate calculations, and near-solutions can therefore receive level 4 or 5 even when they appear at an earlier hint stage. Final/answer-revealing formulations are classified at level 5.

## Reasoning-graph convention

Milestones should record meaningful mathematical progress, not every algebraic manipulation. A typical problem has roughly four to six milestones. Multiple approaches should be represented when they are standard and sufficiently different to matter in an interview.

The structural validator checks graph references, duplicate IDs, self edges, acyclicity, reachability from graph roots, nonempty milestone approach sets, and that every declared approach is actually used. It does not force one root, one terminal node, or one canonical solution route.

## Catalog metadata and review flags

`PROBLEM_METADATA` provides one metadata record per built-in problem, including the five legacy fixtures. `assertProblemBankIntegrity` requires a one-to-one match between built-in problem IDs and metadata IDs and rejects duplicate built-in IDs even though `createProblemCatalog` continues to support multiple versions of the same ID for generic versioned-catalog use.

The authored fixture set intentionally leaves two items marked for later expert review and excludes them from the default runtime catalog until that review is complete:

- `oxford-catalan-paths`: the result is standard; review is requested for the pedagogical precision of the reflection-bijection exposition.
- `quant-random-walk-drawdown`: the result is standard; review is requested mainly because its Catalan/reflection structure overlaps with the Oxford lattice-path problem and a later curator may prefer only one.

These flags are content-audit markers, not known mathematical failures.
