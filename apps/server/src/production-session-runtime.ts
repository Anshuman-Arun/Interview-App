import { randomBytes } from "node:crypto";
import {
  CommandIdentityValueSchema,
  QuantResearchCandidateActionSchema,
  QuantTradingCandidateActionSchema,
  type CommandEnvelope,
  type QuantResearchCandidateAction,
  type QuantTradingCandidateAction
} from "../../../packages/domain/src/index.js";
import {
  QuantResearchCoordinator,
  QuantTradingSessionCoordinator,
  TurnCoordinator,
  type SessionWriter
} from "../../../packages/interview-engine/src/index.js";
import {
  QUANT_RESEARCH_FAMILIES,
  createProductionQuantResearchDefinition
} from "../../../packages/local-compute/src/index.js";
import { z } from "zod";
import type { InterviewSessionComposition } from "./interview-session-composition.js";

export type QuantProductionPublicState =
  | Readonly<{
      mode: "QUANT_TRADING";
      state: ReturnType<QuantTradingSessionCoordinator["getPublicState"]>;
    }>
  | Readonly<{
      mode: "QUANT_RESEARCH";
      state: ReturnType<QuantResearchCoordinator["getPublicState"]>;
    }>;

export interface ProductionSessionRuntimeOptions {
  readonly seedSource?: () => number;
}

const StartedResultSchema = z.object({ started: z.literal(true) }).strict();

function commandIdentityValue(value: unknown) {
  return CommandIdentityValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

async function replayQuantStartWithoutNewSeed(
  writer: SessionWriter,
  composition: Extract<InterviewSessionComposition, { readonly mode: "QUANT_TRADING" | "QUANT_RESEARCH" }>,
  envelope: CommandEnvelope
): Promise<boolean> {
  if (!writer.getState().started) return false;
  await writer.execute(
    envelope,
    {
      operation: "START_SESSION",
      payload: {
        configuration: commandIdentityValue(composition.configuration),
        problem: null
      }
    },
    StartedResultSchema,
    () => {
      throw new Error("Session already started");
    }
  );
  return true;
}

function secureUint32Seed(): number {
  return randomBytes(4).readUInt32BE(0);
}

function parseSeed(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("Production quant seed source returned an invalid seed");
  }
  return value;
}

function quantResearchFamily(value: string) {
  const family = QUANT_RESEARCH_FAMILIES.find((candidate) => candidate === value);
  if (family === undefined) throw new Error("Configured Quant Research family is not available");
  return family;
}

export class ProductionSessionRuntime {
  readonly #seedSource: () => number;

  public constructor(options: ProductionSessionRuntimeOptions = {}) {
    this.#seedSource = options.seedSource ?? secureUint32Seed;
  }

  public async startConfigured(
    writer: SessionWriter,
    composition: InterviewSessionComposition,
    envelope: CommandEnvelope
  ): Promise<void> {
    switch (composition.mode) {
      case "OXFORD_MATHEMATICS":
        await new TurnCoordinator(writer).startConfiguredSession({
          configuration: composition.configuration,
          problem: composition.problem
        }, envelope);
        return;
      case "QUANT_TRADING":
        if (await replayQuantStartWithoutNewSeed(writer, composition, envelope)) return;
        await new QuantTradingSessionCoordinator(writer).initializeConfigured(
          composition.configuration,
          parseSeed(this.#seedSource()),
          envelope
        );
        return;
      case "QUANT_RESEARCH": {
        if (await replayQuantStartWithoutNewSeed(writer, composition, envelope)) return;
        const definition = createProductionQuantResearchDefinition(
          quantResearchFamily(composition.configuration.scenario.id),
          parseSeed(this.#seedSource())
        );
        await new QuantResearchCoordinator(writer).initializeConfigured(
          composition.configuration,
          definition,
          envelope
        );
        return;
      }
    }
  }

  public readQuantState(
    writer: SessionWriter,
    composition: InterviewSessionComposition
  ): QuantProductionPublicState {
    switch (composition.mode) {
      case "OXFORD_MATHEMATICS":
        throw new Error("Oxford Mathematics sessions do not expose quant runtime state");
      case "QUANT_TRADING":
        return {
          mode: composition.mode,
          state: new QuantTradingSessionCoordinator(writer).getPublicState()
        };
      case "QUANT_RESEARCH":
        return {
          mode: composition.mode,
          state: new QuantResearchCoordinator(writer).getPublicState()
        };
    }
  }

  public async applyTradingAction(
    writer: SessionWriter,
    composition: InterviewSessionComposition,
    actionInput: QuantTradingCandidateAction,
    envelope: CommandEnvelope
  ) {
    if (composition.mode !== "QUANT_TRADING") {
      throw new Error("Quant Trading action was sent to a non-Trading session");
    }
    const action = QuantTradingCandidateActionSchema.parse(actionInput);
    return new QuantTradingSessionCoordinator(writer).applyAction(action, envelope);
  }

  public async applyResearchAction(
    writer: SessionWriter,
    composition: InterviewSessionComposition,
    actionInput: QuantResearchCandidateAction,
    envelope: CommandEnvelope
  ) {
    if (composition.mode !== "QUANT_RESEARCH") {
      throw new Error("Quant Research action was sent to a non-Research session");
    }
    const action = QuantResearchCandidateActionSchema.parse(actionInput);
    return new QuantResearchCoordinator(writer).applyAction(action, envelope);
  }
}
