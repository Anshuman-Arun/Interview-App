import { createHash } from "node:crypto";
import {
  BoardRevisionSchema,
  BoardObservationSchema,
  CommandEnvelopeSchema,
  CommandIdentityValueSchema,
  ContextEpochSchema,
  DeliveryAtomSchema,
  DeliveryIdSchema,
  GenerationBasisSchema,
  GenerationIdSchema,
  InputEpisodeIdSchema,
  InterviewSessionConfigurationSchema,
  InterviewerProposalSchema,
  EvidenceProposalSchema,
  EvidenceKeySchema,
  EvidenceValueSchema,
  RequestIdSchema,
  RealizationRequestSchema,
  TranscriptRevisionSchema,
  TurnIdSchema,
  UtteranceIdSchema,
  evidenceKeyToString,
  isEvidenceValueAllowed,
  newDeliveryId,
  newGenerationId,
  newInputEpisodeId,
  newRequestId,
  newTurnId,
  newUtteranceId,
  type BoardObservation,
  type BoardRevision,
  type CommandEnvelope,
  type CommandIdentityValue,
  type DeliveryAtom,
  type DeliveryId,
  type GenerationBasis,
  type GenerationId,
  type InputEpisodeId,
  type InterviewProblem,
  type InterviewSessionConfiguration,
  type InterviewerProposal,
  type EvidenceProposal,
  type RealizationRequest,
  type RequestId,
  type TranscriptRevision,
  type TurnId
  ,type UtteranceId
} from "../../domain/src/index.js";
import type { EventDraft, SessionState } from "../../events/src/index.js";
import { z } from "zod";
import { createCommandEnvelope } from "./envelopes.js";
import { canonicalJson, createProviderContextSpecFingerprintSync } from "./context-compiler.js";
import { isGenerationBasisStillCompatible } from "./compatibility.js";
import { assessVisionFreshness } from "./vision-freshness.js";
import { selectPedagogicalAction } from "./pedagogical-policy.js";
import {
  invalidateGenerationOutput,
  invalidateUndeliveredPolicyOutput
} from "./policy-output-invalidation.js";
import type { DisclosureValidator } from "./disclosure-validator.js";
import type { SessionWriter } from "./session-writer.js";

const StartedResultSchema = z.object({ started: z.literal(true) }).strict();
const InputCommittedResultSchema = z.object({ inputEpisodeId: InputEpisodeIdSchema, turnId: TurnIdSchema }).strict();
const GenerationStartedResultSchema = z.object({ generationId: GenerationIdSchema, basis: GenerationBasisSchema }).strict();
const CommittedResultSchema = z.object({ committed: z.literal(true) }).strict();
const SupersededResultSchema = z.object({ superseded: z.literal(true) }).strict();
const CorrectedResultSchema = z.object({ corrected: z.literal(true) }).strict();
const UtteranceStartedResultSchema = z.object({ utteranceId: UtteranceIdSchema }).strict();
const UtteranceDiscardedResultSchema = z.object({ discarded: z.literal(true) }).strict();
const UtteranceFinalizedResultSchema = z.object({ inputEpisodeId: InputEpisodeIdSchema, transcriptRevision: TranscriptRevisionSchema }).strict();
const UtteranceFinalizedAndCommittedResultSchema = z.object({
  inputEpisodeId: InputEpisodeIdSchema,
  transcriptRevision: TranscriptRevisionSchema,
  turnId: TurnIdSchema
}).strict();
const AudioDeliveryQueuedResultSchema = z.object({
  queued: z.boolean(),
  atom: DeliveryAtomSchema.optional(),
  reason: z.string().min(1).optional()
}).strict();
const InputAppendedResultSchema = z.object({ appended: z.literal(true) }).strict();
const BoardInputAppendedResultSchema = z.object({ appended: z.literal(true), boardRevision: BoardRevisionSchema }).strict();
const VisionRequestedResultSchema = z.object({ visionRequestId: RequestIdSchema, sourceBoardRevision: BoardRevisionSchema }).strict();
const VisionProcessedResultSchema = z.object({ accepted: z.boolean(), reason: z.string().min(1).optional() }).strict();
const EvidenceProcessedResultSchema = z.object({ committed: z.boolean(), key: z.string().min(1), reason: z.string().min(1).optional() }).strict();
const CompletedResultSchema = z.object({ completed: z.literal(true), completedAt: z.string() }).strict();
const ArchivedResultSchema = z.object({ archived: z.literal(true), archivedAt: z.string() }).strict();
const ResumedResultSchema = z.object({ resumed: z.literal(true), resumedAt: z.string() }).strict();
export const ProcessProposalResultSchema = z.object({
  accepted: z.boolean(),
  deliveryAtoms: z.array(DeliveryAtomSchema),
  reason: z.string().min(1).optional()
}).strict();
export type ProcessProposalResult = z.infer<typeof ProcessProposalResultSchema>;

function commandIdentityValue(value: unknown): CommandIdentityValue {
  return CommandIdentityValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

function assertSessionActive(state: Readonly<SessionState>, operation: string): void {
  if (!state.started || state.status !== "ACTIVE") {
    throw new Error(`Cannot ${operation} in status ${state.status}`);
  }
}

const MAX_INTERVIEWER_PROPOSAL_TEXT_CHARACTERS = 100_000;
const MAX_INTERVIEWER_PROPOSAL_TOTAL_TEXT_CHARACTERS = 1_000_000;
const MAX_INTERVIEWER_PROPOSAL_DISCLOSURE_IDS = 256;
const MAX_INTERVIEWER_PROPOSAL_BOARD_ACTIONS = 256;
const MAX_RUNTIME_ID_CHARACTERS = 512;
const MAX_EVIDENCE_PROPOSAL_EVENT_IDS = 4_096;

function isRuntimeRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyRuntimeKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>
): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function boundedRuntimeString(value: unknown, maximum = MAX_RUNTIME_ID_CHARACTERS): boolean {
  return typeof value !== "string" || value.length <= maximum;
}

