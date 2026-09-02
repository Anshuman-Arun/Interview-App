import { z } from "zod";
import {
  CommandEnvelopeSchema,
  CommandIdentityValueSchema,
  InterviewSessionConfigurationSchema,
  QuantResearchPublicStateSchema as QuantResearchRuntimePublicStateSchema,
  type CommandEnvelope,
  type CommandIdentityValue,
  type InterviewSessionConfiguration
} from "../../domain/src/index.js";
import {
  QuantResearchActionEventSchema,
  QuantResearchAuthoritativeSnapshotEventSchema,
  QuantResearchResultEventSchema,
  QuantResearchScenarioDefinitionEventSchema,
  type EventDraft,
  type SessionState
} from "../../events/src/index.js";
import {
  QuantResearchEngine,
  parseQuantResearchAction,
  parseQuantResearchDefinition,
  type QuantResearchAction,
  type QuantResearchPublicState,
  type QuantResearchResult
} from "../../local-compute/src/index.js";
import { createCommandEnvelope } from "./envelopes.js";
import type { SessionWriter } from "./session-writer.js";
import { terminalInvalidationDrafts } from "./turn-coordinator.js";

const StartedResultSchema = z.object({ started: z.literal(true) }).strict();

const QuantResearchFamilySchema = z.enum([
  "BAYESIAN_UPDATING",
  "SAMPLING_ESTIMATION",
  "EXPERIMENTAL_ALLOCATION",
  "MODEL_COMPARISON",
  "CONSTRAINED_OPTIMIZATION"
]);
const QuantResearchPublicValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(z.number()).max(128),
  z.array(z.string()).max(128)
]);
const QuantResearchPublicStateSchema = z.object({
  family: QuantResearchFamilySchema,
  version: z.string().min(1).max(64),
  generatorVersion: z.string().min(1).max(64),
  rngVersion: z.string().min(1).max(64),
  status: z.enum(["IN_PROGRESS", "COMPLETE"]),
  stage: z.string().min(1).max(64),
  prompt: z.string().min(1).max(10_000),
  visibleData: z.array(z.object({
    key: z.string().min(1).max(128),
    label: z.string().min(1).max(256),
    value: QuantResearchPublicValueSchema
  }).strict()).max(32),
  acceptedActionCount: z.number().int().min(0).max(64),
  actionLimit: z.number().int().min(1).max(64)
}).strict();

export const QuantResearchCoordinatorOutcomeSchema = z.object({
  state: QuantResearchPublicStateSchema,
  result: QuantResearchResultEventSchema
}).strict();
export type QuantResearchCoordinatorOutcome = z.infer<typeof QuantResearchCoordinatorOutcomeSchema>;

export interface ReplayedQuantResearchSession {
  readonly state: QuantResearchPublicState;
  readonly result: QuantResearchResult;
  readonly acceptedActions: readonly QuantResearchAction[];
}

