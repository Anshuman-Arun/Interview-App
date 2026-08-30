import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InterviewProblem } from "../packages/domain/src/index.js";
import { replaySession } from "../packages/events/src/index.js";
import {
  ContextCoordinator,
  createProviderContextSpecFingerprint,
  SessionRuntimeRegistry
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { createCoreHarness, providerEnvelope } from "./harness.js";

describe("session-bound problem provenance", () => {
  it("fingerprints every provider-visible problem field but excludes private solution material", async () => {
    const original = await createProviderContextSpecFingerprint(sixPeopleProblem);
    const privateOnly = problemWith({
      private: {
        canonicalSolution: "A replacement private solution.",
        verificationNotes: "Replacement private verification notes."
      }
    });
    const changedPrompt = problemWith({
      public: { ...sixPeopleProblem.public, prompt: "A substituted public prompt." }
    });
    const changedGraph = problemWith({
      interviewer: {
        ...sixPeopleProblem.interviewer,
        reasoningGraph: { ...sixPeopleProblem.interviewer.reasoningGraph, version: "substituted-graph" }
      }
    });
    const changedDisclosure = problemWith({
      interviewer: { ...sixPeopleProblem.interviewer, protectedDisclosures: [] }
    });

    await expect(createProviderContextSpecFingerprint(privateOnly)).resolves.toBe(original);
    await expect(createProviderContextSpecFingerprint(changedPrompt)).resolves.not.toBe(original);
    await expect(createProviderContextSpecFingerprint(changedGraph)).resolves.not.toBe(original);
    await expect(createProviderContextSpecFingerprint(changedDisclosure)).resolves.not.toBe(original);
  });

  it("persists only the safe problem-contract fingerprint and reconstructs it on replay", async () => {
    const harness = await createCoreHarness();
    try {
      const expected = await createProviderContextSpecFingerprint(sixPeopleProblem);
      const problemEvent = harness.store.load(harness.sessionId).find((event) => event.type === "PROBLEM_PRESENTED");
      expect(problemEvent?.payload).toMatchObject({ providerContextSpecSha256: expected });
      expect(harness.writer.getState().problem?.providerContextSpecSha256).toBe(expected);
      expect(replaySession(harness.sessionId, harness.store.load(harness.sessionId))).toEqual(harness.writer.getState());

      const serialized = JSON.stringify(problemEvent);
      expect(serialized).not.toContain(sixPeopleProblem.private.canonicalSolution);
      expect(serialized).not.toContain(sixPeopleProblem.private.verificationNotes);
    } finally {
      harness.store.close();
    }
  });

  it.each([
    ["prompt", problemWith({ public: { ...sixPeopleProblem.public, prompt: "Injected same-version prompt." } })],
    ["reasoning graph", problemWith({
      interviewer: {
        ...sixPeopleProblem.interviewer,
        reasoningGraph: { ...sixPeopleProblem.interviewer.reasoningGraph, version: "same-id-substitution" }
      }
    })],
    ["protected disclosures", problemWith({
      interviewer: { ...sixPeopleProblem.interviewer, protectedDisclosures: [] }
    })]
  ])("rejects a same-ID/version %s substitution before context persistence", async (_name, substitutedProblem) => {
    const harness = await createCoreHarness();
    try {
      const before = harness.store.eventCount(harness.sessionId);
      const result = await new ContextCoordinator(harness.writer).compileForGeneration({
        generationId: harness.generationId,
        problem: substitutedProblem
      });
      expect(result.value).toMatchObject({ compiled: false, reason: "PROBLEM_DEFINITION_MISMATCH" });
      expect(result.appendedEventCount).toBe(0);
      expect(harness.store.eventCount(harness.sessionId)).toBe(before);
    } finally {
      harness.store.close();
    }
  });

  it("allows private-only authoring changes because private material is never provider context", async () => {
    const harness = await createCoreHarness();
    try {
      const privateOnly = problemWith({
        private: {
          canonicalSolution: "Changed private solution.",
          verificationNotes: "Changed private notes."
        }
      });
      const result = await new ContextCoordinator(harness.writer).compileForGeneration({
        generationId: harness.generationId,
        problem: privateOnly
      });
      expect(result.value.compiled).toBe(true);
      if (!result.value.compiled) throw new Error("Expected context compilation");
      expect(JSON.stringify(result.value.context)).not.toContain(privateOnly.private.canonicalSolution);
    } finally {
      harness.store.close();
    }
  });

  it("rejects proposal admission when protected-disclosure metadata is substituted", async () => {
    const harness = await createCoreHarness();
    try {
      const result = await harness.turns.processProposal({
        envelope: providerEnvelope(harness),
        problem: problemWith({ interviewer: { ...sixPeopleProblem.interviewer, protectedDisclosures: [] } }),
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          speechText: harness.safeProbe
        },
        validator: harness.validator
      });

      expect(result).toMatchObject({
        accepted: false,
        deliveryAtoms: [],
        reason: "Problem definition does not match the session-bound provider context contract"
      });
      expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("REJECTED");
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("upcasts schema-v1 sessions but refuses provider context when provenance cannot be reconstructed", async () => {
    const source = await createCoreHarness();
    const rawEvents = source.store.load(source.sessionId).map((event) => {
      const legacy = JSON.parse(JSON.stringify(event)) as Record<string, unknown> & {
        payload: Record<string, unknown>;
      };
      legacy.schemaVersion = 1;
      if (legacy.type === "PROBLEM_PRESENTED") delete legacy.payload.providerContextSpecSha256;
      return legacy;
    });
    source.store.close();

    const directory = mkdtempSync(join(tmpdir(), "legacy-problem-provenance-"));
    const path = join(directory, "events.sqlite");
    let store = new SqliteEventStore(path);
    store.close();
    try {
      const database = new DatabaseSync(path);
      const insert = database.prepare(`
        INSERT INTO session_events (session_id, sequence, event_id, schema_version, event_type, event_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const event of rawEvents) {
        insert.run(
          event.sessionId as string,
          event.sequence as number,
          event.eventId as string,
          1,
          event.type as string,
          JSON.stringify(event)
        );
      }
      database.close();

      store = new SqliteEventStore(path);
      const writer = new SessionRuntimeRegistry(store).get(source.sessionId);
      expect(writer.getState().problem?.providerContextSpecSha256).toBeUndefined();
      const result = await new ContextCoordinator(writer).compileForGeneration({
        generationId: source.generationId,
        problem: sixPeopleProblem
      });
      expect(result.value).toMatchObject({ compiled: false, reason: "PROBLEM_PROVENANCE_UNKNOWN" });
      expect(result.appendedEventCount).toBe(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function problemWith(overrides: Partial<InterviewProblem>): InterviewProblem {
  return {
    ...sixPeopleProblem,
    ...overrides
  };
}