function proposalWithinAdmissionBounds(value: unknown): boolean {
  if (!isRuntimeRecord(value)) return true;
  if (!hasOnlyRuntimeKeys(
    value,
    new Set([
      "realizedAction",
      "claimedDisclosureLevel",
      "claimedDisclosureIds",
      "speechText",
      "boardActions"
    ])
  )) return false;

  const claimedDisclosureIds = value["claimedDisclosureIds"];
  if (
    Array.isArray(claimedDisclosureIds)
    && (
      claimedDisclosureIds.length > MAX_INTERVIEWER_PROPOSAL_DISCLOSURE_IDS
      || claimedDisclosureIds.some((id) => !boundedRuntimeString(id))
    )
  ) return false;

  const speechText = value["speechText"];
  if (
    typeof speechText === "string"
    && speechText.length > MAX_INTERVIEWER_PROPOSAL_TEXT_CHARACTERS
  ) return false;
  let totalTextCharacters = typeof speechText === "string" ? speechText.length : 0;
  if (totalTextCharacters > MAX_INTERVIEWER_PROPOSAL_TOTAL_TEXT_CHARACTERS) return false;

  const boardActions = value["boardActions"];
  if (!Array.isArray(boardActions)) return true;
  if (boardActions.length > MAX_INTERVIEWER_PROPOSAL_BOARD_ACTIONS) return false;
  for (const rawAction of boardActions) {
    if (!isRuntimeRecord(rawAction)) continue;
    if (!hasOnlyRuntimeKeys(
      rawAction,
      new Set([
        "operation",
        "layer",
        "content",
        "targetShapeId",
        "expectedShapeRevision",
        "annotationPurpose"
      ])
    )) return false;
    const content = rawAction["content"];
    const annotationPurpose = rawAction["annotationPurpose"];
    if (
      (typeof content === "string" && content.length > MAX_INTERVIEWER_PROPOSAL_TEXT_CHARACTERS)
      || (
        typeof annotationPurpose === "string"
        && annotationPurpose.length > MAX_INTERVIEWER_PROPOSAL_TEXT_CHARACTERS
      )
      || !boundedRuntimeString(rawAction["targetShapeId"])
    ) return false;
    totalTextCharacters += typeof content === "string" ? content.length : 0;
    totalTextCharacters += typeof annotationPurpose === "string" ? annotationPurpose.length : 0;
    if (totalTextCharacters > MAX_INTERVIEWER_PROPOSAL_TOTAL_TEXT_CHARACTERS) return false;
  }
  return true;
}

function evidenceProposalWithinAdmissionBounds(value: unknown): boolean {
  if (!isRuntimeRecord(value)) return true;
  if (!hasOnlyRuntimeKeys(
    value,
    new Set(["key", "proposedValue", "inferenceConfidence", "evidenceEventIds"])
  )) return false;

  const evidenceEventIds = value["evidenceEventIds"];
  if (
    Array.isArray(evidenceEventIds)
    && (
      evidenceEventIds.length > MAX_EVIDENCE_PROPOSAL_EVENT_IDS
      || evidenceEventIds.some((eventId) => !boundedRuntimeString(eventId))
    )
  ) return false;

  const key = value["key"];
  if (!isRuntimeRecord(key)) return true;
  if (!hasOnlyRuntimeKeys(key, new Set(["problemId", "subject", "dimension"]))) return false;
  if (!boundedRuntimeString(key["problemId"])) return false;

  const subject = key["subject"];
  if (!isRuntimeRecord(subject)) return true;
  if (Object.keys(subject).length > 2) return false;
  for (const [subjectKey, subjectValue] of Object.entries(subject)) {
    if (subjectKey !== "kind" && !boundedRuntimeString(subjectValue)) return false;
  }
  return true;
}

function terminalInvalidationDrafts(
  state: Readonly<SessionState>,
  reason: string
): readonly EventDraft[] {
  const drafts: EventDraft[] = [];

  for (const generation of Object.values(state.generations)) {
    if (generation.status === "ACTIVE" || generation.status === "PROPOSAL_RECEIVED") {
      drafts.push({
        source: "APPLICATION",
        type: "MODEL_GENERATION_SUPERSEDED",
        payload: { generationId: generation.generationId, reason }
      });
    }
  }

  for (const atom of Object.values(state.deliveries)) {
    if (atom.status === "QUEUED") {
      drafts.push({
        source: "APPLICATION",
        type: "DELIVERY_CANCELLED",
        payload: { deliveryId: atom.deliveryId, reason }
      });
    } else if (atom.status === "DELIVERING") {
      drafts.push({
        source: "RECOVERY",
        type: "DELIVERY_POSSIBLY_EXPOSED",
        payload: {
          deliveryId: atom.deliveryId,
          reason: `${reason}; physical exposure acknowledgement was not persisted`
        }
      });
    }
  }

  return drafts;
}

export class TurnCoordinator {
  public constructor(private readonly writer: SessionWriter) {}

