import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  newGenerationId,
  newInputEpisodeId,
  newRequestId,
  type InterviewProblem
} from "../packages/domain/src/index.js";
import { replaySession } from "../packages/events/src/index.js";
import {
  ContextCoordinator,
  canonicalJson,
  compileContext,
  createCommandEnvelope,
  createContextCompilationManifest,
  SessionRuntimeRegistry
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { createCoreHarness, type CoreHarness } from "./harness.js";

describe("generation context reproducibility", () => {
  it("persists a deterministic manifest without private problem content", async () => {
    const harness = await createCoreHarness();
    const before = harness.store.eventCount(harness.sessionId);
    const compiled = await new ContextCoordinator(harness.writer).compileForGeneration({
      generationId: harness.generationId,
      problem: sixPeopleProblem
    });

    expect(compiled.value.compiled).toBe(true);
    expect(compiled.appendedEventCount).toBe(1);
    if (!compiled.value.compiled) throw new Error("Expected context compilation");
    expect(compiled.value.manifest).toMatchObject({
      schemaVersion: 1,
      compilerVersion: "phase0-safe-context@2",
      hashAlgorithm: "SHA-256",
      generationId: harness.generationId,
      problemId: sixPeopleProblem.id,
      problemVersion: sixPeopleProblem.version
    });
    expect(compiled.value.manifest.contextSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(compiled.value.manifest.reasoningGraphSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(harness.store.eventCount(harness.sessionId)).toBe(before + 1);
    expect(harness.writer.getState().generations[harness.generationId]?.contextManifest)
      .toEqual(compiled.value.manifest);

    const serializedContext = JSON.stringify(compiled.value.context);
    const serializedEvent = JSON.stringify(harness.store.load(harness.sessionId).at(-1));
    expect(serializedContext).not.toContain(sixPeopleProblem.private.canonicalSolution);
    expect(serializedContext).not.toContain(sixPeopleProblem.private.verificationNotes);
    expect(serializedEvent).not.toContain(harness.writer.getState().turns[harness.turnId]?.studentText);
    expect(serializedEvent).not.toContain(sixPeopleProblem.private.canonicalSolution);
    expect(replaySession(harness.sessionId, harness.store.load(harness.sessionId))).toEqual(harness.writer.getState());
    harness.store.close();
  });

  it("rejects accessor-backed canonical JSON without executing the accessor", () => {
    let getterCalls = 0;
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "dangerous", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      }
    });

    expect(() => canonicalJson(value)).toThrow(/own data properties/u);
    expect(getterCalls).toBe(0);
  });

  it("rejects sparse arrays instead of treating missing elements as implicit data", () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = "present";
    expect(() => canonicalJson(sparse)).toThrow(/own data elements/u);
  });

  it("produces stable safe-context and graph hashes independent of object key order and private content", async () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(canonicalJson({ a: { b: 3, y: 2 }, z: 1 })).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(canonicalJson({ "é": 3, a: 2, A: 1 })).toBe('{"A":1,"a":2,"é":3}');

    const harness = await createCoreHarness();
    const generation = generationState(harness);
    const request = harness.writer.getState().pedagogicalActions[harness.turnId];
    if (request === undefined) throw new Error("Expected pedagogical action");
    const context = compileContext({
      state: harness.writer.getState(),
      problem: sixPeopleProblem,
      turnId: harness.turnId,
      realizationRequest: request
    });
    const privateModified: InterviewProblem = {
      ...sixPeopleProblem,
      private: {
        canonicalSolution: "A different private solution that must not affect provider context identity.",
        verificationNotes: "Different private verifier notes."
      }
    };
    const original = await createContextCompilationManifest({
      context,
      problem: sixPeopleProblem,
      generationId: harness.generationId,
      generationBasis: generation.basis
    });
    const changedPrivate = await createContextCompilationManifest({
      context,
      problem: privateModified,
      generationId: harness.generationId,
      generationBasis: generation.basis
    });
    expect(changedPrivate.contextSha256).toBe(original.contextSha256);
    expect(changedPrivate.reasoningGraphSha256).toBe(original.reasoningGraphSha256);

    const changedGraph: InterviewProblem = {
      ...sixPeopleProblem,
      interviewer: {
        ...sixPeopleProblem.interviewer,
        reasoningGraph: {
          ...sixPeopleProblem.interviewer.reasoningGraph,
          version: "1.0.1"
        }
      }
    };
    const graphManifest = await createContextCompilationManifest({
      context,
      problem: changedGraph,
      generationId: harness.generationId,
      generationBasis: generation.basis
    });
    expect(graphManifest.contextSha256).toBe(original.contextSha256);
    expect(graphManifest.reasoningGraphSha256).not.toBe(original.reasoningGraphSha256);
    harness.store.close();
  });

  it("coalesces semantic context compilation under concurrent distinct commands", async () => {
    const harness = await createCoreHarness();
    const coordinator = new ContextCoordinator(harness.writer);
    const before = harness.store.eventCount(harness.sessionId);
    const [left, right] = await Promise.all([
      coordinator.compileForGeneration({ generationId: harness.generationId, problem: sixPeopleProblem }),
      coordinator.compileForGeneration({ generationId: harness.generationId, problem: sixPeopleProblem })
    ]);

    expect(left.value.compiled).toBe(true);
    expect(right.value.compiled).toBe(true);
    expect([left.appendedEventCount, right.appendedEventCount].sort()).toEqual([0, 1]);
    if (!left.value.compiled || !right.value.compiled) throw new Error("Expected both callers to receive context");
    expect(left.value.manifest).toEqual(right.value.manifest);
    expect(harness.store.eventCount(harness.sessionId)).toBe(before + 1);
    expect(harness.store.load(harness.sessionId).filter((event) => event.type === "GENERATION_CONTEXT_COMPILED"))
      .toHaveLength(1);
    harness.store.close();
  });

  it("returns the persisted compilation result after application restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "context-manifest-"));
    const databasePath = join(directory, "events.sqlite");
    let store = new SqliteEventStore(databasePath);
    try {
      const harness = await createCoreHarness(store);
      const basis = generationState(harness).basis;
      const envelope = createCommandEnvelope({
        sessionId: harness.sessionId,
        producer: "context-coordinator",
        requestId: newRequestId(),
        generationId: harness.generationId,
        inputEpisodeId: harness.inputEpisodeId,
        turnId: harness.turnId,
        contextEpoch: basis.contextEpoch,
        sourceRevision: basis.committedInputSequence
      });
      const first = await new ContextCoordinator(harness.writer).compileForGeneration({
        generationId: harness.generationId,
        problem: sixPeopleProblem,
        envelope
      });
      const count = store.eventCount(harness.sessionId);
      store.close();

      store = new SqliteEventStore(databasePath);
      const writer = new SessionRuntimeRegistry(store).get(harness.sessionId);
      const duplicate = await new ContextCoordinator(writer).compileForGeneration({
        generationId: harness.generationId,
        problem: sixPeopleProblem,
        envelope
      });
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.value).toEqual(first.value);
      expect(store.eventCount(harness.sessionId)).toBe(count);
      expect(replaySession(harness.sessionId, store.load(harness.sessionId))).toEqual(writer.getState());
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for stale, unknown, and mismatched generation provenance", async () => {
    const staleHarness = await createCoreHarness();
    await staleHarness.turns.commitBoardPatch("Student changed the board after generation start.");
    const stale = await new ContextCoordinator(staleHarness.writer).compileForGeneration({
      generationId: staleHarness.generationId,
      problem: sixPeopleProblem
    });
    expect(stale.value).toMatchObject({ compiled: false, reason: "GENERATION_NOT_ACTIVE" });
    expect(staleHarness.store.load(staleHarness.sessionId).some((event) => event.type === "GENERATION_CONTEXT_COMPILED"))
      .toBe(false);
    staleHarness.store.close();

    const unknownHarness = await createCoreHarness();
    const unknown = await new ContextCoordinator(unknownHarness.writer).compileForGeneration({
      generationId: newGenerationId(),
      problem: sixPeopleProblem
    });
    expect(unknown.value).toMatchObject({ compiled: false, reason: "UNKNOWN_GENERATION" });
    unknownHarness.store.close();

    const compatibilityHarness = await createCoreHarness();
    const missingEpisodeId = newInputEpisodeId();
    await expect(
      compatibilityHarness.turns.startGeneration(
        missingEpisodeId,
        compatibilityHarness.turnId,
        "mock-model"
      )
    ).rejects.toThrow(/committed InputEpisode/u);
    compatibilityHarness.store.close();

    const mismatchHarness = await createCoreHarness();
    const mismatchBasis = generationState(mismatchHarness).basis;
    const mismatch = await new ContextCoordinator(mismatchHarness.writer).compileForGeneration({
      generationId: mismatchHarness.generationId,
      problem: sixPeopleProblem,
      envelope: createCommandEnvelope({
        sessionId: mismatchHarness.sessionId,
        producer: "context-coordinator",
        generationId: mismatchHarness.generationId,
        inputEpisodeId: mismatchHarness.inputEpisodeId,
        turnId: mismatchHarness.turnId,
        contextEpoch: mismatchBasis.contextEpoch,
        sourceRevision: mismatchBasis.committedInputSequence + 1
      })
    });
    expect(mismatch.value).toMatchObject({ compiled: false, reason: "COMMAND_BASIS_MISMATCH" });
    mismatchHarness.store.close();
  });

  it("rechecks compatibility after asynchronous hashing and fails closed when hashing is unavailable", async () => {
    const raceHarness = await createCoreHarness();
    let releaseHash: (() => void) | undefined;
    let hashingStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { hashingStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseHash = resolve; });
    const racingCoordinator = new ContextCoordinator(raceHarness.writer, async (input) => {
      hashingStarted?.();
      await release;
      return createContextCompilationManifest(input);
    });
    const pending = racingCoordinator.compileForGeneration({
      generationId: raceHarness.generationId,
      problem: sixPeopleProblem
    });
    await started;
    await raceHarness.turns.commitBoardPatch("Revision changed while context hashes were computing.");
    releaseHash?.();
    const raced = await pending;
    expect(raced.value).toMatchObject({ compiled: false, reason: "GENERATION_NOT_ACTIVE" });
    expect(raceHarness.store.load(raceHarness.sessionId).some((event) => event.type === "GENERATION_CONTEXT_COMPILED"))
      .toBe(false);
    raceHarness.store.close();

    const failedHarness = await createCoreHarness();
    const failed = await new ContextCoordinator(failedHarness.writer, () => Promise.reject(new Error("hash internals")))
      .compileForGeneration({ generationId: failedHarness.generationId, problem: sixPeopleProblem });
    expect(failed.value).toMatchObject({ compiled: false, reason: "HASHING_UNAVAILABLE" });
    expect(JSON.stringify(failedHarness.store.load(failedHarness.sessionId))).not.toContain("hash internals");
    failedHarness.store.close();
  });
});

function generationState(harness: CoreHarness) {
  const generation = harness.writer.getState().generations[harness.generationId];
  if (generation === undefined) throw new Error("Expected generation state");
  return generation;
}
