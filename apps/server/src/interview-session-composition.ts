import {
  InterviewCatalogEntrySchema,
  InterviewSessionConfigurationSchema,
  type InterviewCatalogEntry,
  type InterviewProblem,
  type InterviewSessionConfiguration
} from "../../../packages/domain/src/index.js";
import type { SessionState } from "../../../packages/events/src/index.js";
import { createProviderContextSpecFingerprintSync } from "../../../packages/interview-engine/src/context-compiler.js";
import {
  QUANT_TRADER_SCENARIO_VERSION,
  QuantTraderScenarioFamilySchema,
  getQuantResearchRegistry
} from "../../../packages/local-compute/src/index.js";
import {
  PROBLEM_METADATA,
  getProblemById,
  getProblemByIdentity,
  getProblemMetadataById
} from "../../../packages/problems/src/index.js";

export type InterviewSessionComposition =
  | Readonly<{
      mode: "OXFORD_MATHEMATICS";
      configuration: Extract<InterviewSessionConfiguration, { readonly mode: "OXFORD_MATHEMATICS" }>;
      problem: InterviewProblem;
    }>
  | Readonly<{
      mode: "QUANT_TRADING";
      configuration: Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_TRADING" }>;
    }>
  | Readonly<{
      mode: "QUANT_RESEARCH";
      configuration: Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_RESEARCH" }>;
    }>;


export function resolveInterviewSessionConfiguration(
  input: unknown
): InterviewSessionComposition {
  const configuration = InterviewSessionConfigurationSchema.parse(input);

  switch (configuration.mode) {
    case "OXFORD_MATHEMATICS": {
      const problem = getProblemByIdentity(configuration.problem.id, configuration.problem.version);
      const metadata = getProblemMetadataById(configuration.problem.id);
      if (
        problem === undefined
        || metadata === undefined
        || metadata.mode !== "OXFORD_MATHEMATICS"
        || metadata.reviewStatus !== "ready"
      ) {
        throw new Error("Configured Oxford problem identity is not available");
      }
      if (
        configuration.difficulty !== undefined
        && configuration.difficulty !== problem.interviewer.difficulty
      ) {
        throw new Error("Configured Oxford difficulty does not match the problem");
      }
      return Object.freeze({ mode: configuration.mode, configuration, problem });
    }

    case "QUANT_TRADING": {
      QuantTraderScenarioFamilySchema.parse(configuration.scenario.id);
      if (configuration.scenario.version !== QUANT_TRADER_SCENARIO_VERSION) {
        throw new Error("Configured Quant Trading scenario version is not available");
      }
      return Object.freeze({ mode: configuration.mode, configuration });
    }

    case "QUANT_RESEARCH": {
      const registration = getQuantResearchRegistry().find(
        (candidate) =>
          candidate.family === configuration.scenario.id
          && candidate.version === configuration.scenario.version
      );
      if (registration === undefined) {
        throw new Error("Configured Quant Research scenario version is not available");
      }
      return Object.freeze({ mode: configuration.mode, configuration });
    }
  }
}

export function resolveSessionStateComposition(
  state: Readonly<SessionState>
): InterviewSessionComposition {
  if (!state.started) {
    throw new Error("Cannot compose an interview session before it starts");
  }
  if (state.configuration !== undefined) {
    const composition = resolveInterviewSessionConfiguration(state.configuration);
    assertPersistedCompositionMatchesState(composition, state, true);
    return composition;
  }

  // Legacy streams predate authoritative session configuration. Recover only
  // when their already-persisted exact identity maps unambiguously.
  if (state.quantResearch !== undefined) {
    const composition = resolveInterviewSessionConfiguration({
      configurationVersion: 1,
      mode: "QUANT_RESEARCH",
      scenario: {
        id: state.quantResearch.definition.family,
        version: state.quantResearch.definition.version
      },
      interventionPolicy: "BALANCED"
    });
    assertPersistedCompositionMatchesState(composition, state, false);
    return composition;
  }

  if (state.problem !== undefined) {
    const problem = getProblemByIdentity(state.problem.id, state.problem.version);
    const metadata = getProblemMetadataById(state.problem.id);
    if (
      problem === undefined
      || metadata?.mode !== "OXFORD_MATHEMATICS"
      || metadata.reviewStatus !== "ready"
    ) {
      throw new Error("Legacy session problem identity is no longer available");
    }
    const composition = resolveInterviewSessionConfiguration({
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: { id: problem.id, version: problem.version },
      difficulty: problem.interviewer.difficulty,
      interventionPolicy: "BALANCED"
    });
    assertPersistedCompositionMatchesState(composition, state, false);
    return composition;
  }

  throw new Error("Session has no authoritative interview identity");
}

