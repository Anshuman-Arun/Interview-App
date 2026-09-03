import {
  FormalInterpretationRequestSchema,
  InterpretationProviderResultSchema,
  type FormalInterpretationRequest,
  type InterpretationProviderResult
} from "../../../packages/domain/src/index.js";
import type {
  FormalInterpretationProvider
} from "../../../packages/interview-engine/src/index.js";
import type { SessionState } from "../../../packages/events/src/index.js";
import {
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_PROVIDER_ID,
  AntigravityCliFormalInterpretationError,
  createAntigravityCliFormalInterpretationAdapter,
  openProviderExecutionSession
} from "../../../packages/providers/src/index.js";
import { resolveSessionStateComposition } from "./interview-session-composition.js";
import { resolveOxfordFormalAnalysisProfile } from "./oxford-formal-analysis-catalog.js";
import {
  isOxfordFormalCandidateTargetAdmissible
} from "./oxford-formal-candidate-admission.js";
import type { ProviderRuntimeResolver } from "./provider-runtime.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";

export class ProviderBackedFormalInterpretationProvider
implements FormalInterpretationProvider {
  public constructor(
    private readonly sessions: SessionRecoveryCoordinator,
    private readonly providerRuntime: ProviderRuntimeResolver
  ) {}

  public async interpret(
    input: FormalInterpretationRequest,
    runtime?: { readonly signal: AbortSignal }
  ): Promise<unknown> {
    const parsed = FormalInterpretationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("Formal interpretation provider received an invalid application request");
    }
    const request = parsed.data;
    const signal = runtime?.signal ?? new AbortController().signal;
    if (abortRequested(signal)) return abstain(request);

    let composition: ReturnType<typeof resolveSessionStateComposition>;
    try {
      const writer = this.sessions.getWriter(request.sessionId);
      const state = writer.getState();
      if (!requestStillCurrent(request, state)) return abstain(request);
      composition = resolveSessionStateComposition(state);
    } catch {
      return abstain(request);
    }

    if (composition.mode !== "OXFORD_MATHEMATICS") return abstain(request);
    const profile = resolveOxfordFormalAnalysisProfile(composition.problem);
    if (profile === undefined) return abstain(request);
    const selection = composition.configuration.providerSelection;

    // Formal interpretation derives from the exact user-selected reasoning
    // provider. Never silently switch to a different remote or paid provider.
    if (
      selection === undefined
      || selection.providerId !== ANTIGRAVITY_CLI_PROVIDER_ID
      || selection.modelId !== ANTIGRAVITY_CLI_MODEL_ID
    ) {
      return abstain(request);
    }

    let resolved: Awaited<ReturnType<ProviderRuntimeResolver["resolve"]>>;
    try {
      const resolutionWork = this.providerRuntime.resolve({
        selection,
        cancellationRequested: () => abortRequested(signal)
      });
      const resolution = await settleUnlessAborted(resolutionWork, signal);
      if (resolution === ABORTED) return abstain(request);
      resolved = resolution;
    } catch {
      return abstain(request);
    }
    if (
      abortRequested(signal)
      || resolved.providerId !== selection.providerId
      || resolved.modelId !== selection.modelId
      || resolved.runtime === undefined
      || resolved.provider.capabilities.structuredOutput === "NONE"
      || !requestRemainsCurrent(this.sessions, request)
    ) {
      return abstain(request);
    }

    // Capture the exact specialized execution operation before the
    // asynchronous billing boundary. A mutable runtime source must not be able
    // to pass provider admission and swap formal execution afterward.
    let adapter: ReturnType<typeof createAntigravityCliFormalInterpretationAdapter>;
    try {
      adapter = createAntigravityCliFormalInterpretationAdapter(
        resolved.runtime,
        resolved.modelId
      );
    } catch {
      return abstain(request);
    }

    // Interpretation is real provider execution, so it receives the same
    // application-owned data-use and billing admission as interviewer
    // generation. Opening this guarded session performs policy admission but
    // does not issue a model turn.
    let admittedSession: Awaited<ReturnType<typeof openProviderExecutionSession>>;
    try {
      const admissionWork = openProviderExecutionSession({
        provider: resolved.provider,
        policy: resolved.policy
      });
      const admission = await settleUnlessAborted(admissionWork, signal);
      if (admission === ABORTED) {
        void admissionWork.then(
          (lateSession) => closeAdmittedSessionBestEffort(lateSession),
          () => undefined
        ).catch(() => undefined);
        return abstain(request);
      }
      admittedSession = admission;
    } catch {
      return abstain(request);
    }
    try {
      if (
        abortRequested(signal)
        || !requestRemainsCurrent(this.sessions, request)
      ) {
        return abstain(request);
      }
      try {
        const publicProblem = {
          id: composition.problem.id,
          version: composition.problem.version,
          prompt: composition.problem.public.prompt,
          givenInformation: composition.problem.public.givenInformation
        } as const;
        const result = await adapter.interpret({
          request,
          publicProblem,
          signal
        });
        if (
          result.candidates.some((candidate) =>
            !isOxfordFormalCandidateTargetAdmissible({
              profile,
              request,
              publicProblem,
              candidate
            })
          )
        ) {
          return abstain(request);
        }
        return result;
      } catch (error) {
        if (
          error instanceof AntigravityCliFormalInterpretationError
          && (
            error.code === "PROCESS_FAILED"
            || error.code === "INVALID_RUNTIME"
          )
        ) {
          return abstain(request);
        }
        throw error;
      }
    } finally {
      // Closing the policy-admission session is cleanup only. Never allow a
      // fallible provider's close hook to hold the formal-analysis slot open
      // after the bounded inference path has otherwise settled.
      closeAdmittedSessionBestEffort(admittedSession);
    }
  }
}

