import { describe, expect, it } from "vitest";
import {
  BoardActionSchema,
  DisclosureIdSchema,
  SocraticActionSchema,
  newGenerationId,
  type InterviewerProposal,
  type ReasoningTurnInput
} from "../packages/domain/src/index.js";
import {
  ANTIGRAVITY_CLI_ADAPTER_VERSION,
  ANTIGRAVITY_CLI_AGENT_ID,
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_PROPOSAL_SCHEMA_ARGUMENT,
  ANTIGRAVITY_CLI_PROVIDER_DEFINITION,
  ANTIGRAVITY_CLI_PROVIDER_ID,
  ANTIGRAVITY_CLI_ZERO_TURN_PREFLIGHT_INPUT,
  AntigravityCliAdapterError,
  assertAntigravityCliZeroTurnPreflightResult,
  SupervisedCliReasoningProvider,
  assertProviderPermitted,
  createAntigravityCliReasoningProvider,
  registerBuiltInProviders,
  resolveAdapterFactory,
  resolveProviderConfiguration,
  type SupervisedCliExecutionRequest,
  type SupervisedCliExecutionResult,
  type SupervisedCliProviderDefinition,
  type SupervisedCliExecutor
} from "../packages/providers/src/index.js";

const ANTIGRAVITY_CLI_PROPOSAL_SCHEMA =
  JSON.parse(ANTIGRAVITY_CLI_PROPOSAL_SCHEMA_ARGUMENT) as unknown;

const PROPOSAL: InterviewerProposal = {
  realizedAction: "CLARIFY",
  claimedDisclosureLevel: 0,
  claimedDisclosureIds: [],
  speechText: "What would you try next?"
};

function executionResult(
  stdout: string,
  overrides: Partial<SupervisedCliExecutionResult> = {}
): SupervisedCliExecutionResult {
  return {
    exitCode: 0,
    stdout,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: 0,
    ...overrides
  };
}

function antigravityStream(
  proposal: InterviewerProposal = PROPOSAL,
  between: readonly unknown[] = []
): string {
  return [
    JSON.stringify({
      event: "init",
      conversation_id: "fake-conversation",
      init: {
        cwd: "/isolated",
        tools: [],
        permission_mode: "strict",
        model: ANTIGRAVITY_CLI_MODEL_ID,
        agent: ANTIGRAVITY_CLI_AGENT_ID,
        json_schema: ANTIGRAVITY_CLI_PROPOSAL_SCHEMA
      }
    }),
    ...between.map((event) => JSON.stringify(event)),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "fake-conversation",
        status: "SUCCESS",
        response: JSON.stringify(proposal),
        duration_seconds: 0.1,
        num_turns: 1,
        structured_output: proposal,
        json_schema: ANTIGRAVITY_CLI_PROPOSAL_SCHEMA,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 2
        }
      }
    })
  ].join("\n") + "\n";
}

interface ZeroTurnPreflightOverrides {
  readonly tools?: readonly string[];
  readonly permissionMode?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly schema?: unknown;
  readonly resultStatus?: string;
  readonly numTurns?: number;
  readonly totalTokens?: number;
}

function zeroTurnPreflightStream(
  overrides: ZeroTurnPreflightOverrides = {}
): string {
  const totalTokens = overrides.totalTokens ?? 0;
  return [
    JSON.stringify({
      event: "init",
      conversation_id: "preflight-conversation",
      init: {
        cwd: "/isolated",
        tools: [...(overrides.tools ?? [])],
        permission_mode: overrides.permissionMode ?? "strict",
        model: overrides.model ?? ANTIGRAVITY_CLI_MODEL_ID,
        agent: overrides.agent ?? ANTIGRAVITY_CLI_AGENT_ID,
        json_schema: overrides.schema ?? ANTIGRAVITY_CLI_PROPOSAL_SCHEMA
      }
    }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "preflight-conversation",
        status: overrides.resultStatus ?? "ERROR",
        response: "",
        error: "unsupported stream input message",
        duration_seconds: 0,
        num_turns: overrides.numTurns ?? 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens
        }
      }
    })
  ].join("\n") + "\n";
}

function fakeExecutor(
  implementation: (
    request: SupervisedCliExecutionRequest
  ) => Promise<SupervisedCliExecutionResult>
): SupervisedCliExecutor {
  return Object.freeze({ execute: implementation });
}

function turnInput(context: unknown): ReasoningTurnInput {
  return {
    generationId: newGenerationId(),
    context
  };
}

async function collectProposals(
  input: AsyncIterable<InterviewerProposal>
): Promise<readonly InterviewerProposal[]> {
  const proposals: InterviewerProposal[] = [];
  for await (const proposal of input) proposals.push(proposal);
  return proposals;
}

