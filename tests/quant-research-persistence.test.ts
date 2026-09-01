import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { newSessionId } from "../packages/domain/src/index.js";
import { QuantResearchAuthoritativeSnapshotEventSchema } from "../packages/events/src/index.js";
import {
  QuantResearchCoordinator,
  SessionWriter,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import {
  QUANT_RESEARCH_GENERATOR_VERSION,
  QUANT_RESEARCH_RNG_VERSION,
  QUANT_RESEARCH_VERIFIER_VERSION,
  QUANT_RESEARCH_VERSION,
  QuantResearchEngine,
  type QuantResearchScenarioDefinition
} from "../packages/local-compute/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";

interface StoreWithDatabase {
  readonly database: DatabaseSync;
}

const modelDefinition: QuantResearchScenarioDefinition = {
  family: "MODEL_COMPARISON",
  version: QUANT_RESEARCH_VERSION,
  generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION,
  seed: 1234,
  config: { observationCount: 10, noiseRadius: 2, outlierShift: 30 }
};

const persistenceDefinitions: readonly QuantResearchScenarioDefinition[] = [
  {
    family: "BAYESIAN_UPDATING",
    version: QUANT_RESEARCH_VERSION,
    generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
    rngVersion: QUANT_RESEARCH_RNG_VERSION,
    seed: 17,
    config: { priorAlpha: 2, priorBeta: 3, observationCount: 8, perturbedPriorAlpha: 5, perturbedPriorBeta: 2 }
  },
  {
    family: "SAMPLING_ESTIMATION",
    version: QUANT_RESEARCH_VERSION,
    generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
    rngVersion: QUANT_RESEARCH_RNG_VERSION,
    seed: 91,
    config: { maxSamples: 10, populationSize: 32, centerMin: -20, centerMax: 20, noiseRadius: 4, outlierShift: 25 }
  },
  {
    family: "EXPERIMENTAL_ALLOCATION",
    version: QUANT_RESEARCH_VERSION,
    generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
    rngVersion: QUANT_RESEARCH_RNG_VERSION,
    seed: 808,
    config: { totalBudget: 20, costA: 2, costB: 4, perturbedCostA: 5, perturbedCostB: 2, noiseA: 2, noiseB: 5 }
  },
  modelDefinition,
  {
    family: "CONSTRAINED_OPTIMIZATION",
    version: QUANT_RESEARCH_VERSION,
    generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
    rngVersion: QUANT_RESEARCH_RNG_VERSION,
    seed: 42,
    config: { budget: 30, perturbedBudget: 24, maxX: 15, maxY: 10, perturbedPenalty: 5 }
  }
];

describe("Quant Research authoritative persistence", () => {
  it("serializes every family authoritative snapshot through the bounded event wire schema", () => {
    for (const definition of persistenceDefinitions) {
      const snapshot = new QuantResearchEngine(definition).getAuthoritativePersistenceSnapshot();
      expect(QuantResearchAuthoritativeSnapshotEventSchema.parse(snapshot)).toEqual(snapshot);
    }
  });


  it("persists and replays a completed vertical slice for every Quant Research family", async () => {
    const actionsFor = (family: QuantResearchScenarioDefinition["family"]): readonly unknown[] => {
      switch (family) {
        case "BAYESIAN_UPDATING":
          return [
            { actionId: "family-b1", kind: "SUBMIT_PROBABILITY", value: 0.5 },
            { actionId: "family-b2", kind: "SUBMIT_PROBABILITY", value: 0.5 },
            { actionId: "family-b3", kind: "SUBMIT_PROBABILITY", value: 0.5 }
          ];
        case "SAMPLING_ESTIMATION":
          return [
            { actionId: "family-s1", kind: "REQUEST_OBSERVATION", count: 2 },
            { actionId: "family-s2", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 0 },
            { actionId: "family-s3", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 0 }
          ];
        case "EXPERIMENTAL_ALLOCATION":
          return [
            { actionId: "family-e1", kind: "ALLOCATE_SAMPLE", a: 2, b: 4 },
            { actionId: "family-e2", kind: "CHOOSE_OPTION", option: "A" },
            { actionId: "family-e3", kind: "ALLOCATE_SAMPLE", a: 2, b: 5 }
          ];
        case "MODEL_COMPARISON":
          return [
            { actionId: "family-m1", kind: "CHOOSE_OPTION", option: "CONSTANT" },
            { actionId: "family-m2", kind: "CHOOSE_OPTION", option: "CONSTANT" }
          ];
        case "CONSTRAINED_OPTIMIZATION":
          return [
            { actionId: "family-o1", kind: "SUBMIT_PARAMETERS", values: [0, 0] },
            { actionId: "family-o2", kind: "SUBMIT_PARAMETERS", values: [0, 0] }
          ];
      }
    };

    for (const definition of persistenceDefinitions) {
      const store = new SqliteEventStore(":memory:");
      const sessionId = newSessionId();
      const writer = SessionWriter.open(store, sessionId);
      try {
        const coordinator = new QuantResearchCoordinator(writer);
        await coordinator.initialize(definition);
        for (const action of actionsFor(definition.family)) {
          await coordinator.applyAction(action);
        }
        expect(coordinator.replay().result.status).toBe("COMPLETE");
        const beforeRestart = coordinator.replay();
        await writer.close();

        const reopened = SessionWriter.open(store, sessionId);
        try {
          const afterRestart = new QuantResearchCoordinator(reopened).replay();
          expect(afterRestart).toEqual(beforeRestart);
          expect(afterRestart.state.family).toBe(definition.family);
          expect(afterRestart.result.acceptedActionCount).toBe(actionsFor(definition.family).length);
        } finally {
          await reopened.close();
        }
      } finally {
        await writer.close();
        store.close();
      }
    }
  });

  it("persists the complete vertical slice and reconstructs it exactly after restart", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const coordinator = new QuantResearchCoordinator(writer);

    try {
      const initialized = await coordinator.initialize(modelDefinition);
      expect(initialized.duplicate).toBe(false);
      expect(initialized.appendedEventCount).toBe(3);
      expect(initialized.value.state.stage).toBe("INITIAL_MODEL_CHOICE");
      expect(JSON.stringify(initialized.value)).not.toContain("hiddenModel");

      const first = await coordinator.applyAction({
        actionId: "persist-model-1",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      });
      expect(first.appendedEventCount).toBe(1);
      expect(first.value.state.stage).toBe("OUTLIER_MODEL_CHOICE");

      const completed = await coordinator.applyAction({
        actionId: "persist-model-2",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      });
      expect(completed.appendedEventCount).toBe(3);
      expect(completed.value.result.status).toBe("COMPLETE");

      const events = store.load(sessionId);
      expect(events.map((event) => event.type)).toEqual([
        "SESSION_STARTED",
        "PROBLEM_PRESENTED",
        "QUANT_RESEARCH_SCENARIO_INITIALIZED",
        "QUANT_RESEARCH_ACTION_ACCEPTED",
        "QUANT_RESEARCH_ACTION_ACCEPTED",
        "QUANT_RESEARCH_SCENARIO_COMPLETED",
        "SESSION_COMPLETED"
      ]);
      const initializedEvent = events.find((event) => event.type === "QUANT_RESEARCH_SCENARIO_INITIALIZED");
      expect(initializedEvent?.payload.authoritativeSnapshot.verifierVersion).toBe(QUANT_RESEARCH_VERIFIER_VERSION);
      expect(initializedEvent?.payload.authoritativeSnapshot.family).toBe("MODEL_COMPARISON");
      expect(writer.getState().status).toBe("COMPLETED");
      expect(writer.getState().quantResearch?.actions).toHaveLength(2);
      expect(writer.getState().quantResearch?.result?.status).toBe("COMPLETE");

      const beforeRestart = coordinator.replay();
      await writer.close();

      const reopened = SessionWriter.open(store, sessionId);
      try {
        const afterRestart = new QuantResearchCoordinator(reopened).replay();
        expect(afterRestart).toEqual(beforeRestart);
        expect(afterRestart.acceptedActions.map((action) => action.actionId)).toEqual([
          "persist-model-1",
          "persist-model-2"
        ]);
      } finally {
        await reopened.close();
      }
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("uses SessionWriter request idempotency without duplicating Quant Research events", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const coordinator = new QuantResearchCoordinator(writer);

    try {
      const initializeEnvelope = createCommandEnvelope({
        sessionId,
        producer: "quant-persistence-test"
      });
      const firstInitialize = await coordinator.initialize(modelDefinition, initializeEnvelope);
      const repeatedInitialize = await coordinator.initialize(modelDefinition, initializeEnvelope);
      expect(firstInitialize.duplicate).toBe(false);
      expect(repeatedInitialize.duplicate).toBe(true);
      expect(repeatedInitialize.appendedEventCount).toBe(0);
      expect(store.eventCount(sessionId)).toBe(3);

      const actionEnvelope = createCommandEnvelope({
        sessionId,
        producer: "quant-persistence-test"
      });
      const action = {
        actionId: "idempotent-model-action",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      } as const;
      const firstAction = await coordinator.applyAction(action, actionEnvelope);
      const repeatedAction = await coordinator.applyAction(action, actionEnvelope);
      expect(firstAction.duplicate).toBe(false);
      expect(repeatedAction.duplicate).toBe(true);
      expect(repeatedAction.appendedEventCount).toBe(0);
      expect(store.eventCount(sessionId)).toBe(4);
      expect(writer.getState().quantResearch?.actions).toHaveLength(1);
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("fails durable replay when Quant completion is missing the terminal session lifecycle event", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const coordinator = new QuantResearchCoordinator(writer);

    try {
      await coordinator.initialize(modelDefinition);
      await coordinator.applyAction({
        actionId: "lifecycle-model-1",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      });
      await coordinator.applyAction({
        actionId: "lifecycle-model-2",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      });
      await writer.close();

      const db = (store as unknown as StoreWithDatabase).database;
      db.prepare(
        "DELETE FROM session_events WHERE session_id = ? AND sequence = 7"
      ).run(sessionId);

      const reopened = SessionWriter.open(store, sessionId);
      try {
        expect(() => new QuantResearchCoordinator(reopened).replay())
          .toThrow(/terminal session lifecycle event/u);
      } finally {
        await reopened.close();
      }
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("detects schema-valid tampering of persisted generated parameters during deterministic replay", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const coordinator = new QuantResearchCoordinator(writer);

    try {
      await coordinator.initialize(modelDefinition);
      await writer.close();

      const db = (store as unknown as StoreWithDatabase).database;
      const row = db.prepare(
        "SELECT event_json FROM session_events WHERE session_id = ? AND sequence = 3"
      ).get(sessionId) as { event_json: string } | undefined;
      if (row === undefined) throw new Error("Expected Quant Research initialization event");

      const parsed = JSON.parse(row.event_json) as {
        type: string;
        payload: {
          authoritativeSnapshot: {
            generatedParameters: { hiddenIntercept: number };
          };
        };
      };
      expect(parsed.type).toBe("QUANT_RESEARCH_SCENARIO_INITIALIZED");
      parsed.payload.authoritativeSnapshot.generatedParameters.hiddenIntercept += 1;
      db.prepare(
        "UPDATE session_events SET event_json = ? WHERE session_id = ? AND sequence = 3"
      ).run(JSON.stringify(parsed), sessionId);

      const reopened = SessionWriter.open(store, sessionId);
      try {
        const replayCoordinator = new QuantResearchCoordinator(reopened);
        expect(() => replayCoordinator.replay()).toThrow(/generated parameters or grading data/u);
      } finally {
        await reopened.close();
      }
    } finally {
      await writer.close();
      store.close();
    }
  });
});