const ABORTED = Symbol("FORMAL_INTERPRETATION_ABORTED");

function abortRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

async function settleUnlessAborted<T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T | typeof ABORTED> {
  if (signal.aborted) return ABORTED;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function closeAdmittedSessionBestEffort(
  session: Awaited<ReturnType<typeof openProviderExecutionSession>>
): void {
  try {
    void Promise.resolve(session.close()).catch(() => undefined);
  } catch {
    // Cleanup is never authoritative and must not escape a bounded analysis.
  }
}

function requestRemainsCurrent(
  sessions: SessionRecoveryCoordinator,
  request: FormalInterpretationRequest
): boolean {
  try {
    return requestStillCurrent(
      request,
      sessions.getWriter(request.sessionId).getState()
    );
  } catch {
    return false;
  }
}

function abstain(
  request: FormalInterpretationRequest
): InterpretationProviderResult {
  return InterpretationProviderResultSchema.parse({
    protocolVersion: 1,
    requestId: request.requestId,
    candidates: []
  });
}

function requestStillCurrent(
  request: FormalInterpretationRequest,
  state: Readonly<SessionState>
): boolean {
  if (
    !state.started
    || state.status !== "ACTIVE"
    || state.sessionId !== request.sessionId
    || state.problem === undefined
    || state.problem.id !== request.problem.id
    || state.problem.version !== request.problem.version
    || state.contextEpoch !== request.basis.contextEpoch
    || state.lastCommittedInputSequence !== request.basis.committedInputSequence
    || state.transcriptRevision !== request.basis.transcriptRevision
    || state.problemStateRevision !== request.basis.problemStateRevision
    || state.policyRevision !== request.basis.policyRevision
  ) {
    return false;
  }
  const turn = state.turns[request.source.turnId];
  if (
    turn === undefined
    || turn.inputEpisodeId !== request.source.inputEpisodeId
    || turn.committedSequence !== request.source.sourceRevision
  ) {
    return false;
  }
  return turn.studentText.slice(
    request.source.span.start,
    request.source.span.end
  ) === request.source.span.text;
}
