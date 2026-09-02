import { z } from "zod";
import {
  InterviewerProposalSchema,
  type InterviewerProposal,
  type ReasoningTurnInput
} from "../../domain/src/index.js";
import {
  SupervisedCliReasoningProvider,
  type SupervisedCliExecutor
} from "./supervised-cli-provider.js";

export const ANTIGRAVITY_CLI_PROVIDER_ID = "antigravity-cli";
export const ANTIGRAVITY_CLI_MODEL_ID = "gemini-3.7-flash-medium";
export const ANTIGRAVITY_CLI_ADAPTER_VERSION = "1.0.0";

const MAX_CONTEXT_BYTES = 96 * 1024;
const EXECUTION_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 384 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;

const SOCRATIC_ACTIONS = [
  "WAIT",
  "CLARIFY",
  "PROBE_JUSTIFICATION",
  "CHECK_LOCAL_STEP",
  "ASK_FOR_EXAMPLE",
  "ASK_FOR_COUNTEREXAMPLE",
  "SIMPLIFY_CASE",
  "CHANGE_REPRESENTATION",
  "FOCUS_ATTENTION",
  "RECALL_RELEVANT_FACT",
  "CHALLENGE_ASSUMPTION",
  "DIRECTIONAL_NUDGE",
  "EXPLICIT_HINT",
  "VERIFY",
  "GENERALIZE",
  "ASK_ALTERNATE_SOLUTION"
] as const;

const BOARD_OPERATIONS = [
  "write_text",
  "write_equation",
  "draw_arrow",
  "circle",
  "highlight",
  "point_at",
  "erase_ai_annotation"
] as const;

const INTERVIEWER_PROPOSAL_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    realizedAction: {
      type: "string",
      enum: [...SOCRATIC_ACTIONS]
    },
    claimedDisclosureLevel: {
      type: "integer",
      enum: [0, 1, 2, 3, 4, 5]
    },
    claimedDisclosureIds: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    speechText: {
      type: "string",
      minLength: 1
    },
    boardActions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: [...BOARD_OPERATIONS]
          },
          layer: {
            type: "string",
            enum: ["AI_ANNOTATION"]
          },
          content: { type: "string" },
          targetShapeId: { type: "string", minLength: 1 },
          expectedShapeRevision: {
            type: "integer",
            minimum: 1
          },
          annotationPurpose: {
            type: "string",
            minLength: 1
          }
        },
        required: ["operation", "layer", "annotationPurpose"]
      }
    }
  },
  required: [
    "realizedAction",
    "claimedDisclosureLevel",
    "claimedDisclosureIds"
  ],
  anyOf: [
    { required: ["speechText"] },
    {
      required: ["boardActions"],
      properties: {
        boardActions: { minItems: 1 }
      }
    }
  ]
});
const INTERVIEWER_PROPOSAL_SCHEMA_ARGUMENT = JSON.stringify(
  INTERVIEWER_PROPOSAL_JSON_SCHEMA
);

const InitEventSchema = z.looseObject({
  event: z.literal("init")
});

const StepUpdateEventSchema = z.looseObject({
  event: z.literal("step_update"),
  step_update: z.looseObject({
    step_type: z.string().min(1),
    tool_info: z.unknown().optional(),
    subagent_info: z.unknown().optional()
  })
});

const ResultEventSchema = z.looseObject({
  event: z.literal("result"),
  result: z.looseObject({
    status: z.string().min(1),
    num_turns: z.number().int().nonnegative(),
    structured_output: z.unknown().optional()
  })
});

export type AntigravityCliAdapterErrorCode =
  | "INVALID_RUNTIME"
  | "INVALID_CONTEXT"
  | "PROCESS_FAILED"
  | "INVALID_PROTOCOL"
  | "TOOL_ACTIVITY_REJECTED"
  | "INVALID_PROPOSAL";

export class AntigravityCliAdapterError extends Error {
  public constructor(public readonly code: AntigravityCliAdapterErrorCode) {
    super(antigravityCliAdapterErrorMessage(code));
    this.name = "AntigravityCliAdapterError";
  }
}

export function createAntigravityCliReasoningProvider(
  executor: SupervisedCliExecutor,
  modelId: string = ANTIGRAVITY_CLI_MODEL_ID
): SupervisedCliReasoningProvider {
  const execute = captureExecutor(executor);
  if (modelId !== ANTIGRAVITY_CLI_MODEL_ID) {
    throw new AntigravityCliAdapterError("INVALID_RUNTIME");
  }

  return new SupervisedCliReasoningProvider({
    providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
    adapterVersion: ANTIGRAVITY_CLI_ADAPTER_VERSION,
    capabilities: {
      inputModalities: new Set(["text"]),
      textStreaming: false,
      structuredOutput: "FINAL_ONLY",
      persistentSession: false,
      resumableSession: false,
      cancellation: "INTERRUPT_LOCAL_PROCESS",
      sessionSurvivesClientAbort: false,
      sessionSurvivesProviderCancel: false,
      usageReporting: false,
      dataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT"
    },
    async verifyBillingSafety({ now }) {
      return {
        billingClass: "UNKNOWN",
        enforcementMechanism:
          "Antigravity account quota and AI-credit overage state are not application-enforced",
        verifiedAt: now.toISOString(),
        adapterVersion: ANTIGRAVITY_CLI_ADAPTER_VERSION,
        spendImpossible: false
      };
    },
    async executeTurn(input, runtime) {
      const stdin = createSingleTurnInput(input);
      let result;
      try {
        result = await execute({
          args: [
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--json-schema",
            INTERVIEWER_PROPOSAL_SCHEMA_ARGUMENT,
            "--model",
            modelId,
            "--print-timeout",
            "2m",
            "--sandbox"
          ],
          stdin,
          timeoutMs: EXECUTION_TIMEOUT_MS,
          maxStdoutBytes: MAX_STDOUT_BYTES,
          maxStderrBytes: MAX_STDERR_BYTES,
          signal: runtime.signal,
          onProcessStart: runtime.onProcessStart
        });
      } catch {
        throw new AntigravityCliAdapterError("PROCESS_FAILED");
      }
      if (result.exitCode !== 0) {
        throw new AntigravityCliAdapterError("PROCESS_FAILED");
      }
      return parseAntigravityStream(result.stdout);
    }
  });
}