  public async startSession(problem: InterviewProblem, commandEnvelope?: CommandEnvelope): Promise<void> {
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: { id: problem.id, version: problem.version },
      difficulty: problem.interviewer.difficulty,
      interventionPolicy: "BALANCED"
    });
    const providerContextSpecSha256 = createProviderContextSpecFingerprintSync(problem);
    const envelope = CommandEnvelopeSchema.parse(
      commandEnvelope ?? createCommandEnvelope({
        sessionId: this.writer.sessionId,
        producer: "application"
      })
    );

    // Preserve the historical logical command identity so a START_SESSION
    // request processed before session-configuration v1 remains idempotent if
    // the same RequestId is retried after upgrade.
    await this.writer.execute(envelope, {
      operation: "START_SESSION",
      payload: {
        problemId: problem.id,
        problemVersion: problem.version,
        prompt: problem.public.prompt,
        providerContextSpecSha256
      }
    }, StartedResultSchema, (state) => {
      if (state.started) throw new Error("Session already started");
      return {
        drafts: [
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
              problemId: problem.id,
              problemVersion: problem.version,
              prompt: problem.public.prompt,
              providerContextSpecSha256
            }
          }
        ],
        result: { started: true }
      };
    });
  }

  public async startConfiguredSession(
    input: {
      readonly configuration: InterviewSessionConfiguration;
      readonly problem?: InterviewProblem;
    },
    commandEnvelope?: CommandEnvelope
  ): Promise<void> {
    const configuration = InterviewSessionConfigurationSchema.parse(input.configuration);
    const envelope = CommandEnvelopeSchema.parse(
      commandEnvelope ?? createCommandEnvelope({
        sessionId: this.writer.sessionId,
        producer: "application"
      })
    );

    let problemDraft: EventDraft | undefined;
    let problemIdentity: CommandIdentityValue = null;
    if (configuration.mode === "OXFORD_MATHEMATICS") {
      const problem = input.problem;
      if (problem === undefined) {
        throw new Error("Oxford session configuration requires a resolved problem");
      }
      if (
        problem.id !== configuration.problem.id
        || problem.version !== configuration.problem.version
      ) {
        throw new Error("Resolved problem does not match session configuration");
      }
      if (
        configuration.difficulty !== undefined
        && configuration.difficulty !== problem.interviewer.difficulty
      ) {
        throw new Error("Configured difficulty does not match the resolved problem");
      }
      const providerContextSpecSha256 = createProviderContextSpecFingerprintSync(problem);
      problemIdentity = commandIdentityValue({
        problemId: problem.id,
        problemVersion: problem.version,
        prompt: problem.public.prompt,
        providerContextSpecSha256
      });
      problemDraft = {
        source: "APPLICATION",
        type: "PROBLEM_PRESENTED",
        payload: {
          problemId: problem.id,
          problemVersion: problem.version,
          prompt: problem.public.prompt,
          providerContextSpecSha256
        }
      };
    } else if (input.problem !== undefined) {
      throw new Error("Quant session configuration cannot bind an Oxford InterviewProblem");
    }

    await this.writer.execute(envelope, {
      operation: "START_SESSION",
      payload: {
        configuration: commandIdentityValue(configuration),
        problem: problemIdentity
      }
    }, StartedResultSchema, (state) => {
      if (state.started) throw new Error("Session already started");
      return {
        drafts: [
          {
            source: "APPLICATION",
            type: "SESSION_STARTED",
            payload: {
              startedAt: new Date().toISOString(),
              configuration
            }
          },
          ...(problemDraft === undefined ? [] : [problemDraft])
        ],
        result: { started: true }
      };
    });
  }

  public async completeSession(commandEnvelope?: CommandEnvelope, summary?: string): Promise<{ completed: true; completedAt: string }> {
    const envelope = CommandEnvelopeSchema.parse(commandEnvelope ?? createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "application" }));
    const result = await this.writer.execute<{ completed: true; completedAt: string }>(envelope, {
      operation: "COMPLETE_SESSION",
      payload: { summary: summary ?? null }
    }, CompletedResultSchema, (state) => {
      if (!state.started || state.status !== "ACTIVE") {
        throw new Error(`Cannot complete session in status ${state.status}`);
      }
      const completedAt = new Date().toISOString();
      return {
        drafts: [
          ...terminalInvalidationDrafts(state, "Session completed"),
          {
            source: "APPLICATION",
            type: "SESSION_COMPLETED",
            payload: { completedAt, ...(summary !== undefined ? { summary } : {}) }
          }
        ],
        result: { completed: true, completedAt }
      };
    });
    return result.value;
  }

  public async archiveSession(commandEnvelope?: CommandEnvelope, reason?: string): Promise<{ archived: true; archivedAt: string }> {
    const envelope = CommandEnvelopeSchema.parse(commandEnvelope ?? createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "application" }));
    const result = await this.writer.execute<{ archived: true; archivedAt: string }>(envelope, {
      operation: "ARCHIVE_SESSION",
      payload: { reason: reason ?? null }
    }, ArchivedResultSchema, (state) => {
      if (!state.started || (state.status !== "ACTIVE" && state.status !== "COMPLETED")) {
        throw new Error(`Cannot archive session in status ${state.status}`);
      }
      const archivedAt = new Date().toISOString();
      return {
        drafts: [
          ...terminalInvalidationDrafts(state, "Session archived"),
          {
            source: "APPLICATION",
            type: "SESSION_ARCHIVED",
            payload: { archivedAt, ...(reason !== undefined ? { reason } : {}) }
          }
        ],
        result: { archived: true, archivedAt }
      };
    });
    return result.value;
  }

  public async resumeSession(commandEnvelope?: CommandEnvelope): Promise<{ resumed: true; resumedAt: string }> {
    const envelope = CommandEnvelopeSchema.parse(commandEnvelope ?? createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "application" }));
    const result = await this.writer.execute<{ resumed: true; resumedAt: string }>(envelope, {
      operation: "RESUME_SESSION",
      payload: {}
    }, ResumedResultSchema, (state) => {
      if (!state.started || state.status !== "ACTIVE") {
        throw new Error(`Cannot resume session in status ${state.status}`);
      }
      const resumedAt = new Date().toISOString();
      return {
        drafts: [
          {
            source: "APPLICATION",
            type: "SESSION_RESUMED",
            payload: { resumedAt }
          }
        ],
        result: { resumed: true, resumedAt }
      };
    });
    return result.value;
  }

  public async commitInput(studentText: string, commandEnvelope?: CommandEnvelope): Promise<{ inputEpisodeId: InputEpisodeId; turnId: TurnId }> {
    const inputEpisodeId = newInputEpisodeId();
    const turnId = newTurnId();
    const envelope = CommandEnvelopeSchema.parse(commandEnvelope ?? createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "synthetic-user", inputEpisodeId, turnId }));
    const result = await this.writer.execute(envelope, {
      operation: "COMMIT_SYNTHETIC_INPUT",
      payload: { studentText }
    }, InputCommittedResultSchema, (state) => {
      if (!state.started || state.status !== "ACTIVE") {
        throw new Error(`Cannot commit input in status ${state.status}`);
      }
      return {
        drafts: [
          ...invalidateUndeliveredPolicyOutput(
            state,
            "New committed student input superseded prior undelivered output"
          ),
          { source: "USER", type: "INPUT_EPISODE_STARTED", payload: { inputEpisodeId } },
          { source: "USER", type: "INPUT_EPISODE_UPDATED", payload: { inputEpisodeId, modality: "TYPING", semanticContent: studentText } },
          { source: "APPLICATION", type: "INPUT_EPISODE_COMMITTED", payload: { inputEpisodeId } },
          { source: "APPLICATION", type: "TURN_COMMITTED", payload: { turnId, inputEpisodeId, studentText } }
        ],
        result: { inputEpisodeId, turnId }
      };
    });
    return result.value;
  }

  public async beginUtterance(): Promise<UtteranceId> {
    const utteranceId = newUtteranceId();
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "vad", correlationId: newRequestId() });
    const result = await this.writer.execute(envelope, {
      operation: "BEGIN_UTTERANCE",
      payload: {}
    }, UtteranceStartedResultSchema, (state) => {
      assertSessionActive(state, "begin utterance");
      const invalidations: EventDraft[] = [];
      for (const generation of Object.values(state.generations)) {
        if (
          generation.status === "ACTIVE"
          || generation.status === "PROPOSAL_RECEIVED"
          || generation.status === "VALIDATED"
        ) {
          invalidations.push({
            source: "APPLICATION",
            type: "MODEL_GENERATION_SUPERSEDED",
            payload: { generationId: generation.generationId, reason: "Speech onset" }
          });
        }
      }
      for (const atom of Object.values(state.deliveries)) {
        if (atom.status === "QUEUED") {
          invalidations.push({ source: "APPLICATION", type: "DELIVERY_CANCELLED", payload: { deliveryId: atom.deliveryId, reason: "Speech onset before exposure" } });
        } else if (atom.status === "DELIVERING") {
          invalidations.push({ source: "APPLICATION", type: "DELIVERY_POSSIBLY_EXPOSED", payload: { deliveryId: atom.deliveryId, reason: "Speech onset while physical exposure was unacknowledged" } });
        }
      }
      return {
        drafts: [{ source: "USER", type: "UTTERANCE_STARTED", payload: { utteranceId } }, ...invalidations],
        result: { utteranceId }
      };
    });
    return result.value.utteranceId;
  }

  public async discardUtterance(utteranceId: UtteranceId, reason: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "vad", correlationId: newRequestId() });
    await this.writer.execute(envelope, {
      operation: "DISCARD_UTTERANCE",
      payload: { utteranceId, reason }
    }, UtteranceDiscardedResultSchema, (state) => {
      const utterance = state.utterances[utteranceId];
      if (utterance === undefined || utterance.status !== "CAPTURING") throw new Error("Utterance is not being captured");
      return { drafts: [{ source: "USER", type: "UTTERANCE_DISCARDED", payload: { utteranceId, reason } }], result: { discarded: true } };
    });
  }

  public async finalizeUtterance(input: {
    readonly utteranceId: UtteranceId;
    readonly text: string;
    readonly inputEpisodeId?: InputEpisodeId;
  }): Promise<{ inputEpisodeId: InputEpisodeId; transcriptRevision: TranscriptRevision }> {
    const inputEpisodeId = input.inputEpisodeId ?? newInputEpisodeId();
    const startsEpisode = input.inputEpisodeId === undefined;
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "stt", inputEpisodeId });
    const result = await this.writer.execute(envelope, {
      operation: "FINALIZE_UTTERANCE",
      payload: { utteranceId: input.utteranceId, text: input.text, inputEpisodeId, startsEpisode }
    }, UtteranceFinalizedResultSchema, (state) => {
      assertSessionActive(state, "finalize utterance");
      const utterance = state.utterances[input.utteranceId];
      if (utterance === undefined || utterance.status !== "CAPTURING") throw new Error("Utterance is not being captured");
      if (!startsEpisode) {
        const episode = state.inputEpisodes[inputEpisodeId];
        if (episode === undefined || episode.status !== "ACTIVE") throw new Error("Input episode is not active");
      }
      const transcriptRevision = TranscriptRevisionSchema.parse(state.transcriptRevision + 1);
      const drafts: EventDraft[] = [
        ...(startsEpisode ? [{ source: "APPLICATION", type: "INPUT_EPISODE_STARTED", payload: { inputEpisodeId } } as const] : []),
        { source: "WORKER", type: "TRANSCRIPT_FINALIZED", payload: { utteranceId: input.utteranceId, inputEpisodeId, transcriptRevision, text: input.text } },
        { source: "APPLICATION", type: "INPUT_EPISODE_UPDATED", payload: { inputEpisodeId, modality: "SPEECH", semanticContent: input.text } }
      ];
      return { drafts, result: { inputEpisodeId, transcriptRevision } };
    });
    return result.value;
  }

  public async finalizeAndCommitUtterance(input: {
    readonly utteranceId: UtteranceId;
    readonly text: string;
  }): Promise<{
    inputEpisodeId: InputEpisodeId;
    transcriptRevision: TranscriptRevision;
    turnId: TurnId;
  }> {
    const inputEpisodeId = newInputEpisodeId();
    const turnId = newTurnId();
    const envelope = createCommandEnvelope({
      sessionId: this.writer.sessionId,
      producer: "stt",
      inputEpisodeId,
      turnId
    });
    const result = await this.writer.execute(envelope, {
      operation: "FINALIZE_AND_COMMIT_UTTERANCE",
      payload: { utteranceId: input.utteranceId, text: input.text, inputEpisodeId, turnId }
    }, UtteranceFinalizedAndCommittedResultSchema, (state) => {
      assertSessionActive(state, "finalize and commit utterance");
      const utterance = state.utterances[input.utteranceId];
      if (utterance === undefined || utterance.status !== "CAPTURING") {
        throw new Error("Utterance is not being captured");
      }
      const transcriptRevision = TranscriptRevisionSchema.parse(state.transcriptRevision + 1);
      return {
        drafts: [
          { source: "APPLICATION", type: "INPUT_EPISODE_STARTED", payload: { inputEpisodeId } },
          {
            source: "WORKER",
            type: "TRANSCRIPT_FINALIZED",
            payload: {
              utteranceId: input.utteranceId,
              inputEpisodeId,
              transcriptRevision,
              text: input.text
            }
          },
          {
            source: "APPLICATION",
            type: "INPUT_EPISODE_UPDATED",
            payload: { inputEpisodeId, modality: "SPEECH", semanticContent: input.text }
          },
          ...invalidateUndeliveredPolicyOutput(
            state,
            "New committed input episode superseded prior undelivered output"
          ),
          { source: "APPLICATION", type: "INPUT_EPISODE_COMMITTED", payload: { inputEpisodeId } },
          {
            source: "APPLICATION",
            type: "TURN_COMMITTED",
            payload: { turnId, inputEpisodeId, studentText: input.text }
          }
        ],
        result: { inputEpisodeId, transcriptRevision, turnId }
      };
    });
    return result.value;
  }

  public async appendTypedInput(inputEpisodeId: InputEpisodeId, text: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "typed-input", inputEpisodeId });
    await this.writer.execute(envelope, {
      operation: "APPEND_TYPED_INPUT",
      payload: { inputEpisodeId, text }
    }, InputAppendedResultSchema, (state) => {
      assertSessionActive(state, "append typed input");
      const episode = state.inputEpisodes[inputEpisodeId];
      if (episode === undefined || episode.status !== "ACTIVE") throw new Error("Input episode is not active");
      return {
        drafts: [
          { source: "USER", type: "INPUT_EPISODE_UPDATED", payload: { inputEpisodeId, modality: "TYPING", semanticContent: text } },
          ...invalidateUndeliveredPolicyOutput(
            state,
            "Authoritative typed input changed before delivery"
          )
        ],
        result: { appended: true }
      };
    });
  }

  public async appendBoardInput(inputEpisodeId: InputEpisodeId, summary: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "whiteboard", inputEpisodeId });
    await this.writer.execute(envelope, {
      operation: "APPEND_BOARD_INPUT",
      payload: { inputEpisodeId, summary }
    }, BoardInputAppendedResultSchema, (state) => {
      assertSessionActive(state, "append board input");
      const episode = state.inputEpisodes[inputEpisodeId];
      if (episode === undefined || episode.status !== "ACTIVE") throw new Error("Input episode is not active");
      const boardRevision = BoardRevisionSchema.parse(state.boardRevision + 1);
      return {
        drafts: [
          { source: "USER", type: "BOARD_PATCH_COMMITTED", payload: { boardRevision, summary } },
          { source: "USER", type: "INPUT_EPISODE_UPDATED", payload: { inputEpisodeId, modality: "WHITEBOARD", semanticContent: summary } },
          ...invalidateUndeliveredPolicyOutput(
            state,
            "Authoritative board state changed before delivery"
          )
        ],
        result: { appended: true, boardRevision }
      };
    });
  }

  public async commitInputEpisode(inputEpisodeId: InputEpisodeId): Promise<TurnId> {
    const turnId = newTurnId();
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "turn-coordinator", inputEpisodeId, turnId });
    const result = await this.writer.execute(envelope, {
      operation: "COMMIT_INPUT_EPISODE",
      payload: { inputEpisodeId }
    }, InputCommittedResultSchema, (state) => {
      assertSessionActive(state, "commit input episode");
      const episode = state.inputEpisodes[inputEpisodeId];
      if (episode === undefined || episode.status !== "ACTIVE" || episode.inputs.length === 0) throw new Error("Input episode is not ready to commit");
      const studentText = episode.inputs.map((item) => item.semanticContent).join(" ");
      return {
        drafts: [
          ...invalidateUndeliveredPolicyOutput(
            state,
            "New committed input episode superseded prior undelivered output"
          ),
          { source: "APPLICATION", type: "INPUT_EPISODE_COMMITTED", payload: { inputEpisodeId } },
          { source: "APPLICATION", type: "TURN_COMMITTED", payload: { turnId, inputEpisodeId, studentText } }
        ],
        result: { inputEpisodeId, turnId }
      };
    });
    return result.value.turnId;
  }

  public async requestVision(regionId: string, relevantShapeIds: readonly string[]): Promise<{ visionRequestId: RequestId; sourceBoardRevision: BoardRevision }> {
    const visionRequestId = newRequestId();
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "vision-coordinator", correlationId: visionRequestId });
    const result = await this.writer.execute(envelope, {
      operation: "REQUEST_VISION",
      payload: { regionId, relevantShapeIds: [...relevantShapeIds] }
    }, VisionRequestedResultSchema, (state) => {
      assertSessionActive(state, "request vision");
      return {
      drafts: [{ source: "APPLICATION", type: "VISION_REQUESTED", payload: { visionRequestId, sourceBoardRevision: state.boardRevision, regionId, relevantShapeIds: [...relevantShapeIds] } }],
      result: { visionRequestId, sourceBoardRevision: state.boardRevision }
      };
    });
    return result.value;
  }

  public async processVisionResult(input: { readonly envelope: CommandEnvelope; readonly observation: BoardObservation }): Promise<z.infer<typeof VisionProcessedResultSchema>> {
    const envelope = CommandEnvelopeSchema.parse(input.envelope);
    const observation = BoardObservationSchema.parse(input.observation);
    const visionRequestId = envelope.correlationId;
    const result = await this.writer.execute(envelope, {
      operation: "PROCESS_VISION_RESULT",
      payload: { observation }
    }, VisionProcessedResultSchema, (state) => {
      const request = state.visionRequests[visionRequestId];
      if (request === undefined || request.status !== "PENDING") return { drafts: [], result: { accepted: false, reason: "Vision request is not pending" } };
      const sameDependencySet = request.regionId === observation.regionId
        && request.relevantShapeIds.length === observation.relevantShapeIds.length
        && request.relevantShapeIds.every((shapeId) => observation.relevantShapeIds.includes(shapeId));
      const freshness = assessVisionFreshness(observation, state);
      const sourceMatches = envelope.sourceRevision === request.sourceBoardRevision && observation.sourceBoardRevision === request.sourceBoardRevision;
      if (freshness !== "FRESH" || !sourceMatches || !sameDependencySet) {
        const reason = `Vision result rejected: freshness=${freshness}, sourceMatches=${String(sourceMatches)}, dependenciesMatch=${String(sameDependencySet)}`;
        return { drafts: [{ source: "APPLICATION", type: "VISION_RESULT_DISCARDED", payload: { visionRequestId, reason } }], result: { accepted: false, reason } };
      }
      return { drafts: [{ source: "WORKER", type: "VISION_RESULT_ACCEPTED", payload: { visionRequestId, observation } }], result: { accepted: true } };
    });
    return result.value;
  }

  public async processEvidenceProposal(input: { readonly envelope: CommandEnvelope; readonly proposal: EvidenceProposal }): Promise<z.infer<typeof EvidenceProcessedResultSchema>> {
    const envelope = CommandEnvelopeSchema.parse(input.envelope);
    if (!evidenceProposalWithinAdmissionBounds(input.proposal)) {
      throw new Error("Evidence proposal exceeds the bounded admission input size");
    }
    const proposal = EvidenceProposalSchema.parse(input.proposal);
    const key = evidenceKeyToString(proposal.key);
    const result = await this.writer.execute(envelope, {
      operation: "PROCESS_EVIDENCE_PROPOSAL",
      payload: { proposal }
    }, EvidenceProcessedResultSchema, (state) => {
      const reasons: string[] = [];
      if (state.problem?.id !== proposal.key.problemId) reasons.push("Evidence is scoped to a different problem");
      const knownEventIds = new Set(state.eventIds);
      if (!proposal.evidenceEventIds.every((eventId) => knownEventIds.has(eventId))) {
        reasons.push("Evidence provenance references unknown events");
      }
      if (proposal.inferenceConfidence < 0.7) reasons.push("Inference confidence is below the Phase 0 commit threshold");
      if (!isEvidenceValueAllowed(proposal.key, proposal.proposedValue)) reasons.push("Evidence value is invalid for its dimension");
      const proposedDraft: EventDraft = { source: "PROVIDER", type: "EVIDENCE_PROPOSED", payload: { proposal } };
      if (reasons.length > 0) return { drafts: [proposedDraft], result: { committed: false, key, reason: reasons.join("; ") } };
      const value = EvidenceValueSchema.parse({
        value: proposal.proposedValue,
        inferenceConfidence: proposal.inferenceConfidence,
        evidenceEventIds: proposal.evidenceEventIds,
        lastUpdatedSequence: state.sequence + 2
      });
      const activeEvidence = state.evidenceHistory[key]?.find((record) => record.status === "ACTIVE");
      return {
        drafts: [
          proposedDraft,
          {
            source: "APPLICATION",
            type: "STUDENT_EVIDENCE_UPDATED",
            payload: {
              key: EvidenceKeySchema.parse(proposal.key),
              value,
              ...(activeEvidence === undefined ? {} : { supersedesEventId: activeEvidence.evidenceEventId })
            }
          },
          ...invalidateUndeliveredPolicyOutput(
            state,
            "Authoritative student evidence changed before delivery"
          )
        ],
        result: { committed: true, key }
      };
    });
    return result.value;
  }

  public async selectAction(turnId: TurnId, problem: InterviewProblem): Promise<RealizationRequest> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "pedagogical-policy", turnId });
    const result = await this.writer.execute(envelope, {
      operation: "SELECT_PEDAGOGICAL_ACTION",
      payload: {
        turnId,
        problemId: problem.id,
        problemVersion: problem.version
      }
    }, RealizationRequestSchema, (state) => {
      assertSessionActive(state, "select pedagogical action");
      if (
        state.problem === undefined
        || state.problem.id !== problem.id
        || state.problem.version !== problem.version
      ) throw new Error("Problem does not match the session's presented problem");
      if (state.problem.providerContextSpecSha256 === undefined) {
        throw new Error("Problem definition provenance is unavailable for pedagogical policy");
      }
      const policyProblemFingerprint = createProviderContextSpecFingerprintSync(problem);
      if (state.problem.providerContextSpecSha256 !== policyProblemFingerprint) {
        throw new Error("Problem definition does not match the session-bound pedagogical policy contract");
      }
      if (state.problem.prompt !== problem.public.prompt) {
        throw new Error("Problem prompt does not match the session-bound pedagogical policy contract");
      }
      const turn = state.turns[turnId];
      if (
        turn === undefined
        || turn.turnId !== turnId
        || state.lastCommittedInputSequence === undefined
        || turn.committedSequence !== state.lastCommittedInputSequence
      ) {
        throw new Error("Pedagogical action selection requires the latest committed Turn");
      }

      const request = selectPedagogicalAction(state, turnId, problem);
      const existing = RealizationRequestSchema.safeParse(state.pedagogicalActions[turnId]);
      if (
        existing.success
        && canonicalJson(existing.data) === canonicalJson(request)
      ) {
        return { drafts: [], result: existing.data };
      }
      return { drafts: [{ source: "APPLICATION", type: "PEDAGOGICAL_ACTION_SELECTED", payload: { turnId, request } }], result: request };
    });
    return result.value;
  }

  public async startGeneration(inputEpisodeId: InputEpisodeId, turnId: TurnId, provider: string): Promise<{ generationId: GenerationId; basis: GenerationBasis }> {
    const generationId = newGenerationId();
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "turn-coordinator", inputEpisodeId, turnId, generationId });
    const result = await this.writer.execute(envelope, {
      operation: "START_GENERATION",
      payload: { inputEpisodeId, turnId, provider }
    }, GenerationStartedResultSchema, (state) => {
      assertSessionActive(state, "start generation");
      if (state.lastCommittedInputSequence === undefined) throw new Error("No committed input exists");
      const episode = state.inputEpisodes[inputEpisodeId];
      const turn = state.turns[turnId];
      if (episode === undefined || episode.status !== "COMMITTED") {
        throw new Error("Generation requires a committed InputEpisode");
      }
      if (
        turn === undefined
        || turn.turnId !== turnId
        || turn.inputEpisodeId !== inputEpisodeId
        || turn.committedSequence !== state.lastCommittedInputSequence
      ) {
        throw new Error("Generation requires the latest committed Turn and matching InputEpisode");
      }
      const pedagogicalAction = RealizationRequestSchema.safeParse(state.pedagogicalActions[turnId]);
      if (!pedagogicalAction.success) {
        throw new Error("Generation requires a valid application-selected pedagogical action");
      }
      const existingNonterminalGeneration = Object.values(state.generations).find(
        (generation) =>
          generation.basis.turnId === turnId
          && (
            generation.status === "ACTIVE"
            || generation.status === "PROPOSAL_RECEIVED"
            || generation.status === "VALIDATED"
          )
      );
      if (existingNonterminalGeneration !== undefined) {
        throw new Error(
          "Generation requires any prior nonterminal generation for the turn to be explicitly superseded"
        );
      }
      const basis: GenerationBasis = {
        contextEpoch: state.contextEpoch,
        committedInputSequence: state.lastCommittedInputSequence,
        transcriptRevision: state.transcriptRevision,
        boardRevision: state.boardRevision,
        problemStateRevision: state.problemStateRevision,
        policyRevision: state.policyRevision,
        inputEpisodeId,
        turnId
      };
      return { drafts: [{ source: "APPLICATION", type: "MODEL_GENERATION_STARTED", payload: { generationId, basis, provider } }], result: { generationId, basis } };
    });
    return result.value;
  }

  public async processProposal(input: {
    readonly envelope: CommandEnvelope;
    readonly problem: InterviewProblem;
    readonly proposal: InterviewerProposal;
    readonly validator: DisclosureValidator;
  }): Promise<ProcessProposalResult> {
    const envelope = CommandEnvelopeSchema.parse(input.envelope);
    if (!proposalWithinAdmissionBounds(input.proposal)) {
      throw new Error("Provider proposal exceeds the bounded admission input size");
    }
    const proposal = InterviewerProposalSchema.parse(input.proposal);
    const generationId = envelope.generationId;
    if (generationId === undefined) throw new Error("Provider result envelope is missing generationId");
    const providerContextSpecSha256 = createProviderContextSpecFingerprintSync(input.problem);
    const outcome = await this.writer.execute(envelope, {
      operation: "PROCESS_INTERVIEWER_PROPOSAL",
      payload: {
        problemId: input.problem.id,
        problemVersion: input.problem.version,
        providerContextSpecSha256,
        protectedDisclosures: input.problem.interviewer.protectedDisclosures,
        proposal: commandIdentityValue(proposal)
      }
    }, ProcessProposalResultSchema, (state) => {
      const generation = state.generations[generationId];
      if (generation === undefined) return { drafts: [], result: { accepted: false, deliveryAtoms: [], reason: "Unknown generation" } };
      if (generation.status !== "ACTIVE") return { drafts: [], result: { accepted: false, deliveryAtoms: [], reason: "Generation is not active" } };
      if (envelope.producer !== generation.provider) {
        return {
          drafts: [],
          result: {
            accepted: false,
            deliveryAtoms: [],
            reason: "Provider callback identity does not match the generation provider"
          }
        };
      }
      if (
        state.problem === undefined
        || state.problem.id !== input.problem.id
        || state.problem.version !== input.problem.version
        || state.problem.providerContextSpecSha256 === undefined
      ) {
        return rejectDrafts(generationId, proposal, "Problem definition provenance is unavailable or mismatched");
      }
      if (state.problem.providerContextSpecSha256 !== providerContextSpecSha256) {
        return rejectDrafts(generationId, proposal, "Problem definition does not match the session-bound provider context contract");
      }
      if (
        envelope.inputEpisodeId !== generation.basis.inputEpisodeId
        || envelope.turnId !== generation.basis.turnId
        || envelope.contextEpoch !== generation.basis.contextEpoch
        || envelope.sourceRevision !== generation.basis.committedInputSequence
      ) {
        return rejectAndSupersedeDrafts(generationId, proposal, "Provider callback basis does not match the generation basis");
      }
      const compatibility = isGenerationBasisStillCompatible(generation.basis, state);
      if (compatibility !== "COMPATIBLE") {
        return rejectAndSupersedeDrafts(generationId, proposal, `Generation compatibility is ${compatibility}`);
      }
      const parsedRequest = RealizationRequestSchema.safeParse(
        state.pedagogicalActions[generation.basis.turnId]
      );
      const generationRequest = RealizationRequestSchema.safeParse(generation.pedagogicalAction);
      if (!parsedRequest.success || !generationRequest.success) {
        return rejectAndSupersedeDrafts(generationId, proposal, "No valid generation-bound pedagogical action");
      }
      if (canonicalJson(parsedRequest.data) !== canonicalJson(generationRequest.data)) {
        return rejectAndSupersedeDrafts(generationId, proposal, "Pedagogical action changed after generation began");
      }
      const currentRequest = selectPedagogicalAction(
        state,
        generation.basis.turnId,
        input.problem
      );
      if (canonicalJson(parsedRequest.data) !== canonicalJson(currentRequest)) {
        return rejectAndSupersedeDrafts(generationId, proposal, "Application-selected pedagogical action is stale");
      }
      const validation = input.validator.validate({
        proposal,
        request: parsedRequest.data,
        protectedDisclosures: input.problem.interviewer.protectedDisclosures
      });
      if (!validation.accepted) return rejectDrafts(generationId, proposal, validation.reason);
      const atoms: DeliveryAtom[] = [];
      if (proposal.speechText !== undefined) {
        const speechAnalysis = validation.realizations.speech;
        if (speechAnalysis === null) {
          return rejectDrafts(
            generationId,
            proposal,
            "Disclosure validation did not attribute the speech realization"
          );
        }
        atoms.push(DeliveryAtomSchema.parse({
          deliveryId: newDeliveryId(), generationId,
          content: { medium: "TEXT", text: proposal.speechText },
          disclosureIds: speechAnalysis.effectiveDisclosureIds,
          effectiveDisclosureLevel: speechAnalysis.effectiveDisclosureLevel,
          status: "VALIDATED"
        }));
      }
      const boardActions = proposal.boardActions ?? [];
      if (validation.realizations.boardActions.length !== boardActions.length) {
        return rejectDrafts(
          generationId,
          proposal,
          "Disclosure validation did not attribute every board realization"
        );
      }
      for (const [index, action] of boardActions.entries()) {
        const actionAnalysis = validation.realizations.boardActions[index];
        if (actionAnalysis === undefined) {
          return rejectDrafts(
            generationId,
            proposal,
            "Disclosure validation did not attribute every board realization"
          );
        }
        atoms.push(DeliveryAtomSchema.parse({
          deliveryId: newDeliveryId(), generationId,
          content: { medium: "WHITEBOARD", action },
          disclosureIds: actionAnalysis.effectiveDisclosureIds,
          effectiveDisclosureLevel: actionAnalysis.effectiveDisclosureLevel,
          status: "VALIDATED"
        }));
      }
      const drafts: EventDraft[] = [
        { source: "PROVIDER", type: "MODEL_PROPOSAL_RECEIVED", payload: { generationId, proposal } },
        { source: "APPLICATION", type: "PROPOSAL_VALIDATED", payload: { generationId, analysis: validation.analysis } },
        ...atoms.map((atom): EventDraft => ({ source: "APPLICATION", type: "DELIVERY_QUEUED", payload: { atom } }))
      ];
      return { drafts, result: { accepted: true, deliveryAtoms: atoms } };
    });
    return outcome.value;
  }

  public async queueAudioDeliveryFromValidatedText(input: {
    readonly sourceDeliveryId: DeliveryId;
    readonly generationId: GenerationId;
    readonly text: string;
    readonly textSha256: string;
    readonly audioRef: string;
  }): Promise<DeliveryAtom | undefined> {
    const sourceDeliveryId = DeliveryIdSchema.parse(input.sourceDeliveryId);
    const generationId = GenerationIdSchema.parse(input.generationId);
    if (
      typeof input.text !== "string"
      || input.text.length === 0
      || input.text.length > MAX_INTERVIEWER_PROPOSAL_TEXT_CHARACTERS
    ) {
      throw new Error("TTS source text is invalid or exceeds the bounded realization size");
    }
    if (!/^[0-9a-f]{64}$/u.test(input.textSha256)) {
      throw new Error("TTS source text hash is malformed");
    }
    const computedTextSha256 = createHash("sha256").update(input.text, "utf8").digest("hex");
    if (computedTextSha256 !== input.textSha256) {
      throw new Error("TTS source text hash does not match the exact realization text");
    }
    if (!/^audio_v1_[0-9a-f]{64}$/u.test(input.audioRef) || input.audioRef.length > 80) {
      throw new Error("TTS audio reference is malformed");
    }

    const envelope = createCommandEnvelope({
      sessionId: this.writer.sessionId,
      producer: "tts-delivery",
      generationId
    });
    const result = await this.writer.execute(envelope, {
      operation: "QUEUE_AUDIO_DELIVERY",
      payload: {
        sourceDeliveryId,
        generationId,
        textSha256: input.textSha256,
        audioRef: input.audioRef
      }
    }, AudioDeliveryQueuedResultSchema, (state) => {
      const source = state.deliveries[sourceDeliveryId];
      if (
        source === undefined
        || source.generationId !== generationId
        || source.content.medium !== "TEXT"
      ) {
        return {
          drafts: [],
          result: { queued: false, reason: "Validated speech source delivery is unavailable or mismatched" }
        };
      }
      if (
        source.status !== "DELIVERING"
        && source.status !== "EXPOSED"
        && source.status !== "COMPLETED"
      ) {
        return {
          drafts: [],
          result: { queued: false, reason: "Validated speech source has not begun an authorized physical delivery" }
        };
      }
      if (
        source.content.text !== input.text
        || createHash("sha256").update(source.content.text, "utf8").digest("hex") !== input.textSha256
      ) {
        return {
          drafts: [],
          result: { queued: false, reason: "TTS result does not match the exact validated speech text" }
        };
      }

      const generation = state.generations[generationId];
      if (generation === undefined || generation.status !== "VALIDATED") {
        return {
          drafts: [],
          result: { queued: false, reason: "TTS generation is no longer authorized for delivery" }
        };
      }
      const compatibility = isGenerationBasisStillCompatible(generation.basis, state);
      if (compatibility !== "COMPATIBLE") {
        return {
          drafts: [],
          result: { queued: false, reason: `TTS generation compatibility is ${compatibility}` }
        };
      }

      const atom = DeliveryAtomSchema.parse({
        deliveryId: newDeliveryId(),
        generationId,
        content: {
          medium: "AUDIO",
          text: source.content.text,
          audioRef: input.audioRef
        },
        disclosureIds: [...source.disclosureIds],
        effectiveDisclosureLevel: source.effectiveDisclosureLevel,
        status: "VALIDATED"
      });
      return {
        drafts: [{
          source: "APPLICATION",
          type: "DELIVERY_QUEUED",
          payload: { atom }
        }],
        result: { queued: true, atom }
      };
    });
    return result.value.queued ? result.value.atom : undefined;
  }

  public async commitBoardPatch(summary: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "whiteboard" });
    await this.writer.execute(envelope, {
      operation: "COMMIT_BOARD_PATCH",
      payload: { summary }
    }, CommittedResultSchema, (state) => {
      assertSessionActive(state, "commit board patch");
      return {
        drafts: [
          {
            source: "USER",
            type: "BOARD_PATCH_COMMITTED",
            payload: { boardRevision: BoardRevisionSchema.parse(state.boardRevision + 1), summary }
          },
          ...invalidateUndeliveredPolicyOutput(
            state,
            "Authoritative board state changed before delivery"
          )
        ],
        result: { committed: true }
      };
    });
  }

  public async supersedeGeneration(generationId: GenerationId, reason: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "turn-coordinator", generationId });
    await this.writer.execute(envelope, {
      operation: "SUPERSEDE_GENERATION",
      payload: { generationId, reason }
    }, SupersededResultSchema, (state) => {
      const generation = state.generations[generationId];
      if (generation === undefined) throw new Error("Unknown generation");
      if (generation.status === "SUPERSEDED") return { drafts: [], result: { superseded: true } };
      if (generation.status !== "ACTIVE" && generation.status !== "PROPOSAL_RECEIVED" && generation.status !== "VALIDATED") {
        throw new Error(`Cannot supersede generation in ${generation.status}`);
      }
      return {
        drafts: [...invalidateGenerationOutput(state, generationId, reason)],
        result: { superseded: true }
      };
    });
  }

  public async correctTranscript(correctedText: string): Promise<void> {
    const envelope = createCommandEnvelope({ sessionId: this.writer.sessionId, producer: "transcript-correction" });
    await this.writer.execute(envelope, {
      operation: "CORRECT_TRANSCRIPT",
      payload: { correctedText }
    }, CorrectedResultSchema, (state) => {
      assertSessionActive(state, "correct transcript");
      const invalidations: EventDraft[] = Object.values(state.evidenceHistory)
        .flatMap((records) => records.filter((record) => record.status === "ACTIVE"))
        .map((record): EventDraft => ({
          source: "APPLICATION",
          type: "STUDENT_EVIDENCE_INVALIDATED",
          payload: {
            key: record.key,
            invalidatesEventId: record.evidenceEventId,
            reason: "Transcript correction made the supporting interpretation stale"
          }
        }));
      return {
        drafts: [
          {
            source: "APPLICATION",
            type: "TRANSCRIPT_CORRECTED",
            payload: {
              transcriptRevision: TranscriptRevisionSchema.parse(state.transcriptRevision + 1),
              contextEpoch: ContextEpochSchema.parse(state.contextEpoch + 1),
              correctedText
            }
          },
          ...invalidations,
          ...invalidateUndeliveredPolicyOutput(
            state,
            "Authoritative transcript changed before delivery"
          )
        ],
        result: { corrected: true }
      };
    });
  }
}

function rejectDrafts(generationId: GenerationId, proposal: InterviewerProposal, reason: string): { readonly drafts: readonly EventDraft[]; readonly result: ProcessProposalResult } {
  return {
    drafts: [
      { source: "PROVIDER", type: "MODEL_PROPOSAL_RECEIVED", payload: { generationId, proposal } },
      { source: "APPLICATION", type: "PROPOSAL_REJECTED", payload: { generationId, reason } }
    ],
    result: { accepted: false, deliveryAtoms: [], reason }
  };
}

function rejectAndSupersedeDrafts(
  generationId: GenerationId,
  proposal: InterviewerProposal,
  reason: string
): { readonly drafts: readonly EventDraft[]; readonly result: ProcessProposalResult } {
  const rejected = rejectDrafts(generationId, proposal, reason);
  return {
    drafts: [
      ...rejected.drafts,
      { source: "APPLICATION", type: "MODEL_GENERATION_SUPERSEDED", payload: { generationId, reason } }
    ],
    result: rejected.result
  };
}
