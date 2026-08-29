# Problem Fixture Integrity

## Purpose

Problem definitions are application-owned authored configuration. A malformed reasoning graph or disclosure registry must fail during development rather than silently changing interview behavior at runtime.

This package-level integrity gate validates the structure of an `InterviewProblem` without changing domain schemas, pedagogical policy, event state, verification behavior, or session persistence.

## Entry points

`assertInterviewProblemIntegrity(problem)` validates one complete authored fixture.

`assertReasoningGraphFixtureIntegrity(graph)` validates the structural reasoning-graph invariants that can be enforced without choosing a pedagogical topology.

`createProblemCatalog(problems)` validates every entry and rejects duplicate `(problemId, problemVersion)` identities.

The built-in `sixPeopleProblem` runs the full problem-level assertion when its module loads, and `problemCatalog` currently contains that fixture.

## Enforced invariants

The validator rejects:

- blank problem id, version, public prompt, canonical solution, or verification notes after trimming;
- duplicate approach, milestone, common-error, or extension IDs;
- milestone references to unknown approaches or prerequisites;
- duplicate approach/prerequisite/protected-disclosure references inside one milestone;
- self-prerequisites;
- reasoning edges with unknown endpoints;
- self reasoning edges;
- duplicate directed reasoning edges;
- cyclic reasoning graphs;
- duplicate protected-disclosure IDs;
- milestone disclosure references that are absent from the problem disclosure registry;
- blank protected facts or equivalent formulations after trimming;
- equivalent formulations duplicated after deterministic normalization;
- duplicate problem id/version pairs in a catalog.

Equivalent-formulation normalization is:

1. Unicode NFKC normalization;
2. trim leading/trailing whitespace;
3. collapse internal Unicode whitespace runs to one ASCII space;
4. lowercase.

The normalization is used only to catch duplicate authoring entries. It is not a semantic disclosure classifier.

## Reachability and topology

The validator derives every zero-in-degree milestone as a graph root and verifies that every milestone is reachable from at least one such root.

For a finite acyclic directed graph this is a structural consistency check, not a requirement for one connected interview path. The architecture deliberately leaves exact reasoning-graph topology unfrozen, so this gate does **not** require:

- exactly one root;
- exactly one terminal milestone;
- all approaches to traverse the same milestones;
- prerequisite lists to duplicate graph edges;
- a specific ordering between alternate valid approaches.

Those are pedagogical decisions and remain outside this integrity layer.

## Authority boundary

This code:

- imports only the domain package;
- creates no events;
- does not mutate session state;
- does not call providers or verifiers;
- does not inspect or alter delivery state;
- adds no persistence;
- adds no dependencies.

The problem catalog is deterministic, in-memory authored configuration only.