function assertPersistedCompositionMatchesState(
  composition: InterviewSessionComposition,
  state: Readonly<SessionState>,
  configuredStream: boolean
): void {
  if (composition.mode === "OXFORD_MATHEMATICS") {
    const persistedProblem = state.problem;
    if (
      persistedProblem === undefined
      || persistedProblem.id !== composition.problem.id
      || persistedProblem.version !== composition.problem.version
      || persistedProblem.prompt !== composition.problem.public.prompt
    ) {
      throw new Error("Persisted Oxford problem does not match the authoritative session configuration");
    }
    const expectedFingerprint = createProviderContextSpecFingerprintSync(composition.problem);
    if (
      (configuredStream && persistedProblem.providerContextSpecSha256 === undefined)
      || (
        persistedProblem.providerContextSpecSha256 !== undefined
        && persistedProblem.providerContextSpecSha256 !== expectedFingerprint
      )
    ) {
      throw new Error("Persisted Oxford problem provenance does not match the authoritative definition");
    }
    return;
  }

  if (composition.mode === "QUANT_RESEARCH") {
    const persistedResearch = state.quantResearch;
    if (persistedResearch === undefined) {
      if (state.problem !== undefined) {
        throw new Error("Quant Research problem is presented without authoritative scenario state");
      }
      return;
    }
    if (
      persistedResearch.definition.family !== composition.configuration.scenario.id
      || persistedResearch.definition.version !== composition.configuration.scenario.version
      || state.problem === undefined
      || state.problem.id !== composition.configuration.scenario.id
      || state.problem.version !== composition.configuration.scenario.version
    ) {
      throw new Error("Persisted Quant Research identity does not match session configuration");
    }
    return;
  }

  if (state.quantResearch !== undefined) {
    throw new Error("Quant Research state cannot be attached to a Quant Trading session");
  }
}

export function listInterviewCatalogEntries(): readonly InterviewCatalogEntry[] {
  const entries: InterviewCatalogEntry[] = [];

  for (const metadata of PROBLEM_METADATA) {
    if (metadata.mode !== "OXFORD_MATHEMATICS" || metadata.reviewStatus !== "ready") continue;
    const problem = getProblemById(metadata.id);
    if (problem === undefined) {
      throw new Error("Problem catalog metadata has no matching problem");
    }
    entries.push(InterviewCatalogEntrySchema.parse({
      mode: "OXFORD_MATHEMATICS",
      id: problem.id,
      version: problem.version,
      title: metadata.title,
      category: metadata.category,
      difficulty: problem.interviewer.difficulty
    }));
  }

  for (const family of QuantTraderScenarioFamilySchema.options) {
    entries.push(InterviewCatalogEntrySchema.parse({
      mode: "QUANT_TRADING",
      id: family,
      version: QUANT_TRADER_SCENARIO_VERSION,
      title: humanizeIdentifier(family)
    }));
  }

  for (const registration of getQuantResearchRegistry()) {
    entries.push(InterviewCatalogEntrySchema.parse({
      mode: "QUANT_RESEARCH",
      id: registration.family,
      version: registration.version,
      title: humanizeIdentifier(registration.family)
    }));
  }

  return Object.freeze(entries);
}

function humanizeIdentifier(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0] === undefined ? part : part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