describe("Antigravity zero-turn runtime preflight", () => {
  it("accepts only the exact zero-turn no-tool profile", () => {
    expect(ANTIGRAVITY_CLI_ZERO_TURN_PREFLIGHT_INPUT)
      .toBe('{"event":"control_request"}\n');
    expect(() => assertAntigravityCliZeroTurnPreflightResult(
      executionResult(zeroTurnPreflightStream(), { exitCode: 2 })
    )).not.toThrow();
  });

  const invalidProfiles: readonly (
    readonly [string, ZeroTurnPreflightOverrides]
  )[] = [
    ["tool exposure", { tools: ["run_command"] }],
    ["permission drift", { permissionMode: "request-review" }],
    ["model drift", { model: "unexpected-model" }],
    ["agent drift", { agent: "unexpected-agent" }],
    ["schema drift", { schema: { type: "string" } }],
    ["successful result", { resultStatus: "SUCCESS" }],
    ["turn execution", { numTurns: 1 }],
    ["token use", { totalTokens: 1 }]
  ];

  it.each(invalidProfiles)(
    "rejects %s before any interview turn",
    (_label, overrides) => {
      expect(() => assertAntigravityCliZeroTurnPreflightResult(
        executionResult(zeroTurnPreflightStream(overrides), { exitCode: 2 })
      )).toThrowError(AntigravityCliAdapterError);
    }
  );

  it("requires the documented control-message exit code", () => {
    expect(() => assertAntigravityCliZeroTurnPreflightResult(
      executionResult(zeroTurnPreflightStream(), { exitCode: 1 })
    )).toThrowError(AntigravityCliAdapterError);
  });
});

describe("Antigravity structured-output contract alignment", () => {
  it("keeps provider action enums exactly aligned with authoritative domain schemas", () => {
    const schema = ANTIGRAVITY_CLI_PROPOSAL_SCHEMA as {
      readonly properties?: {
        readonly realizedAction?: { readonly enum?: readonly string[] };
        readonly boardActions?: {
          readonly items?: {
            readonly properties?: {
              readonly operation?: { readonly enum?: readonly string[] };
            };
          };
        };
      };
    };
    const providerActions = schema.properties?.realizedAction?.enum;
    const providerBoardOperations =
      schema.properties?.boardActions?.items?.properties?.operation?.enum;

    expect(providerActions).toEqual(SocraticActionSchema.options);
    expect(providerBoardOperations).toEqual(
      BoardActionSchema.shape.operation.options
    );
  });
});

