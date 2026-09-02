import { types as utilTypes } from "node:util";
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
export const ANTIGRAVITY_CLI_AGENT_ID = "interview-realizer";
export const ANTIGRAVITY_CLI_ADAPTER_VERSION = "1.0.0";

const MAX_CONTEXT_BYTES = 96 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SPEECH_CHARACTERS = 12_000;
const MAX_DISCLOSURE_IDS = 128;
const MAX_DISCLOSURE_ID_CHARACTERS = 256;
const MAX_BOARD_ACTIONS = 64;
const MAX_BOARD_CONTENT_CHARACTERS = 8_000;
const MAX_BOARD_TARGET_ID_CHARACTERS = 256;
const MAX_ANNOTATION_PURPOSE_CHARACTERS = 2_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_TEXT_CHARACTERS = 128 * 1024;
const EXECUTION_TIMEOUT_MS = 150_000;
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
      maxItems: MAX_DISCLOSURE_IDS,
      items: {
        type: "string",
        minLength: 1,
        maxLength: MAX_DISCLOSURE_ID_CHARACTERS
      }
    },
    speechText: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SPEECH_CHARACTERS
    },
    boardActions: {
      type: "array",
      maxItems: MAX_BOARD_ACTIONS,
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
          content: {
            type: "string",
            maxLength: MAX_BOARD_CONTENT_CHARACTERS
          },
          targetShapeId: {
            type: "string",
            minLength: 1,
            maxLength: MAX_BOARD_TARGET_ID_CHARACTERS
          },
          expectedShapeRevision: {
            type: "integer",
            minimum: 1
          },
          annotationPurpose: {
            type: "string",
            minLength: 1,
            maxLength: MAX_ANNOTATION_PURPOSE_CHARACTERS
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
export const ANTIGRAVITY_CLI_PROPOSAL_SCHEMA_ARGUMENT = JSON.stringify(
  INTERVIEWER_PROPOSAL_JSON_SCHEMA
);
const INTERVIEWER_PROPOSAL_SCHEMA_CANONICAL = serializeBoundedPlainJson(
  INTERVIEWER_PROPOSAL_JSON_SCHEMA,
  MAX_SCHEMA_BYTES
);

const INIT_TOOLS_FIELD = "tools" as const;

const InitEventSchema = z.looseObject({
  event: z.literal("init"),
  conversation_id: z.string().min(1).max(256),
  init: z.looseObject({
    [INIT_TOOLS_FIELD]: z.array(z.string().min(1)).max(128),
    permission_mode: z.string().min(1),
    model: z.string().min(1),
    agent: z.string().min(1),
    json_schema: z.unknown()
  })
});

const StepUpdateEventSchema = z.looseObject({
  event: z.literal("step_update"),
  step_update: z.looseObject({
    conversation_id: z.string().min(1).max(256),
    step_index: z.number().int().nonnegative(),
    state: z.enum(["ACTIVE", "DONE"]),
    step_type: z.string().min(1),
    tool_name: z.string().min(1).optional(),
    tool_info: z.unknown().optional(),
    subagent_info: z.unknown().optional()
  })
});

const ResultEventSchema = z.looseObject({
  event: z.literal("result"),
  result: z.looseObject({
    conversation_id: z.string().min(1).max(256),
    status: z.string().min(1),
    num_turns: z.number().int().nonnegative(),
    structured_output: z.unknown().optional(),
    json_schema: z.unknown()
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
    snapshotTurnInput(input) {
      return snapshotAntigravityTurnInput(input);
    },
    async verifyBillingSafety({ now }) {
      return {
        billingClass: "UNKNOWN",
        enforcementMechanism:
          "Isolated CLI settings disable AI-credit fallback, but account-side incremental billing is not independently verified",
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
            ANTIGRAVITY_CLI_PROPOSAL_SCHEMA_ARGUMENT,
            "--model",
            modelId,
            "--agent",
            ANTIGRAVITY_CLI_AGENT_ID,
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
      return parseAntigravityStream(
        result.stdout,
        modelId,
        ANTIGRAVITY_CLI_AGENT_ID
      );
    }
  });
}

function captureExecutor(
  executor: unknown
): SupervisedCliExecutor["execute"] {
  if (
    typeof executor !== "object"
    || executor === null
    || utilTypes.isProxy(executor)
  ) {
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

function snapshotAntigravityTurnInput(
  input: ReasoningTurnInput
): ReasoningTurnInput {
  let serializedContext: string;
  let snapshotContext: unknown;
  try {
    serializedContext = serializeBoundedPlainJson(
      readOwnTurnContext(input),
      MAX_CONTEXT_BYTES
    );
    snapshotContext = parseStrictJson(serializedContext);
  } catch {
    throw new AntigravityCliAdapterError("INVALID_CONTEXT");
  }
  return Object.freeze({
    generationId: input.generationId,
    context: snapshotContext
  });
}

function createSingleTurnInput(input: ReasoningTurnInput): string {
  let serializedContext: string;
  try {
    serializedContext = serializeBoundedPlainJson(
      readOwnTurnContext(input),
      MAX_CONTEXT_BYTES
    );
  } catch {
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

function parseAntigravityStream(
  stdout: string,
  expectedModelId: string,
  expectedAgentId: string
): InterviewerProposal {
  const lines = stdout.split(/\r?\n/u);
  let sawInit = false;
  let sawResult = false;
  let conversationId: string | undefined;
  let proposal: InterviewerProposal | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === undefined || raw.trim().length === 0) continue;
    if (sawResult) throw new AntigravityCliAdapterError("INVALID_PROTOCOL");

    let event: unknown;
    try {
      event = parseStrictJson(raw);
    } catch {
      throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
    }

    const init = InitEventSchema.safeParse(event);
    if (init.success) {
      const schemaMatches = schemaMatchesProposalContract(
        init.data.init.json_schema
      );
      if (
        sawInit
        || index !== firstNonBlankLineIndex(lines)
        || init.data.init.model !== expectedModelId
        || init.data.init.agent !== expectedAgentId
        || init.data.init.tools.length !== 0
        || !schemaMatches
        || (
          init.data.init.permission_mode !== "strict"
          && init.data.init.permission_mode !== "request-review"
        )
      ) {
        throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
      }
      conversationId = init.data.conversation_id;
      sawInit = true;
      continue;
    }

    const step = StepUpdateEventSchema.safeParse(event);
    if (step.success) {
      if (
        !sawInit
        || conversationId === undefined
        || step.data.step_update.conversation_id !== conversationId
      ) {
        throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
      }
      if (
        step.data.step_update.step_type === "tool"
        || step.data.step_update.tool_name !== undefined
        || step.data.step_update.tool_info !== undefined
        || step.data.step_update.subagent_info !== undefined
      ) {
        throw new AntigravityCliAdapterError("TOOL_ACTIVITY_REJECTED");
      }
      if (
        step.data.step_update.step_type !== "user_input"
        && step.data.step_update.step_type !== "agent_response"
        && step.data.step_update.step_type !== "checkpoint"
      ) {
        throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
      }
      continue;
    }

    const result = ResultEventSchema.safeParse(event);
    if (result.success) {
      const schemaMatches = schemaMatchesProposalContract(
        result.data.result.json_schema
      );
      if (
        !sawInit
        || conversationId === undefined
        || result.data.result.conversation_id !== conversationId
        || result.data.result.status !== "SUCCESS"
        || result.data.result.num_turns !== 1
        || !schemaMatches
      ) {
        throw new AntigravityCliAdapterError("INVALID_PROTOCOL");
      }
      const parsedProposal = InterviewerProposalSchema.safeParse(
        result.data.result.structured_output
      );
      if (
        !parsedProposal.success
        || !antigravityProposalWithinBounds(parsedProposal.data)
      ) {
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

function antigravityProposalWithinBounds(
  proposal: InterviewerProposal
): boolean {
  if (
    proposal.speechText !== undefined
    && proposal.speechText.length > MAX_SPEECH_CHARACTERS
  ) {
    return false;
  }
  if (proposal.claimedDisclosureIds.length > MAX_DISCLOSURE_IDS) return false;
  for (const disclosureId of proposal.claimedDisclosureIds) {
    if (disclosureId.length > MAX_DISCLOSURE_ID_CHARACTERS) return false;
  }

  const boardActions = proposal.boardActions ?? [];
  if (boardActions.length > MAX_BOARD_ACTIONS) return false;
  for (const action of boardActions) {
    if (
      action.content !== undefined
      && action.content.length > MAX_BOARD_CONTENT_CHARACTERS
    ) {
      return false;
    }
    if (
      action.targetShapeId !== undefined
      && action.targetShapeId.length > MAX_BOARD_TARGET_ID_CHARACTERS
    ) {
      return false;
    }
    if (action.annotationPurpose.length > MAX_ANNOTATION_PURPOSE_CHARACTERS) {
      return false;
    }
  }
  return true;
}

function schemaMatchesProposalContract(value: unknown): boolean {
  try {
    return serializeBoundedPlainJson(value, MAX_SCHEMA_BYTES)
      === INTERVIEWER_PROPOSAL_SCHEMA_CANONICAL;
  } catch {
    return false;
  }
}

function readOwnTurnContext(input: unknown): unknown {
  if (
    typeof input !== "object"
    || input === null
    || utilTypes.isProxy(input)
    || Array.isArray(input)
  ) {
    throw new Error("Turn input must be a plain object");
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Turn input must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const context = descriptors.context;
  if (
    context === undefined
    || context.enumerable !== true
    || !("value" in context)
  ) {
    throw new Error("Turn context must be an own data property");
  }
  return context.value;
}

function serializeBoundedPlainJson(
  value: unknown,
  maximumBytes: number
): string {
  const seen = new WeakSet<object>();
  const budget = { nodes: 0, textCharacters: 0 };

  const visit = (candidate: unknown, depth: number): string => {
    if (depth > MAX_JSON_DEPTH) throw new Error("JSON depth exceeded");
    budget.nodes += 1;
    if (budget.nodes > MAX_JSON_NODES) throw new Error("JSON node budget exceeded");

    if (candidate === null) return "null";
    if (typeof candidate === "string") {
      budget.textCharacters += candidate.length;
      if (
        candidate.length > MAX_JSON_TEXT_CHARACTERS
        || budget.textCharacters > MAX_JSON_TEXT_CHARACTERS
      ) {
        throw new Error("JSON text budget exceeded");
      }
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "boolean") return candidate ? "true" : "false";
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("Non-finite JSON number");
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== "object") {
      throw new Error("Non-JSON value");
    }

    if (utilTypes.isProxy(candidate)) throw new Error("Proxy JSON values are forbidden");
    if (seen.has(candidate)) throw new Error("Cyclic JSON value");
    seen.add(candidate);
    try {
      const symbols = Object.getOwnPropertySymbols(candidate);
      if (symbols.length !== 0) throw new Error("Symbol properties are forbidden");

      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new Error("Array prototype is not trusted");
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const length = Object.getOwnPropertyDescriptor(candidate, "length")?.value as unknown;
        if (
          typeof length !== "number"
          || !Number.isSafeInteger(length)
          || length < 0
          || length > MAX_JSON_NODES
        ) {
          throw new Error("Invalid JSON array length");
        }
        const allowedKeys = new Set<string>(["length"]);
        const items: string[] = [];
        for (let index = 0; index < length; index += 1) {
          const key = String(index);
          allowedKeys.add(key);
          const descriptor = descriptors[key];
          if (
            descriptor === undefined
            || descriptor.enumerable !== true
            || !("value" in descriptor)
          ) {
            throw new Error("JSON arrays must be dense data arrays");
          }
          items.push(visit(descriptor.value, depth + 1));
        }
        for (const key of Object.keys(descriptors)) {
          if (!allowedKeys.has(key)) throw new Error("JSON array has side properties");
        }
        return `[${items.join(",")}]`;
      }

      const prototype: unknown = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("JSON object prototype is not trusted");
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const entries: Array<readonly [string, string]> = [];
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (
          descriptor.enumerable !== true
          || !("value" in descriptor)
          || descriptor.value === undefined
          || key === "__proto__"
          || key === "prototype"
          || key === "constructor"
        ) {
          throw new Error("JSON objects must contain only own data properties");
        }
        budget.textCharacters += key.length;
        if (budget.textCharacters > MAX_JSON_TEXT_CHARACTERS) {
          throw new Error("JSON text budget exceeded");
        }
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }
      entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return `{${entries.map(([key, serialized]) =>
        `${JSON.stringify(key)}:${serialized}`
      ).join(",")}}`;
    } finally {
      seen.delete(candidate);
    }
  };

  const serialized = visit(value, 0);
  if (new TextEncoder().encode(serialized).byteLength > maximumBytes) {
    throw new Error("JSON byte budget exceeded");
  }
  return serialized;
}

function parseStrictJson(raw: string): unknown {
  let index = 0;
  let nodes = 0;

  const skipWhitespace = (): void => {
    while (index < raw.length) {
      const code = raw.charCodeAt(index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      index += 1;
    }
  };

  const parseString = (): string => {
    if (raw[index] !== '"') throw new Error("Expected JSON string");
    const start = index;
    index += 1;
    while (index < raw.length) {
      const code = raw.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        const decoded: unknown = JSON.parse(raw.slice(start, index));
        if (typeof decoded !== "string") throw new Error("Invalid JSON string");
        return decoded;
      }
      if (code <= 0x1f) throw new Error("Invalid JSON control character");
      if (code === 0x5c) {
        index += 1;
        if (index >= raw.length) throw new Error("Truncated JSON escape");
        const escape = raw[index];
        if (escape === "u") {
          if (!/^[0-9A-Fa-f]{4}$/u.test(raw.slice(index + 1, index + 5))) {
            throw new Error("Invalid JSON unicode escape");
          }
          index += 5;
          continue;
        }
        if (
          escape !== '"'
          && escape !== "\\"
          && escape !== "/"
          && escape !== "b"
          && escape !== "f"
          && escape !== "n"
          && escape !== "r"
          && escape !== "t"
        ) {
          throw new Error("Invalid JSON escape");
        }
      }
      index += 1;
    }
    throw new Error("Unterminated JSON string");
  };

  const parseNumber = (): void => {
    if (raw[index] === "-") index += 1;
    if (raw[index] === "0") {
      index += 1;
      if (isAsciiDigit(raw.charCodeAt(index))) {
        throw new Error("Invalid JSON leading zero");
      }
    } else {
      const first = raw.charCodeAt(index);
      if (first < 0x31 || first > 0x39) {
        throw new Error("Invalid JSON number");
      }
      index += 1;
      while (isAsciiDigit(raw.charCodeAt(index))) index += 1;
    }

    if (raw[index] === ".") {
      index += 1;
      if (!isAsciiDigit(raw.charCodeAt(index))) {
        throw new Error("Invalid JSON fraction");
      }
      while (isAsciiDigit(raw.charCodeAt(index))) index += 1;
    }

    if (raw[index] === "e" || raw[index] === "E") {
      index += 1;
      if (raw[index] === "+" || raw[index] === "-") index += 1;
      if (!isAsciiDigit(raw.charCodeAt(index))) {
        throw new Error("Invalid JSON exponent");
      }
      while (isAsciiDigit(raw.charCodeAt(index))) index += 1;
    }
  };

  const consumeLiteral = (literal: string): void => {
    if (!raw.startsWith(literal, index)) throw new Error("Invalid JSON literal");
    index += literal.length;
  };

  const parseValue = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new Error("JSON depth exceeded");
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new Error("JSON node budget exceeded");
    skipWhitespace();
    const token = raw[index];
    if (token === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error("Duplicate JSON object key");
        keys.add(key);
        skipWhitespace();
        if (raw[index] !== ":") throw new Error("Expected JSON colon");
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (raw[index] === "}") {
          index += 1;
          return;
        }
        if (raw[index] !== ",") throw new Error("Expected JSON object comma");
        index += 1;
      }
    }
    if (token === "[") {
      index += 1;
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        parseValue(depth + 1);
        skipWhitespace();
        if (raw[index] === "]") {
          index += 1;
          return;
        }
        if (raw[index] !== ",") throw new Error("Expected JSON array comma");
        index += 1;
      }
    }
    if (token === '"') {
      parseString();
      return;
    }
    if (token === "t") {
      consumeLiteral("true");
      return;
    }
    if (token === "f") {
      consumeLiteral("false");
      return;
    }
    if (token === "n") {
      consumeLiteral("null");
      return;
    }
    parseNumber();
  };

  parseValue(0);
  skipWhitespace();
  if (index !== raw.length) throw new Error("Trailing JSON content");
  return JSON.parse(raw) as unknown;
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
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
