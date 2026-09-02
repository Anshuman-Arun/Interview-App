import {
  CommandEnvelopeSchema,
  CommandIdentityValueSchema,
  QuantTradingSessionConfigurationSchema,
  QuantTradingCandidateActionSchema,
  QuantTradingPublicStateSchema,
  type CommandEnvelope,
  type CommandIdentityValue,
  type CommandResult,
  type InterviewSessionConfiguration,
  type QuantTradingCandidateAction,
  type QuantTradingPublicState
} from "../../domain/src/index.js";
import {
  QuantTradingResultEventSchema,
  QuantTradingRoundEvidenceEventSchema,
  QuantTradingScenarioDefinitionEventSchema,
  type EventDraft,
  type QuantTradingResultEvent,
  type QuantTradingRoundEvidenceEvent,
  type SessionState
} from "../../events/src/index.js";
import {
  QUANT_TRADER_SCENARIO_VERSION,
  QuantStudentActionSchema,
  QuantTraderActionError,
  QuantTraderScenarioFamilySchema,
  createQuantTraderScenario,
  type QuantRoundEvidence,
  type QuantTraderInterviewEngine,
  type QuantTraderScenarioResult
} from "../../local-compute/src/index.js";
import { z } from "zod";
import { createCommandEnvelope } from "./envelopes.js";
import type { SessionWriter } from "./session-writer.js";
import { terminalInvalidationDrafts } from "./turn-coordinator.js";

const StartedResultSchema = z.object({ started: z.literal(true) }).strict();

