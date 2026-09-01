# Problem Fixture Integrity

## Purpose

Problem definitions are application-owned authored configuration. A malformed problem, reasoning graph, disclosure registry, or built-in catalog entry must fail during development rather than silently changing interview behavior at runtime.

The integrity gates validate `InterviewProblem` fixtures and the curated problem bank without changing domain schemas, pedagogical policy, event state, verification behavior, or session persistence.

## Entry points

- `assertInterviewProblemIntegrity(problem)` validates one complete runtime fixture.
- `assertReasoningGraphFixtureIntegrity(graph)` validates structural reasoning-graph invariants.
- `createProblemCatalog(problems)` validates every entry and rejects duplicate `(problemId, problemVersion)` identities while still allowing explicit version history.
- `assertProblemBankIntegrity(problems, metadata)` adds built-in-bank rules: unique problem IDs plus exactly one authoring metadata record for each built-in problem.
- `authorCuratedProblem(spec)` validates the authoring conventions for new curated problems and compiles them to the unchanged runtime contract.

Every built-in problem runs through the full integrity path when the catalog module loads.

## Enforced invariants

The validator rejects:

- blank problem IDs, prompts, difficulty labels, solutions, verification notes, topics, given-information entries, or authored graph text;
- problem or reasoning-graph versions that are not numeric `MAJOR.MINOR.PATCH` strings;
- empty or duplicate topic metadata;
- duplicate approach, milestone, common-error, or extension IDs;
- milestones with no approach or references to unknown/duplicate approaches or prerequisites;
- declared approaches that no milestone uses;
- self-prerequisites;
- reasoning edges with unknown endpoints, self edges, duplicate directed edges, or cycles;
- duplicate protected-disclosure IDs;
- milestone disclosure references absent from the disclosure registry;
- protected disclosures not referenced by any milestone;
- blank protected facts or equivalent formulations;
- equivalent formulations duplicated after deterministic normalization;
- duplicate `(problemId, problemVersion)` identities in a generic catalog;
- duplicate problem IDs in the built-in bank;
- missing, duplicate, blank, or orphaned built-in problem metadata;
- curated problems that omit or duplicate any of hint levels 1 through 5, or define a hint level that no milestone uses;
- runtime-invalid reasoning-graph or protected-disclosure records that violate the domain schemas.

Validated curated outputs and catalog admissions are snapshotted/deep-frozen so caller mutation after validation cannot silently invalidate these guarantees.

Equivalent-formulation normalization uses Unicode NFKC normalization, trims leading/trailing whitespace, collapses internal whitespace runs to one ASCII space, and lowercases. It is only an authoring duplicate check, not a semantic disclosure classifier.

## Reachability and topology

The graph validator derives every zero-in-degree milestone as a root and verifies every milestone is reachable from at least one root. For a finite DAG this is a structural consistency check, not a requirement for one connected interview path.

It deliberately does **not** require exactly one root, exactly one terminal milestone, or all approaches to traverse the same nodes. It **does** require exact parity between incoming graph edges and each milestone's declared optional prerequisites, so the two structural representations cannot silently disagree.

## Authority boundary

This code imports only the domain package, creates no events, mutates no session state, calls no providers or verifiers, inspects no delivery state, adds no persistence, and introduces no dependencies. The problem catalog remains deterministic in-memory authored configuration.