function captureExecutor(
  executor: unknown
): SupervisedCliExecutor["execute"] {
  if (typeof executor !== "object" || executor === null) {
    throw new AntigravityCliAdapterError("INVALID_RUNTIME");
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(executor, "execute");
  } catch {
    throw new AntigravityCliAdapterError("INVALID_RUNTIME");
  }
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || typeof descriptor.value !== "function"
  ) {
    throw new AntigravityCliAdapterError("INVALID_RUNTIME");
  }
  return descriptor.value as SupervisedCliExecutor["execute"];
}

function createSingleTurnInput(input: ReasoningTurnInput): string {
  let serializedContext: string;
  try {
    serializedContext = JSON.stringify(input.context);
  } catch {
    throw new AntigravityCliAdapterError("INVALID_CONTEXT");
  }
  if (
    typeof serializedContext !== "string"
    || new TextEncoder().encode(serializedContext).byteLength > MAX_CONTEXT_BYTES
  ) {
    throw new AntigravityCliAdapterError("INVALID_CONTEXT");
  }

  const prompt = [
    "You are a fallible interviewer-response realization engine.",
    "The application remains authoritative for state, pedagogy, disclosure, and delivery.",
    "Use only the application-selected JSON context below for this turn.",
    "Do not use tools, subagents, files, prior conversations, or persistent memory.",
    "Return exactly one interviewer proposal satisfying the supplied JSON schema.",
    "Do not add facts or disclosures that are not authorized by the context.",
    "",
    "APPLICATION_SELECTED_CONTEXT_JSON",
    serializedContext
  ].join("\n");

  return JSON.stringify({
    event: "user",
    message: { content: prompt }
  }) + "\n";
}

function parseAntigravityStream(stdout: string): InterviewerProposal {
  const lines = stdout.split(/\r?\n/u);
  let sawInit = false;
  let sawResult = false;
  let proposal: InterviewerProposal | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === undefined || raw.trim().length === 0) continue;
    if (sawResult) throw new AntigravityCliAdapterError("INVALID_PROTOCOL");

    let event: unknown;
    try {
      event = JSON.parse(raw) as unknown;
    } catch {
      throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
    }

    const init = InitEventSchema.safeParse(event);
    if (init.success) {
      if (sawInit || index !== firstNonBlankLineIndex(lines)) {
        throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
      }
      sawInit = true;
      continue;
    }

    const step = StepUpdateEventSchema.safeParse(event);
    if (step.success) {
      if (!sawInit) throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
      if (
        step.data.step_update.step_type === "tool"
        || step.data.step_update.tool_info !== undefined
        || step.data.step_update.subagent_info !== undefined
      ) {
        throw new AntigravityCliAdapterError("TOOL_ACTIVITY_REJECTED");
      }
      continue;
    }

    const result = ResultEventSchema.safeParse(event);
    if (result.success) {
      if (
        !sawInit
        || result.data.result.status !== "SUCCESS"
        || result.data.result.num_turns !== 1
      ) {
        throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
      }
      const parsedProposal = InterviewerProposalSchema.safeParse(
        result.data.result.structured_output
      );
      if (!parsedProposal.success) {
        throw new AntigravityCliAdapterError("INVALID_PROPOSAL");
      }
      proposal = parsedProposal.data;
      sawResult = true;
      continue;
    }

    throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
  }

  if (!sawInit || !sawResult || proposal === undefined) {
    throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
  }
  return proposal;
}

function firstNonBlankLineIndex(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim().length > 0) return index;
  }
  return -1;
}

function antigravityCliAdapterErrorMessage(
  code: AntigravityCliAdapterErrorCode
): string {
  switch (code) {
    case "INVALID_RUNTIME": return "Antigravity CLI runtime is invalid";
    case "INVALID_CONTEXT": return "Antigravity CLI turn context is invalid";
    case "PROCESS_FAILED": return "Antigravity CLI execution failed";
    case "INVALID_PROTOCOL": return "Antigravity CLI protocol output is invalid";
    case "TOOL_ACTIVITY_REJECTED": return "Antigravity CLI attempted unsupported tool activity";
    case "INVALID_PROPOSAL": return "Antigravity CLI structured proposal is invalid";
  }
}