function commandIdentityValue(value: unknown): CommandIdentityValue {
  return CommandIdentityValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

function assertSessionAvailable(state: Readonly<SessionState>): void {
  if (state.status === "COMPLETED" || state.status === "ARCHIVED") {
    throw new Error("Quant Research commands require a non-terminal session");
  }
}

function canonicalEventSnapshot(engine: QuantResearchEngine) {
  return QuantResearchAuthoritativeSnapshotEventSchema.parse(engine.getAuthoritativePersistenceSnapshot());
}

function canonicalEventResult(engine: QuantResearchEngine) {
  return QuantResearchResultEventSchema.parse(engine.getResult());
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reconstructEngine(state: Readonly<SessionState>): QuantResearchEngine {
  const persisted = state.quantResearch;
  if (persisted === undefined) throw new Error("Quant Research scenario is not initialized");
  if (
    state.configuration !== undefined
    && (
      state.configuration.mode !== "QUANT_RESEARCH"
      || state.configuration.scenario.id !== persisted.definition.family
      || state.configuration.scenario.version !== persisted.definition.version
    )
  ) {
    throw new Error("Persisted Quant Research scenario does not match the authoritative session configuration");
  }
  if (
    state.problem?.id !== persisted.definition.family ||
    state.problem.version !== persisted.definition.version
  ) {
    throw new Error("Persisted Quant Research scenario no longer matches the authoritative problem");
  }

  const eventDefinition = QuantResearchScenarioDefinitionEventSchema.parse(persisted.definition);
  const definition = parseQuantResearchDefinition(eventDefinition);
  const engine = new QuantResearchEngine(definition);
  if (state.problem.prompt !== engine.getState().prompt) {
    throw new Error("Persisted Quant Research public prompt does not match deterministic regeneration");
  }

  const expectedSnapshot = canonicalEventSnapshot(engine);
  const storedSnapshot = QuantResearchAuthoritativeSnapshotEventSchema.parse(persisted.authoritativeSnapshot);
  if (!sameCanonicalJson(expectedSnapshot, storedSnapshot)) {
    throw new Error("Persisted Quant Research generated parameters or grading data do not match deterministic regeneration");
  }

  for (const persistedAction of persisted.actions) {
    const eventAction = QuantResearchActionEventSchema.parse(persistedAction);
    engine.applyAction(parseQuantResearchAction(eventAction));
  }

  const recomputedResult = canonicalEventResult(engine);
  if (persisted.result === undefined) {
    if (recomputedResult.status === "COMPLETE") {
      throw new Error("Quant Research completion event is missing from authoritative history");
    }
    if (state.status === "COMPLETED" || state.status === "ARCHIVED") {
      throw new Error("Terminal session is missing a persisted Quant Research completion result");
    }
  } else {
    const storedResult = QuantResearchResultEventSchema.parse(persisted.result);
    if (recomputedResult.status !== "COMPLETE" || !sameCanonicalJson(recomputedResult, storedResult)) {
      throw new Error("Persisted Quant Research result does not match deterministic replay");
    }
    if (state.status !== "COMPLETED" && state.status !== "ARCHIVED") {
      throw new Error("Persisted Quant Research completion is missing the terminal session lifecycle event");
    }
  }
  return engine;
}

export function replayQuantResearchSessionState(state: Readonly<SessionState>): ReplayedQuantResearchSession {
  const engine = reconstructEngine(state);
  return {
    state: engine.getState(),
    result: engine.getResult(),
    acceptedActions: engine.getAcceptedActions()
  };
}

export class QuantResearchCoordinator {
  public constructor(private readonly writer: SessionWriter) {}

  public initializeConfigured(
    configurationInput: Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_RESEARCH" }>,
    definitionInput: unknown,
    commandEnvelope?: CommandEnvelope
  ) {
    return this.initializeConfiguredWithDefinitionFactory(
      configurationInput,
      () => definitionInput,
      commandEnvelope
    );
  }

  public initializeConfiguredWithDefinitionFactory(
    configurationInput: Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_RESEARCH" }>,
    definitionFactory: () => unknown,
    commandEnvelope?: CommandEnvelope
  ) {
    const configuration = InterviewSessionConfigurationSchema.parse(configurationInput);
    if (configuration.mode !== "QUANT_RESEARCH") {
      throw new Error("Quant Research initialization requires Quant Research configuration");
    }
    const envelope = CommandEnvelopeSchema.parse(
      commandEnvelope ?? createCommandEnvelope({
        sessionId: this.writer.sessionId,
        producer: "application"
      })
    );

    return this.writer.execute(
      envelope,
      {
        operation: "START_SESSION",
        payload: {
          configuration: commandIdentityValue(configuration),
          problem: null
        }
      },
      StartedResultSchema,
      (state) => {
        if (state.started) throw new Error("Session already started");

        const definition = parseQuantResearchDefinition(definitionFactory());
        if (
          definition.family !== configuration.scenario.id
          || definition.version !== configuration.scenario.version
        ) {
          throw new Error("Quant Research definition does not match configured scenario identity");
        }
        const engine = new QuantResearchEngine(definition);
        const publicState = engine.getState();
        const authoritativeSnapshot = canonicalEventSnapshot(engine);
        const eventDefinition = QuantResearchScenarioDefinitionEventSchema.parse(definition);
        const drafts: EventDraft[] = [
          {
            source: "APPLICATION",
            type: "SESSION_STARTED",
            payload: {
              startedAt: new Date().toISOString(),
              configuration
            }
          },
          {
            source: "APPLICATION",
            type: "PROBLEM_PRESENTED",
            payload: {
              problemId: definition.family,
              problemVersion: definition.version,
              prompt: publicState.prompt
            }
          },
          {
            source: "APPLICATION",
            type: "QUANT_RESEARCH_SCENARIO_INITIALIZED",
            payload: {
              definition: eventDefinition,
              authoritativeSnapshot
            }
          }
        ];
        return { drafts, result: { started: true as const } };
      }
    );
  }

  public getPublicState() {
    return QuantResearchRuntimePublicStateSchema.parse(this.replay().state);
  }

  public initialize(definitionInput: unknown, commandEnvelope?: CommandEnvelope) {
    const definition = parseQuantResearchDefinition(definitionInput);
    const sessionConfiguration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "QUANT_RESEARCH",
      scenario: { id: definition.family, version: definition.version },
      interventionPolicy: "BALANCED"
    });
    const engine = new QuantResearchEngine(definition);
    const publicState = engine.getState();
    const result = canonicalEventResult(engine);
    const authoritativeSnapshot = canonicalEventSnapshot(engine);
    const eventDefinition = QuantResearchScenarioDefinitionEventSchema.parse(definition);
    const envelope = CommandEnvelopeSchema.parse(commandEnvelope ?? createCommandEnvelope({
      sessionId: this.writer.sessionId,
      producer: "quant-research-coordinator"
    }));
    const outcome = QuantResearchCoordinatorOutcomeSchema.parse({ state: publicState, result });

    return this.writer.execute(
      envelope,
      {
        operation: "INITIALIZE_QUANT_RESEARCH",
        payload: { definition: eventDefinition }
      },
      QuantResearchCoordinatorOutcomeSchema,
      (state) => {
        assertSessionAvailable(state);
        if (state.problem !== undefined) throw new Error("Session already has a presented problem");
        if (state.quantResearch !== undefined) throw new Error("Quant Research scenario is already initialized");

        const startDrafts: EventDraft[] = [];
        if (!state.started) {
          startDrafts.push({
            source: "APPLICATION",
            type: "SESSION_STARTED",
            payload: {
              startedAt: new Date().toISOString(),
              configuration: sessionConfiguration
            }
          });
        } else {
          if (
            state.configuration === undefined
            || state.configuration.mode !== "QUANT_RESEARCH"
            || state.configuration.scenario.id !== definition.family
            || state.configuration.scenario.version !== definition.version
          ) {
            throw new Error("Started session configuration does not match the Quant Research definition");
          }
        }

        const drafts: EventDraft[] = [
          ...startDrafts,
          {
            source: "APPLICATION",
            type: "PROBLEM_PRESENTED",
            payload: {
              problemId: definition.family,
              problemVersion: definition.version,
              prompt: publicState.prompt
            }
          },
          {
            source: "APPLICATION",
            type: "QUANT_RESEARCH_SCENARIO_INITIALIZED",
            payload: {
              definition: eventDefinition,
              authoritativeSnapshot
            }
          }
        ];
        return { drafts, result: outcome };
      }
    );
  }

  public applyAction(actionInput: unknown, commandEnvelope?: CommandEnvelope) {
    return this.applyActionInternal(actionInput, undefined, commandEnvelope);
  }

  public applyActionAtExpectedCount(
    actionInput: unknown,
    expectedActionCount: number,
    commandEnvelope?: CommandEnvelope
  ) {
    if (
      !Number.isSafeInteger(expectedActionCount)
      || expectedActionCount < 0
      || expectedActionCount > 64
    ) {
      throw new RangeError("Quant Research expected action count must be between 0 and 64");
    }
    return this.applyActionInternal(actionInput, expectedActionCount, commandEnvelope);
  }

  private applyActionInternal(
    actionInput: unknown,
    expectedActionCount: number | undefined,
    commandEnvelope?: CommandEnvelope
  ) {
    const action = parseQuantResearchAction(actionInput);
    const eventAction = QuantResearchActionEventSchema.parse(action);
    const envelope = CommandEnvelopeSchema.parse(commandEnvelope ?? createCommandEnvelope({
      sessionId: this.writer.sessionId,
      producer: "quant-research-coordinator"
    }));

    return this.writer.execute(
      envelope,
      {
        operation: "APPLY_QUANT_RESEARCH_ACTION",
        payload: {
          action: eventAction,
          ...(expectedActionCount === undefined ? {} : { expectedActionCount })
        }
      },
      QuantResearchCoordinatorOutcomeSchema,
      (state) => {
        assertSessionAvailable(state);
        const engine = reconstructEngine(state);
        if (
          expectedActionCount !== undefined
          && engine.getState().acceptedActionCount !== expectedActionCount
        ) {
          throw new Error("Cannot apply Quant Research action to stale scenario progress");
        }
        engine.applyAction(action);

        const drafts: EventDraft[] = [{
          source: "USER",
          type: "QUANT_RESEARCH_ACTION_ACCEPTED",
          payload: { action: eventAction }
        }];
        const result = canonicalEventResult(engine);
        if (result.status === "COMPLETE") {
          if (Object.values(state.inputEpisodes).some((episode) => episode.status === "ACTIVE")) {
            throw new Error("Cannot complete Quant Research while an input episode is active");
          }
          drafts.unshift(...terminalInvalidationDrafts(
            state,
            "Deterministic Quant Research scenario completed"
          ));
          drafts.push({
            source: "APPLICATION",
            type: "QUANT_RESEARCH_SCENARIO_COMPLETED",
            payload: { result }
          }, {
            source: "APPLICATION",
            type: "SESSION_COMPLETED",
            payload: {
              completedAt: new Date().toISOString(),
              summary: "Quant Research scenario completed."
            }
          });
        }
        return {
          drafts,
          result: QuantResearchCoordinatorOutcomeSchema.parse({
            state: engine.getState(),
            result
          })
        };
      }
    );
  }

  public replay(): ReplayedQuantResearchSession {
    return replayQuantResearchSessionState(this.writer.getState());
  }
}