function commandIdentityValue(value: unknown): CommandIdentityValue {
  return CommandIdentityValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

function jsonDataEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function terminalResultEvent(
  result: QuantTraderScenarioResult
): QuantTradingResultEvent {
  return QuantTradingResultEventSchema.parse({
    family: result.family,
    version: QUANT_TRADER_SCENARIO_VERSION,
    seed: result.seed,
    completionStatus: result.completionStatus,
    plannedRounds: result.plannedRounds,
    roundsCompleted: result.roundsCompleted,
    completionRate: result.completionRate,
    finalFairValue: result.finalFairValue,
    finalPortfolio: result.finalPortfolio,
    tradeCount: result.tradeCount,
    fillVolume: result.fillVolume,
    averageSpread: result.averageSpread,
    quoteParticipationRate: result.quoteParticipationRate,
    riskBreaches: result.riskBreaches,
    informedFlowCount: result.informedFlowCount,
    noiseFlowCount: result.noiseFlowCount,
    adverseSelectionPnL: result.adverseSelectionPnL,
    accountingInvariantHolds: result.accountingInvariantHolds,
    objectiveScore: result.objectiveScore
  });
}

function persistedRoundEvidence(evidence: QuantRoundEvidence): QuantTradingRoundEvidenceEvent {
  return QuantTradingRoundEvidenceEventSchema.parse({
    round: evidence.round,
    fairValue: evidence.fairValue,
    marketEvents: evidence.marketEvents,
    orderFlowType: evidence.orderFlowType,
    ...(evidence.incomingMarketSide === undefined
      ? {}
      : { incomingMarketSide: evidence.incomingMarketSide }),
    studentFills: evidence.studentFills,
    portfolio: evidence.portfolio,
    riskBreached: evidence.riskBreached,
    ...(evidence.riskReason === undefined ? {} : { riskReason: evidence.riskReason }),
    accountingInvariantHolds: evidence.accountingInvariantHolds,
    rngDrawCount: evidence.rngDrawCount
  });
}

function publicRound(evidence: QuantTradingRoundEvidenceEvent) {
  return {
    round: evidence.round,
    fairValue: evidence.fairValue,
    marketUpdates: evidence.marketEvents,
    fills: evidence.studentFills.map((fill) => ({
      side: fill.side,
      price: fill.price,
      size: fill.size
    })),
    portfolio: evidence.portfolio,
    riskBreached: evidence.riskBreached,
    ...(evidence.riskReason === undefined ? {} : { riskReason: evidence.riskReason }),
    accountingInvariantHolds: evidence.accountingInvariantHolds
  };
}

function publicStateFromEngine(
  configuration: Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_TRADING" }>,
  engine: QuantTraderInterviewEngine
): QuantTradingPublicState {
  const state = engine.getState();
  const lastRound = state.history.at(-1);
  const terminal = state.status !== "ACTIVE";
  const completion = terminal ? engine.getResult() : undefined;
  return QuantTradingPublicStateSchema.parse({
    mode: "QUANT_TRADING",
    scenario: configuration.scenario,
    status: state.status,
    currentRound: state.currentRound,
    plannedRounds: state.plannedRounds,
    fairValue: state.fairValue,
    portfolio: state.portfolio,
    marketUpdates: state.currentRoundEvents,
    ...(state.quoteRequest === undefined ? {} : { quoteRequest: state.quoteRequest }),
    actionRequired: state.status === "ACTIVE" && state.phase === "AWAITING_ACTION",
    ...(lastRound === undefined
      ? {}
      : { lastRound: publicRound(persistedRoundEvidence(lastRound)) }),
    ...(completion === undefined
      ? {}
      : {
          completion: {
            completionStatus: completion.completionStatus,
            plannedRounds: completion.plannedRounds,
            roundsCompleted: completion.roundsCompleted,
            completionRate: completion.completionRate,
            tradeCount: completion.tradeCount,
            fillVolume: completion.fillVolume,
            averageSpread: completion.averageSpread,
            quoteParticipationRate: completion.quoteParticipationRate,
            riskBreachCount: completion.riskBreaches.length,
            ...(completion.riskBreaches.at(-1) === undefined
              ? {}
              : {
                  lastRiskBreach: {
                    round: completion.riskBreaches.at(-1)?.round,
                    source: completion.riskBreaches.at(-1)?.source
                  }
                }),
            adverseSelectionPnL: completion.adverseSelectionPnL,
            accountingInvariantHolds: completion.accountingInvariantHolds,
            objectiveScore: completion.objectiveScore
          }
        })
  });
}

function reconstructQuantTradingEngine(
  state: Readonly<SessionState>
): {
  readonly configuration: Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_TRADING" }>;
  readonly engine: QuantTraderInterviewEngine;
} {
  const configuration = state.configuration;
  if (configuration?.mode !== "QUANT_TRADING") {
    throw new Error("Quant Trading runtime requires a Quant Trading session configuration");
  }
  const persisted = state.quantTrading;
  if (persisted === undefined) {
    throw new Error("Quant Trading scenario is not initialized");
  }
  if (
    persisted.definition.family !== configuration.scenario.id
    || persisted.definition.version !== configuration.scenario.version
    || state.problem !== undefined
    || state.quantResearch !== undefined
  ) {
    throw new Error("Persisted Quant Trading identity does not match session configuration");
  }
  if (persisted.pendingAction !== undefined) {
    throw new Error("Persisted Quant Trading history contains an unresolved candidate action");
  }

  const engine = createQuantTraderScenario({
    family: QuantTraderScenarioFamilySchema.parse(persisted.definition.family),
    seed: persisted.definition.seed
  });

  if (persisted.actions.length !== persisted.rounds.length) {
    throw new Error("Persisted Quant Trading action and round histories are misaligned");
  }

  for (const [index, persistedRound] of persisted.rounds.entries()) {
    if (engine.getState().status !== "ACTIVE") {
      throw new Error("Persisted Quant Trading history continues after deterministic completion");
    }
    const persistedAction = persisted.actions[index];
    if (persistedAction === undefined) {
      throw new Error("Persisted Quant Trading round is missing its accepted action");
    }
    engine.submitAction(QuantStudentActionSchema.parse(persistedAction));
    const recomputed = persistedRoundEvidence(engine.advance());
    if (!jsonDataEqual(recomputed, persistedRound)) {
      throw new Error("Persisted Quant Trading round outcome does not match deterministic replay");
    }
  }

  const engineTerminal = engine.getState().status !== "ACTIVE";
  if (engineTerminal) {
    const recomputedResult = terminalResultEvent(engine.getResult());
    if (persisted.result === undefined || !jsonDataEqual(recomputedResult, persisted.result)) {
      throw new Error("Persisted Quant Trading terminal result does not match deterministic replay");
    }
  } else if (persisted.result !== undefined) {
    throw new Error("Persisted Quant Trading result exists before deterministic completion");
  }

  if (
    (state.status === "COMPLETED" || state.status === "ARCHIVED")
    && (!engineTerminal || persisted.result === undefined)
  ) {
    throw new Error("Terminal Quant Trading session lacks deterministic terminal authority");
  }
  if (
    persisted.result !== undefined
    && state.status !== "COMPLETED"
    && state.status !== "ARCHIVED"
  ) {
    throw new Error("Terminal Quant Trading result requires a terminal session");
  }

  return { configuration, engine };
}

export function replayQuantTradingSessionState(
  state: Readonly<SessionState>
): QuantTradingPublicState {
  const reconstructed = reconstructQuantTradingEngine(state);
  return publicStateFromEngine(reconstructed.configuration, reconstructed.engine);
}

export class QuantTradingSessionCoordinator {
  public constructor(private readonly writer: SessionWriter) {}

  public initializeConfigured(
    configurationInput: Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_TRADING" }>,
    seed: number,
    commandEnvelope?: CommandEnvelope
  ): Promise<CommandResult<{ readonly started: true }>> {
    return this.initializeConfiguredWithSeedFactory(
      configurationInput,
      () => seed,
      commandEnvelope
    );
  }

  public initializeConfiguredWithSeedFactory(
    configurationInput: Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_TRADING" }>,
    seedFactory: () => number,
    commandEnvelope?: CommandEnvelope
  ): Promise<CommandResult<{ readonly started: true }>> {
    const parsed = QuantTradingSessionConfigurationSchema.parse(configurationInput);
    const envelope = CommandEnvelopeSchema.parse(
      commandEnvelope ?? createCommandEnvelope({
        sessionId: this.writer.sessionId,
        producer: "application"
      })
    );
    return this.writer.execute(envelope, {
      operation: "START_SESSION",
      payload: {
        configuration: commandIdentityValue(parsed),
        problem: null
      }
    }, StartedResultSchema, (state) => {
      if (state.started) throw new Error("Session already started");

      const definition = QuantTradingScenarioDefinitionEventSchema.parse({
        family: QuantTraderScenarioFamilySchema.parse(parsed.scenario.id),
        version: parsed.scenario.version,
        seed: seedFactory()
      });
      // Construct only after command idempotency/state admission. This both
      // proves the definition is runnable and prevents losing concurrent start
      // requests from consuming fresh randomness.
      const engine = createQuantTraderScenario({
        family: definition.family,
        seed: definition.seed
      });
      if (engine.getState().status !== "ACTIVE") {
        throw new Error("Production Quant Trading scenario must begin awaiting a candidate action");
      }

      const drafts: EventDraft[] = [
        {
          source: "APPLICATION",
          type: "SESSION_STARTED",
          payload: {
            startedAt: new Date().toISOString(),
            configuration: parsed
          }
        },
        {
          source: "APPLICATION",
          type: "QUANT_TRADING_SCENARIO_INITIALIZED",
          payload: { definition }
        }
      ];
      return { drafts, result: { started: true as const } };
    });
  }

  public getPublicState(): QuantTradingPublicState {
    return replayQuantTradingSessionState(this.writer.getState());
  }

  public async applyAction(
    actionInput: QuantTradingCandidateAction,
    expectedRound: number,
    commandEnvelope?: CommandEnvelope
  ): Promise<CommandResult<QuantTradingPublicState>> {
    const publicAction = QuantTradingCandidateActionSchema.parse(actionInput);
    if (!Number.isSafeInteger(expectedRound) || expectedRound < 1 || expectedRound > 256) {
      throw new RangeError("Quant Trading expected round must be between 1 and 256");
    }
    const action = QuantStudentActionSchema.parse(publicAction);
    const envelope = CommandEnvelopeSchema.parse(
      commandEnvelope ?? createCommandEnvelope({
        sessionId: this.writer.sessionId,
        producer: "authenticated-local-client"
      })
    );

    return this.writer.execute(envelope, {
      operation: "APPLY_QUANT_TRADING_ACTION",
      payload: {
        expectedRound,
        action: commandIdentityValue(publicAction)
      }
    }, QuantTradingPublicStateSchema, (state) => {
      if (!state.started || state.status !== "ACTIVE") {
        throw new Error(`Cannot apply Quant Trading action in status ${state.status}`);
      }
      const { configuration, engine } = reconstructQuantTradingEngine(state);
      if (engine.getState().currentRound !== expectedRound) {
        throw new Error("Cannot apply Quant Trading action to a stale round");
      }
      let evidence: QuantTradingRoundEvidenceEvent;
      try {
        engine.submitAction(action);
        evidence = persistedRoundEvidence(engine.advance());
      } catch (error) {
        if (error instanceof RangeError && action.type === "QUOTE") {
          throw new QuantTraderActionError(
            "INVALID_QUOTE",
            "Candidate quote exceeds bounded Quant Trading arithmetic"
          );
        }
        throw error;
      }
      const drafts: EventDraft[] = [
        {
          source: "USER",
          type: "QUANT_TRADING_ACTION_ACCEPTED",
          payload: { action: publicAction }
        },
        {
          source: "APPLICATION",
          type: "QUANT_TRADING_ROUND_RESOLVED",
          payload: { evidence }
        }
      ];

      if (engine.getState().status !== "ACTIVE") {
        if (
          Object.values(state.inputEpisodes).some((episode) => episode.status === "ACTIVE")
          || Object.values(state.utterances).some((utterance) => utterance.status === "CAPTURING")
        ) {
          throw new Error("Cannot complete Quant Trading while candidate input is unresolved");
        }
        const result = terminalResultEvent(engine.getResult());
        const completedAt = new Date().toISOString();
        drafts.unshift(...terminalInvalidationDrafts(
          state,
          "Deterministic Quant Trading scenario completed"
        ));
        drafts.push(
          {
            source: "APPLICATION",
            type: "QUANT_TRADING_SCENARIO_COMPLETED",
            payload: { result }
          },
          {
            source: "APPLICATION",
            type: "SESSION_COMPLETED",
            payload: {
              completedAt,
              summary: `Quant Trading ${result.family} completed deterministically`
            }
          }
        );
      }

      return {
        drafts,
        result: publicStateFromEngine(configuration, engine)
      };
    });
  }
}
