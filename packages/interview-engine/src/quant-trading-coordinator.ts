import {
  CommandEnvelopeSchema,
  CommandIdentityValueSchema,
  InterviewSessionConfigurationSchema,
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
  QuantTraderScenarioFamilySchema,
  createQuantTraderScenario,
  type QuantTraderInterview,
  type QuantTraderScenarioResult
} from "../../local-compute/src/index.js";
import { z } from "zod";
import { createCommandEnvelope } from "./envelopes.js";
import type { SessionWriter } from "./session-writer.js";

const StartedResultSchema = z.object({ started: z.literal(true) }).strict();

function commandIdentityValue(value: unknown): CommandIdentityValue {
  return CommandIdentityValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

function jsonDataEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function terminalResultEvent(
  result: QuantTraderScenarioResult,
  terminalMarketEvents: readonly unknown[]
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
    objectiveScore: result.objectiveScore,
    terminalMarketEvents
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
  engine: QuantTraderInterview
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
      : { lastRound: publicRound(QuantTradingRoundEvidenceEventSchema.parse(lastRound)) }),
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
  readonly engine: QuantTraderInterview;
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
    || persisted.definition.version !== QUANT_TRADER_SCENARIO_VERSION
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

  for (const persistedRound of persisted.rounds) {
    if (engine.getState().status !== "ACTIVE") {
      throw new Error("Persisted Quant Trading history continues after deterministic completion");
    }
    engine.submitAction(QuantStudentActionSchema.parse(persistedRound.studentAction));
    const recomputed = QuantTradingRoundEvidenceEventSchema.parse(engine.advance());
    if (!jsonDataEqual(recomputed, persistedRound)) {
      throw new Error("Persisted Quant Trading round outcome does not match deterministic replay");
    }
  }

  const engineTerminal = engine.getState().status !== "ACTIVE";
  if (engineTerminal) {
    const recomputedResult = terminalResultEvent(
      engine.getResult(),
      engine.getState().currentRoundEvents
    );
    if (persisted.result === undefined || !jsonDataEqual(recomputedResult, persisted.result)) {
      throw new Error("Persisted Quant Trading terminal result does not match deterministic replay");
    }
  } else if (persisted.result !== undefined) {
    throw new Error("Persisted Quant Trading result exists before deterministic completion");
  }

  if (
    state.status === "COMPLETED"
    && (!engineTerminal || persisted.result === undefined)
  ) {
    throw new Error("Completed Quant Trading session lacks deterministic terminal authority");
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

  public async initializeConfigured(
    configurationInput: Extract<InterviewSessionConfiguration, { readonly mode: "QUANT_TRADING" }>,
    seed: number,
    commandEnvelope?: CommandEnvelope
  ): Promise<CommandResult<{ readonly started: true }>> {
    const parsed = InterviewSessionConfigurationSchema.parse(configurationInput);
    if (parsed.mode !== "QUANT_TRADING") {
      throw new Error("Quant Trading initialization requires Quant Trading configuration");
    }
    const definition = QuantTradingScenarioDefinitionEventSchema.parse({
      family: QuantTraderScenarioFamilySchema.parse(parsed.scenario.id),
      version: parsed.scenario.version,
      seed
    });
    if (definition.version !== QUANT_TRADER_SCENARIO_VERSION) {
      throw new Error("Configured Quant Trading scenario version is not supported");
    }

    // Construct before persistence so invalid or non-runnable definitions fail closed.
    const engine = createQuantTraderScenario({
      family: definition.family,
      seed: definition.seed
    });
    if (engine.getState().status !== "ACTIVE") {
      throw new Error("Production Quant Trading scenario must begin awaiting a candidate action");
    }

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
    commandEnvelope?: CommandEnvelope
  ): Promise<CommandResult<QuantTradingPublicState>> {
    const publicAction = QuantTradingCandidateActionSchema.parse(actionInput);
    const action = QuantStudentActionSchema.parse(publicAction);
    const envelope = CommandEnvelopeSchema.parse(
      commandEnvelope ?? createCommandEnvelope({
        sessionId: this.writer.sessionId,
        producer: "authenticated-local-client"
      })
    );

    return this.writer.execute(envelope, {
      operation: "APPLY_QUANT_TRADING_ACTION",
      payload: { action: commandIdentityValue(publicAction) }
    }, QuantTradingPublicStateSchema, (state) => {
      if (!state.started || state.status !== "ACTIVE") {
        throw new Error(`Cannot apply Quant Trading action in status ${state.status}`);
      }
      const { configuration, engine } = reconstructQuantTradingEngine(state);
      engine.submitAction(action);
      const evidence = QuantTradingRoundEvidenceEventSchema.parse(engine.advance());
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
        const result = terminalResultEvent(
          engine.getResult(),
          engine.getState().currentRoundEvents
        );
        const completedAt = new Date().toISOString();
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
