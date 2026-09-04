import { z } from "zod";
import {
  CommandEnvelopeSchema,
  ContextCompilationManifestSchema,
  GenerationIdSchema,
  type CommandEnvelope,
  type ContextCompilationManifest,
  type GenerationId,
  type InterviewProblem
} from "../../domain/src/index.js";
import type { SessionState } from "../../events/src/index.js";
import { isGenerationBasisStillCompatible } from "./compatibility.js";
import {
  CompiledContextSchema,
  canonicalJson,
  compileContext,
  createContextCompilationManifest,
  createProviderContextSpecFingerprint,
  createProviderContextSpecFingerprintSync,
  type CompiledContext
} from "./context-compiler.js";
import { createCommandEnvelope } from "./envelopes.js";
import { selectPedagogicalAction } from "./pedagogical-policy.js";
import type { SessionWriter } from "./session-writer.js";

const ContextCompilationFailureReasonSchema = z.enum([
  "UNKNOWN_GENERATION",
  "GENERATION_NOT_ACTIVE",
  "COMMAND_BASIS_MISMATCH",
  "COMPATIBILITY_INCOMPATIBLE",
  "COMPATIBILITY_UNKNOWN",
  "PROBLEM_MISMATCH",
  "PROBLEM_PROVENANCE_UNKNOWN",
  "PROBLEM_DEFINITION_MISMATCH",
  "ACTION_UNAVAILABLE",
  "ACTION_STALE",
  "HASHING_UNAVAILABLE",
  "STATE_CHANGED_DURING_COMPILATION",
  "MANIFEST_CONFLICT"
]);
export type ContextCompilationFailureReason = z.infer<typeof ContextCompilationFailureReasonSchema>;

export const GenerationContextCompilationResultSchema = z.discriminatedUnion("compiled", [
  z.object({
    compiled: z.literal(true),
    context: CompiledContextSchema,
    manifest: ContextCompilationManifestSchema
  }).strict(),
  z.object({
    compiled: z.literal(false),
    generationId: GenerationIdSchema,
    reason: ContextCompilationFailureReasonSchema
  }).strict()
]);
export type GenerationContextCompilationResult = z.infer<typeof GenerationContextCompilationResultSchema>;

type ManifestFactory = typeof createContextCompilationManifest;
type ProblemFingerprintFactory = typeof createProviderContextSpecFingerprint;

type ContextAssessment =
  | { readonly ok: true; readonly context: CompiledContext }
  | { readonly ok: false; readonly reason: Exclude<ContextCompilationFailureReason, "HASHING_UNAVAILABLE" | "STATE_CHANGED_DURING_COMPILATION" | "MANIFEST_CONFLICT"> };

function assessContext(
  state: Readonly<SessionState>,
  generationId: GenerationId,
  problem: InterviewProblem
): ContextAssessment {
  const generation = state.generations[generationId];
  if (generation === undefined) return { ok: false, reason: "UNKNOWN_GENERATION" };
  if (generation.status !== "ACTIVE") return { ok: false, reason: "GENERATION_NOT_ACTIVE" };

  const compatibility = isGenerationBasisStillCompatible(generation.basis, state);
  if (compatibility === "INCOMPATIBLE") return { ok: false, reason: "COMPATIBILITY_INCOMPATIBLE" };
  if (compatibility === "UNKNOWN") return { ok: false, reason: "COMPATIBILITY_UNKNOWN" };
  if (state.problem?.id !== problem.id || state.problem.version !== problem.version) {
    return { ok: false, reason: "PROBLEM_MISMATCH" };
  }
  if (state.problem.providerContextSpecSha256 === undefined) {
    return { ok: false, reason: "PROBLEM_PROVENANCE_UNKNOWN" };
  }
  let suppliedProblemFingerprint: string;
  try {
    suppliedProblemFingerprint = createProviderContextSpecFingerprintSync(problem);
  } catch {
    return { ok: false, reason: "PROBLEM_DEFINITION_MISMATCH" };
  }
  if (state.problem.providerContextSpecSha256 !== suppliedProblemFingerprint) {
    return { ok: false, reason: "PROBLEM_DEFINITION_MISMATCH" };
  }

  const realizationRequest = state.pedagogicalActions[generation.basis.turnId];
  const generationRequest = generation.pedagogicalAction;
  if (realizationRequest === undefined || generationRequest === undefined) {
    return { ok: false, reason: "ACTION_UNAVAILABLE" };
  }
  if (canonicalJson(realizationRequest) !== canonicalJson(generationRequest)) {
    return { ok: false, reason: "ACTION_STALE" };
  }

  const currentRequest = selectPedagogicalAction(
    state,
    generation.basis.turnId,
    problem
  );
  if (canonicalJson(realizationRequest) !== canonicalJson(currentRequest)) {
    return { ok: false, reason: "ACTION_STALE" };
  }

  return {
    ok: true,
    context: compileContext({
      state,
      problem,
      turnId: generation.basis.turnId,
      realizationRequest,
      generationBasis: generation.basis
    })
  };
}