describe("Antigravity CLI provider registration and policy truthfulness", () => {
  it("registers one pinned real model with conservative remote/billing capabilities", () => {
    const registry = registerBuiltInProviders();
    const provider = registry.getProvider(ANTIGRAVITY_CLI_PROVIDER_ID);
    const model = registry.getModel(
      ANTIGRAVITY_CLI_PROVIDER_ID,
      ANTIGRAVITY_CLI_MODEL_ID
    );

    expect(provider).toMatchObject({
      id: ANTIGRAVITY_CLI_PROVIDER_ID,
      kind: "OTHER",
      adapterVersion: ANTIGRAVITY_CLI_ADAPTER_VERSION,
      credentialRequirement: "NONE"
    });
    expect(model.capabilities).toMatchObject({
      textGeneration: "SUPPORTED",
      imageInput: "UNSUPPORTED",
      toolCalling: "UNSUPPORTED",
      streaming: "UNSUPPORTED",
      persistentSession: "UNSUPPORTED",
      resumableSession: "UNSUPPORTED",
      localExecution: "SUPPORTED",
      remoteExecution: "SUPPORTED",
      meteredExecution: "UNKNOWN",
      dataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT",
      structuredOutput: "FINAL_ONLY",
      cancellation: "INTERRUPT_LOCAL_PROCESS"
    });
    expect(ANTIGRAVITY_CLI_PROVIDER_DEFINITION.id).toBe(ANTIGRAVITY_CLI_PROVIDER_ID);

    expect(() => registry.getModel(
      ANTIGRAVITY_CLI_PROVIDER_ID,
      "invented-model"
    )).toThrow(expect.objectContaining({ code: "UNKNOWN_MODEL" }));
  });

  it("does not claim incremental spend is impossible without trusted runtime proof", async () => {
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => executionResult(antigravityStream()))
    );
    const now = new Date("2026-09-01T12:00:00.000Z");
    const verification = await provider.verifyBillingSafety({ now });

    expect(verification).toMatchObject({
      billingClass: "UNKNOWN",
      adapterVersion: ANTIGRAVITY_CLI_ADAPTER_VERSION,
      spendImpossible: false
    });

    expect(() => assertProviderPermitted({
      policy: {
        allowMeteredUsage: false,
        maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT",
        billingVerificationMaxAgeMs: 60_000
      },
      capabilities: provider.capabilities,
      billingVerification: verification,
      adapterVersion: provider.adapterVersion,
      now
    })).toThrow(expect.objectContaining({ code: "SPEND_NOT_PROVEN_IMPOSSIBLE" }));

    expect(() => assertProviderPermitted({
      policy: {
        allowMeteredUsage: true,
        maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT",
        billingVerificationMaxAgeMs: 60_000
      },
      capabilities: provider.capabilities,
      adapterVersion: provider.adapterVersion,
      now
    })).not.toThrow();
  });

  it("admits no-metered account quota only when the trusted runtime supplies proof", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => executionResult(antigravityStream())),
      ANTIGRAVITY_CLI_MODEL_ID,
      (verifiedAt) => ({
        billingClass: "ACCOUNT_QUOTA" as const,
        enforcementMechanism: "test-only isolated no-overage account profile",
        verifiedAt: verifiedAt.toISOString(),
        adapterVersion: ANTIGRAVITY_CLI_ADAPTER_VERSION,
        spendImpossible: true
      })
    );
    const verification = await provider.verifyBillingSafety({ now });

    expect(verification).toMatchObject({
      billingClass: "ACCOUNT_QUOTA",
      adapterVersion: ANTIGRAVITY_CLI_ADAPTER_VERSION,
      spendImpossible: true
    });
    expect(() => assertProviderPermitted({
      policy: {
        allowMeteredUsage: false,
        maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT",
        billingVerificationMaxAgeMs: 60_000
      },
      capabilities: provider.capabilities,
      billingVerification: verification,
      adapterVersion: provider.adapterVersion,
      now
    })).not.toThrow();
  });

  it("rejects accessor-backed runtime injection without invoking it", async () => {
    const registry = registerBuiltInProviders();
    const resolved = resolveProviderConfiguration({
      registry,
      configuration: {
        version: 1,
        providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
        modelId: ANTIGRAVITY_CLI_MODEL_ID,
        enabled: true
      }
    });
    const factory = resolveAdapterFactory(resolved);

    let getterCalls = 0;
    const runtime = Object.defineProperty({}, "executor", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return fakeExecutor(async () => executionResult(antigravityStream()));
      }
    });

    await expect(factory.createAdapter({
      resolved,
      runtime
    })).rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    expect(getterCalls).toBe(0);

    let billingGetterCalls = 0;
    const runtimeWithBillingGetter = Object.defineProperty({
      executor: fakeExecutor(async () => executionResult(antigravityStream()))
    }, "billingVerificationFactory", {
      enumerable: true,
      get() {
        billingGetterCalls += 1;
        return () => ({ spendImpossible: true });
      }
    });
    await expect(factory.createAdapter({
      resolved,
      runtime: runtimeWithBillingGetter
    })).rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    expect(billingGetterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const hostileProxy = new Proxy({}, {
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("must-not-run");
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("must-not-run");
      }
    });
    await expect(factory.createAdapter({
      resolved,
      runtime: hostileProxy
    })).rejects.toMatchObject({ code: "INVALID_FACTORY_INPUT" });
    expect(proxyTrapCalls).toBe(0);
  });
});

describe("supervised CLI provider definition boundary", () => {
  const definition = (): SupervisedCliProviderDefinition => ({
    providerId: "supervised-definition-test",
    adapterVersion: "1.0.0",
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
      return { checkedAt: now.toISOString() };
    },
    snapshotTurnInput(input) {
      return input;
    },
    async executeTurn() {
      return PROPOSAL;
    }
  });

  it("rejects nested accessor and Proxy capabilities without invoking user code", () => {
    let getterCalls = 0;
    const accessorDefinition = definition();
    const accessorCapabilities = Object.defineProperty({
      ...accessorDefinition.capabilities
    }, "textStreaming", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return false;
      }
    });

    expect(() => new SupervisedCliReasoningProvider({
      ...accessorDefinition,
      capabilities: accessorCapabilities
    })).toThrow("Supervised CLI provider definition is invalid");
    expect(getterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxyDefinition = definition();
    const proxyCapabilities = new Proxy(proxyDefinition.capabilities, {
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("must-not-run");
      }
    });
    expect(() => new SupervisedCliReasoningProvider({
      ...proxyDefinition,
      capabilities: proxyCapabilities
    })).toThrow("Supervised CLI provider definition is invalid");
    expect(proxyTrapCalls).toBe(0);
  });

  it("captures definition callbacks so later mutation cannot change execution", async () => {
    let originalBillingCalls = 0;
    const mutableDefinition = definition();
    Reflect.set(
      mutableDefinition,
      "verifyBillingSafety",
      async ({ now }: { readonly now: Date }) => {
        originalBillingCalls += 1;
        return {
          checkedAt: now.toISOString(),
          marker: "original"
        };
      }
    );
    const provider = new SupervisedCliReasoningProvider(mutableDefinition);
    Reflect.set(mutableDefinition, "verifyBillingSafety", async () => {
      throw new Error("mutated callback must not run");
    });

    await expect(provider.verifyBillingSafety({
      now: new Date("2026-09-02T00:00:00.000Z")
    })).resolves.toMatchObject({
      marker: "original"
    });
    expect(originalBillingCalls).toBe(1);
  });
});