export class ContextCoordinator {
  public constructor(
    private readonly writer: SessionWriter,
    private readonly manifestFactory: ManifestFactory = createContextCompilationManifest,
    private readonly problemFingerprintFactory: ProblemFingerprintFactory = createProviderContextSpecFingerprint
  ) {}

  public async compileForGeneration(input: {
    readonly generationId: GenerationId;
    readonly problem: InterviewProblem;
    readonly envelope?: CommandEnvelope;
  }) {
    const snapshot = this.writer.getState();
    const snapshotGeneration = snapshot.generations[input.generationId];
    const envelope = CommandEnvelopeSchema.parse(input.envelope ?? createCommandEnvelope({
      sessionId: this.writer.sessionId,
      producer: "context-coordinator",
      generationId: input.generationId,
      ...(snapshotGeneration?.basis.inputEpisodeId === undefined
        ? {}
        : { inputEpisodeId: snapshotGeneration.basis.inputEpisodeId }),
      ...(snapshotGeneration === undefined ? {} : {
        turnId: snapshotGeneration.basis.turnId,
        contextEpoch: snapshotGeneration.basis.contextEpoch,
        sourceRevision: snapshotGeneration.basis.committedInputSequence
      })
    }));

    const snapshotAssessment = assessContext(snapshot, input.generationId, input.problem);
    let prepared: {
      readonly context: CompiledContext;
      readonly manifest: ContextCompilationManifest;
      readonly providerContextSpecSha256: Awaited<ReturnType<ProblemFingerprintFactory>>;
    } | undefined;
    let preparationFailure: ContextCompilationFailureReason | undefined;
    if (!snapshotAssessment.ok) {
      preparationFailure = snapshotAssessment.reason;
    } else if (snapshotGeneration === undefined) {
      preparationFailure = "UNKNOWN_GENERATION";
    } else {
      try {
        const [manifest, providerContextSpecSha256] = await Promise.all([
          this.manifestFactory({
            context: snapshotAssessment.context,
            problem: input.problem,
            generationId: input.generationId,
            generationBasis: snapshotGeneration.basis
          }),
          this.problemFingerprintFactory(input.problem)
        ]);
        prepared = {
          context: snapshotAssessment.context,
          manifest,
          providerContextSpecSha256
        };
      } catch {
        preparationFailure = "HASHING_UNAVAILABLE";
      }
    }

    return this.writer.execute(envelope, {
      operation: "COMPILE_GENERATION_CONTEXT",
      payload: {
        generationId: input.generationId,
        problemId: input.problem.id,
        problemVersion: input.problem.version
      }
    }, GenerationContextCompilationResultSchema, (state) => {
      const fail = (reason: ContextCompilationFailureReason) => ({
        drafts: [],
        result: { compiled: false as const, generationId: input.generationId, reason }
      });
      if (prepared === undefined) return fail(preparationFailure ?? "HASHING_UNAVAILABLE");

      const envelopeGeneration = state.generations[input.generationId];
      if (
        envelopeGeneration !== undefined
        && (
          envelope.generationId !== input.generationId
          || envelope.inputEpisodeId !== envelopeGeneration.basis.inputEpisodeId
          || envelope.turnId !== envelopeGeneration.basis.turnId
          || envelope.contextEpoch !== envelopeGeneration.basis.contextEpoch
          || envelope.sourceRevision !== envelopeGeneration.basis.committedInputSequence
        )
      ) return fail("COMMAND_BASIS_MISMATCH");

      const currentAssessment = assessContext(state, input.generationId, input.problem);
      if (!currentAssessment.ok) return fail(currentAssessment.reason);
      if (state.problem?.providerContextSpecSha256 !== prepared.providerContextSpecSha256) {
        return fail("PROBLEM_DEFINITION_MISMATCH");
      }
      if (canonicalJson(currentAssessment.context) !== canonicalJson(prepared.context)) {
        return fail("STATE_CHANGED_DURING_COMPILATION");
      }

      const generation = state.generations[input.generationId];
      if (generation === undefined) return fail("UNKNOWN_GENERATION");
      const existing = generation.contextManifest;
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(prepared.manifest)) return fail("MANIFEST_CONFLICT");
        return { drafts: [], result: { compiled: true as const, context: prepared.context, manifest: existing } };
      }

      return {
        drafts: [{
          source: "APPLICATION",
          type: "GENERATION_CONTEXT_COMPILED",
          payload: { generationId: input.generationId, manifest: prepared.manifest }
        }],
        result: { compiled: true as const, context: prepared.context, manifest: prepared.manifest }
      };
    });
  }
}