describe("Antigravity CLI one-turn protocol", () => {
  it("sends exact application context through one stateless stdin turn and accepts only structured output", async () => {
    const requests: SupervisedCliExecutionRequest[] = [];
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async (request) => {
        requests.push(request);
        request.onProcessStart();
        return executionResult(antigravityStream(PROPOSAL, [{
          event: "step_update",
          step_update: {
            conversation_id: "fake-conversation",
            step_index: 0,
            state: "DONE",
            step_type: "user_input"
          }
        }]));
      })
    );
    const session = await provider.createSession();
    const context = {
      selectedAction: "CLARIFY",
      studentText: "I would try parity.",
      disclosure: { maximum: 0 }
    };

    await expect(collectProposals(session.sendTurn(turnInput(context))))
      .resolves.toEqual([PROPOSAL]);
    expect(requests).toHaveLength(1);

    const request = requests[0];
    expect(request?.args).toContain("--input-format");
    expect(request?.args).toContain("stream-json");
    expect(request?.args).toContain("--json-schema");
    expect(request?.args).not.toContain("--sandbox");
    expect(request?.args).toContain(ANTIGRAVITY_CLI_MODEL_ID);
    expect(request?.args).toContain("--agent");
    expect(request?.args).toContain(ANTIGRAVITY_CLI_AGENT_ID);
    expect(request?.args).not.toContain("--continue");
    expect(request?.args).not.toContain("--conversation");
    expect(request?.args).not.toContain("--dangerously-skip-permissions");

    const conservativeWindowsCommandLineCharacters =
      260 * 2 + 2 + (request?.args ?? []).reduce(
        (total, argument) => total + argument.length * 2 + 3,
        0
      );
    expect(conservativeWindowsCommandLineCharacters).toBeLessThan(24_000);

    const stdinMessage = JSON.parse((request?.stdin ?? "").trim()) as {
      readonly event?: unknown;
      readonly message?: { readonly content?: unknown };
    };
    expect(stdinMessage.event).toBe("user");
    const content = stdinMessage.message?.content;
    expect(typeof content).toBe("string");
    if (typeof content !== "string") throw new Error("Expected string prompt content");
    const contextMarker = "APPLICATION_SELECTED_CONTEXT_JSON\n";
    const contextIndex = content.indexOf(contextMarker);
    expect(contextIndex).toBeGreaterThanOrEqual(0);
    const serializedContext = content.slice(contextIndex + contextMarker.length);
    expect(JSON.parse(serializedContext)).toEqual(context);
    await session.close();
  });

  it("detaches nested context before the async iterator starts", async () => {
    let captured: SupervisedCliExecutionRequest | undefined;
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async (request) => {
        captured = request;
        request.onProcessStart();
        return executionResult(antigravityStream());
      })
    );
    const session = await provider.createSession();
    const context = {
      recentStudentWork: "original",
      nested: { value: "before" }
    };
    const stream = session.sendTurn(turnInput(context));

    context.recentStudentWork = "mutated";
    context.nested.value = "after";

    await expect(collectProposals(stream)).resolves.toEqual([PROPOSAL]);
    const stdinMessage = JSON.parse((captured?.stdin ?? "").trim()) as {
      readonly message?: { readonly content?: unknown };
    };
    const content = stdinMessage.message?.content;
    expect(typeof content).toBe("string");
    if (typeof content !== "string") throw new Error("Expected string prompt content");
    const markerText = "APPLICATION_SELECTED_CONTEXT_JSON\n";
    const serialized = content.slice(content.indexOf(markerText) + markerText.length);
    expect(JSON.parse(serialized)).toEqual({
      recentStudentWork: "original",
      nested: { value: "before" }
    });
    await session.close();
  });

  it("rejects malformed, ambiguous, tool-bearing, and non-proposal output", async () => {
    const invalidStreams = [
      "terminal prose\n",
      antigravityStream() + JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", num_turns: 1, structured_output: PROPOSAL }
      }) + "\n",
      antigravityStream() + "hostile trailing terminal text\n",
      antigravityStream().replace(
        '"event":"init"',
        '"event":"init","__proto__":{"polluted":true}'
      ),
      antigravityStream().replace(
        '"permission_mode":"strict"',
        '"permission_mode":"request-review"'
      ),
      antigravityStream().replace(
        '"permission_mode":"strict"',
        '"permission_mode":"always-proceed"'
      ),
      antigravityStream().replace(
        '"permission_mode":"strict"',
        '"permission_mode":"always-proceed","permission_mode":"request-review"'
      ),
      antigravityStream().replace(
        '"permission_mode":"strict"',
        '"permissi\\u006fn_mode":"always-proceed","permission_mode":"request-review"'
      ),
      antigravityStream().replace(
        '"permission_mode":"strict"',
        '"permission_mode":"proceed-in-sandbox"'
      ),
      antigravityStream().replace(
        '"model":"' + ANTIGRAVITY_CLI_MODEL_ID + '"',
        '"model":"unexpected-model"'
      ),
      antigravityStream().replace(
        '"agent":"' + ANTIGRAVITY_CLI_AGENT_ID + '"',
        '"agent":"unexpected-agent"'
      ),
      antigravityStream().replace('"tools":[]', '"tools":["run_command"]'),
      antigravityStream().replace(
        '"conversation_id":"fake-conversation","status":"SUCCESS"',
        '"conversation_id":"other-conversation","status":"SUCCESS"'
      ),
      antigravityStream(PROPOSAL, [{
        event: "step_update",
        step_update: {
          conversation_id: "fake-conversation",
          step_index: 1,
          state: "DONE",
          step_type: "checkpoint"
        }
      }]).replace(
        '"step_type":"checkpoint"',
        '"step_type":"checkpoint","duration_seconds":1e9999'
      ),
      antigravityStream(PROPOSAL, [{
        event: "step_update",
        step_update: {
          conversation_id: "fake-conversation",
          step_index: 1,
          state: "DONE",
          step_type: "unexpected-step"
        }
      }]),
      antigravityStream(PROPOSAL, [{
        event: "step_update",
        step_update: {
          conversation_id: "fake-conversation",
          step_index: 1,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command" }
        }
      }]),
      antigravityStream({
        ...PROPOSAL,
        speechText: undefined,
        boardActions: undefined
      }),
      antigravityStream({
        ...PROPOSAL,
        speechText: "x".repeat(12_001)
      }),
      antigravityStream({
        ...PROPOSAL,
        claimedDisclosureIds: Array.from(
          { length: 65 },
          (_, index) => DisclosureIdSchema.parse(
            `disclosure-${String(index)}`
          )
        )
      }),
      antigravityStream({
        ...PROPOSAL,
        claimedDisclosureIds: [
          DisclosureIdSchema.parse("d".repeat(129))
        ]
      }),
      antigravityStream({
        ...PROPOSAL,
        speechText: undefined,
        boardActions: Array.from({ length: 13 }, () => ({
          operation: "write_text" as const,
          layer: "AI_ANNOTATION" as const,
          content: "bounded",
          annotationPurpose: "bounded annotation"
        }))
      }),
      antigravityStream({
        ...PROPOSAL,
        speechText: undefined,
        boardActions: [{
          operation: "write_text",
          layer: "AI_ANNOTATION",
          content: "x".repeat(2_001),
          annotationPurpose: "bounded annotation"
        }]
      }),
      antigravityStream({
        ...PROPOSAL,
        speechText: undefined,
        boardActions: [{
          operation: "write_text",
          layer: "AI_ANNOTATION",
          content: "bounded",
          targetShapeId: "x".repeat(257),
          annotationPurpose: "bounded annotation"
        }]
      }),
      antigravityStream({
        ...PROPOSAL,
        speechText: undefined,
        boardActions: [{
          operation: "write_text",
          layer: "AI_ANNOTATION",
          content: "bounded",
          annotationPurpose: "x".repeat(513)
        }]
      })
    ];

    for (const stdout of invalidStreams) {
      const provider = createAntigravityCliReasoningProvider(
        fakeExecutor(async () => executionResult(stdout))
      );
      const session = await provider.createSession();
      await expect(collectProposals(session.sendTurn(turnInput({ safe: true }))))
        .rejects.toBeInstanceOf(AntigravityCliAdapterError);
      await session.close();
    }
  });

  it("uses JSON Schema code-point semantics for astral Unicode bounds", async () => {
    const proposal: InterviewerProposal = {
      ...PROPOSAL,
      speechText: "😀".repeat(7_000)
    };
    expect(proposal.speechText?.length).toBe(14_000);

    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => executionResult(antigravityStream(proposal)))
    );
    const session = await provider.createSession();
    await expect(collectProposals(
      session.sendTurn(turnInput({ safe: true }))
    )).resolves.toEqual([proposal]);
    await session.close();
  });

  it("keeps a worst-case escaped proposal inside the real stream transport budget", async () => {
    const transportBounded: InterviewerProposal = {
      realizedAction: "CLARIFY",
      claimedDisclosureLevel: 5,
      claimedDisclosureIds: Array.from(
        { length: 64 },
        (_, index) => DisclosureIdSchema.parse(
          `d${String(index).padStart(3, "0")}-${"\\".repeat(120)}`
        )
      ),
      speechText: "\\".repeat(12_000),
      boardActions: Array.from({ length: 12 }, () => ({
        operation: "write_text" as const,
        layer: "AI_ANNOTATION" as const,
        content: "\\".repeat(2_000),
        targetShapeId: "\\".repeat(256),
        expectedShapeRevision: Number.MAX_SAFE_INTEGER,
        annotationPurpose: "\\".repeat(512)
      }))
    };
    const response = JSON.stringify(transportBounded);
    const stdout = antigravityStream(transportBounded, [{
      event: "step_update",
      step_update: {
        conversation_id: "fake-conversation",
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: response
      }
    }]);
    expect(new TextEncoder().encode(stdout).byteLength).toBeLessThan(1024 * 1024);

    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => executionResult(stdout))
    );
    const session = await provider.createSession();
    await expect(collectProposals(
      session.sendTurn(turnInput({ safe: true }))
    )).resolves.toEqual([transportBounded]);
    await session.close();
  });

  it("preserves a data-method executor receiver without exposing it to the provider", async () => {
    const executor = {
      prefix: "receiver:",
      async execute(
        this: { readonly prefix: string }
      ): Promise<SupervisedCliExecutionResult> {
        if (this.prefix !== "receiver:") {
          throw new Error("receiver was lost");
        }
        return executionResult(antigravityStream());
      }
    };
    const provider = createAntigravityCliReasoningProvider(executor);
    const session = await provider.createSession();
    await expect(collectProposals(
      session.sendTurn(turnInput({ receiver: true }))
    )).resolves.toEqual([PROPOSAL]);
    await session.close();
  });

  it("rejects accessor/proxy executor results and lying byte counters without invoking traps", async () => {
    let getterCalls = 0;
    const accessorResult = Object.defineProperty({
      exitCode: 0,
      stdoutBytes: 0,
      stderrBytes: 0
    }, "stdout", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return antigravityStream();
      }
    });
    const accessorProvider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () =>
        accessorResult as unknown as SupervisedCliExecutionResult
      )
    );
    const accessorSession = await accessorProvider.createSession();
    await expect(collectProposals(
      accessorSession.sendTurn(turnInput({ safe: true }))
    )).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    expect(getterCalls).toBe(0);
    await accessorSession.close();

    let proxyTrapCalls = 0;
    const proxyResult = new Proxy({}, {
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("must-not-run");
      }
    });
    const proxyProvider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () =>
        proxyResult as unknown as SupervisedCliExecutionResult
      )
    );
    const proxySession = await proxyProvider.createSession();
    await expect(collectProposals(
      proxySession.sendTurn(turnInput({ safe: true }))
    )).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    expect(proxyTrapCalls).toBe(0);
    await proxySession.close();

    const stdout = antigravityStream();
    const lyingProvider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => ({
        exitCode: 0,
        stdout,
        stdoutBytes: 1,
        stderrBytes: 0
      }))
    );
    const lyingSession = await lyingProvider.createSession();
    await expect(collectProposals(
      lyingSession.sendTurn(turnInput({ safe: true }))
    )).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    await lyingSession.close();
  });

  it("rejects a terminal response that contradicts structured_output", async () => {
    const lines = antigravityStream().trim().split("\n");
    const terminal = JSON.parse(lines[lines.length - 1] ?? "{}") as {
      result?: { response?: string };
    };
    if (terminal.result === undefined) {
      throw new Error("test terminal result is missing");
    }
    terminal.result.response = JSON.stringify({
      ...PROPOSAL,
      speechText: "contradictory response"
    });
    lines[lines.length - 1] = JSON.stringify(terminal);

    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => executionResult(lines.join("\n") + "\n"))
    );
    const session = await provider.createSession();
    await expect(collectProposals(
      session.sendTurn(turnInput({ safe: true }))
    )).rejects.toMatchObject({ code: "INVALID_PROTOCOL" });
    await session.close();
  });

  it("does not surface stdout, stderr, or executor exception credentials in adapter errors", async () => {
    const secret = "SENSITIVE_EXECUTOR_SENTINEL";
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => {
        throw new Error(secret);
      })
    );
    const session = await provider.createSession();

    let observed: unknown;
    try {
      await collectProposals(session.sendTurn(turnInput({ safe: true })));
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(AntigravityCliAdapterError);
    expect(String(observed)).not.toContain(secret);
    await session.close();
  });

  it("makes cancellation before first iterator next sticky and starts no process", async () => {
    let calls = 0;
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => {
        calls += 1;
        return executionResult(antigravityStream());
      })
    );
    const session = await provider.createSession();
    const input = turnInput({ turn: "pre-iteration" });
    const stream = session.sendTurn(input);
    if (session.cancelTurn === undefined) {
      throw new Error("Antigravity session must support cancellation");
    }

    await expect(session.cancelTurn(input.generationId)).resolves.toEqual({
      semantics: "INTERRUPT_LOCAL_PROCESS",
      signalSent: false
    });
    await expect(collectProposals(stream)).resolves.toEqual([]);
    expect(calls).toBe(0);
    await session.close();
  });

  it("acknowledges local-process cancellation without waiting for executor settlement", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseExecution: (() => void) | undefined;
    let abortObserved = false;
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async (request) => {
        request.onProcessStart();
        markStarted?.();
        return await new Promise<SupervisedCliExecutionResult>((_resolve, reject) => {
          const onAbort = (): void => {
            abortObserved = true;
            releaseExecution = () => reject(new Error("released-after-cancel"));
          };
          if (request.signal.aborted) onAbort();
          else request.signal.addEventListener("abort", onAbort, { once: true });
        });
      })
    );
    const session = await provider.createSession();
    const input = turnInput({ turn: "nonblocking-cancel" });
    const completion = collectProposals(session.sendTurn(input));
    await started;
    if (session.cancelTurn === undefined) {
      throw new Error("Antigravity session must support cancellation");
    }

    const cancellation = session.cancelTurn(input.generationId);
    const winner = await Promise.race([
      cancellation.then((value) => ({ kind: "CANCELLED" as const, value })),
      new Promise<{ readonly kind: "TIMEOUT" }>((resolve) => {
        setTimeout(() => resolve({ kind: "TIMEOUT" }), 100);
      })
    ]);
    expect(winner).toEqual({
      kind: "CANCELLED",
      value: {
        semantics: "INTERRUPT_LOCAL_PROCESS",
        signalSent: true
      }
    });
    expect(abortObserved).toBe(true);

    releaseExecution?.();
    await expect(completion).rejects.toBeInstanceOf(AntigravityCliAdapterError);
    await session.close();
  });

  it("interrupts the supervised local process on generation cancellation without persistent-session reuse", async () => {
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const requests: SupervisedCliExecutionRequest[] = [];
    const executor = fakeExecutor(async (request) => {
      requests.push(request);
      request.onProcessStart();
      firstStarted?.();
      return await new Promise<SupervisedCliExecutionResult>((resolve, reject) => {
        void resolve;
        const onAbort = (): void => reject(new Error("cancelled-local-process"));
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) onAbort();
      });
    });
    const provider = createAntigravityCliReasoningProvider(executor);
    const session = await provider.createSession();
    const input = turnInput({ turn: "one" });
    const completion = collectProposals(session.sendTurn(input));

    await started;
    if (session.cancelTurn === undefined) {
      throw new Error("Antigravity session must support cancellation");
    }
    const cancellation = await session.cancelTurn(input.generationId);
    expect(cancellation).toEqual({
      semantics: "INTERRUPT_LOCAL_PROCESS",
      signalSent: true
    });
    await expect(completion).rejects.toBeInstanceOf(AntigravityCliAdapterError);
    expect(requests).toHaveLength(1);

    await session.close();
  });

  it("keeps simultaneous sessions stateless and context-separated", async () => {
    const prompts: string[] = [];
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async (request) => {
        prompts.push(request.stdin);
        request.onProcessStart();
        return executionResult(antigravityStream());
      })
    );
    const first = await provider.createSession();
    const second = await provider.createSession();

    await Promise.all([
      collectProposals(first.sendTurn(turnInput({ session: "alpha" }))),
      collectProposals(second.sendTurn(turnInput({ session: "beta" })))
    ]);

    expect(prompts).toHaveLength(2);
    const contents = prompts.map((prompt) => {
      const message = JSON.parse(prompt.trim()) as {
        readonly message?: { readonly content?: unknown };
      };
      return message.message?.content;
    });
    expect(contents.some(
      (content) => typeof content === "string" && content.includes('"session":"alpha"')
    )).toBe(true);
    expect(contents.some(
      (content) => typeof content === "string" && content.includes('"session":"beta"')
    )).toBe(true);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("--continue");
    }

    await Promise.all([first.close(), second.close()]);
  });

  it("omits explicit undefined optionals using Context Compiler JSON semantics", async () => {
    let captured: SupervisedCliExecutionRequest | undefined;
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async (request) => {
        captured = request;
        request.onProcessStart();
        return executionResult(antigravityStream());
      })
    );
    const session = await provider.createSession();

    await expect(collectProposals(session.sendTurn(turnInput({
      required: "kept",
      target: undefined,
      nested: {
        allowedDisclosureIds: undefined,
        maximumDisclosure: 0
      }
    })))).resolves.toEqual([PROPOSAL]);

    const stdinMessage = JSON.parse((captured?.stdin ?? "").trim()) as {
      readonly message?: { readonly content?: unknown };
    };
    const content = stdinMessage.message?.content;
    expect(typeof content).toBe("string");
    if (typeof content !== "string") throw new Error("Expected string prompt content");
    const contextMarker = "APPLICATION_SELECTED_CONTEXT_JSON\n";
    const contextIndex = content.indexOf(contextMarker);
    expect(contextIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(content.slice(contextIndex + contextMarker.length))).toEqual({
      required: "kept",
      nested: {
        maximumDisclosure: 0
      }
    });

    await session.close();
  });

  it("rejects accessor, toJSON, cyclic, sparse, and non-finite context without invoking user code", async () => {
    let calls = 0;
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => {
        calls += 1;
        return executionResult(antigravityStream());
      })
    );
    const session = await provider.createSession();

    let proxyTrapCalls = 0;
    const proxyContext = new Proxy({}, {
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("must-not-run");
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("must-not-run");
      }
    });
    await expect(collectProposals(session.sendTurn(turnInput(proxyContext))))
      .rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(proxyTrapCalls).toBe(0);

    let getterCalls = 0;
    const accessorContext = Object.defineProperty({}, "hidden", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      }
    });
    await expect(collectProposals(session.sendTurn(turnInput(accessorContext))))
      .rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(getterCalls).toBe(0);

    let toJsonCalls = 0;
    const toJsonContext = {
      safe: true,
      toJSON() {
        toJsonCalls += 1;
        return { changed: true };
      }
    };
    await expect(collectProposals(session.sendTurn(turnInput(toJsonContext))))
      .rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(toJsonCalls).toBe(0);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(collectProposals(session.sendTurn(turnInput(cyclic))))
      .rejects.toMatchObject({ code: "INVALID_CONTEXT" });

    const sparse = new Array<unknown>(2);
    sparse[0] = "present";
    await expect(collectProposals(session.sendTurn(turnInput(sparse))))
      .rejects.toMatchObject({ code: "INVALID_CONTEXT" });

    await expect(collectProposals(session.sendTurn(turnInput({ value: Number.NaN }))))
      .rejects.toMatchObject({ code: "INVALID_CONTEXT" });

    expect(calls).toBe(0);
    await session.close();
  });

  it("accepts a substantial context below the conservative headless reliability margin", async () => {
    let calls = 0;
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async (request) => {
        calls += 1;
        request.onProcessStart();
        return executionResult(antigravityStream(PROPOSAL));
      })
    );
    const session = await provider.createSession();

    await expect(collectProposals(session.sendTurn(turnInput({
      substantial: "x".repeat(28 * 1024)
    })))).resolves.toEqual([PROPOSAL]);
    expect(calls).toBe(1);
    await session.close();
  });

  it("rejects escape-heavy context when the actual stream-json stdin exceeds its wire budget", async () => {
    let calls = 0;
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => {
        calls += 1;
        return executionResult(antigravityStream());
      })
    );
    const session = await provider.createSession();

    await expect(collectProposals(session.sendTurn(turnInput({
      escapeHeavy: "\"".repeat(16 * 1024)
    })))).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(calls).toBe(0);
    await session.close();
  });

  it("rejects context beyond the conservative headless JSON reliability budget before launching the CLI", async () => {
    let calls = 0;
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => {
        calls += 1;
        return executionResult(antigravityStream());
      })
    );
    const session = await provider.createSession();

    await expect(collectProposals(session.sendTurn(turnInput({
      oversized: "x".repeat(40 * 1024)
    })))).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(calls).toBe(0);
    await session.close();
  });
});
