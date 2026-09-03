import { describe, expect, it } from "vitest";
import {
  DisclosureIdSchema,
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
  AntigravityCliAdapterError,
  SupervisedCliReasoningProvider,
  assertProviderPermitted,
  createAntigravityCliReasoningProvider,
  registerBuiltInProviders,
  resolveAdapterFactory,
  resolveProviderConfiguration,
  type SupervisedCliExecutionRequest,
  type SupervisedCliExecutionResult,
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
        permission_mode: "request-review",
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

  it("does not claim that subscription CLI invocation makes incremental spend impossible", async () => {
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
  it("rejects nested accessor and Proxy capabilities without invoking user code", () => {
    let getterCalls = 0;
    const accessorCapabilities = Object.defineProperty({
      ...ANTIGRAVITY_CLI_PROVIDER_DEFINITION.capabilities
    }, "textStreaming", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return false;
      }
    });

    expect(() => new SupervisedCliReasoningProvider({
      ...ANTIGRAVITY_CLI_PROVIDER_DEFINITION,
      capabilities: accessorCapabilities as typeof ANTIGRAVITY_CLI_PROVIDER_DEFINITION.capabilities
    })).toThrow("Supervised CLI provider definition is invalid");
    expect(getterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxyCapabilities = new Proxy(
      ANTIGRAVITY_CLI_PROVIDER_DEFINITION.capabilities,
      {
        getOwnPropertyDescriptor() {
          proxyTrapCalls += 1;
          throw new Error("must-not-run");
        }
      }
    );
    expect(() => new SupervisedCliReasoningProvider({
      ...ANTIGRAVITY_CLI_PROVIDER_DEFINITION,
      capabilities: proxyCapabilities
    })).toThrow("Supervised CLI provider definition is invalid");
    expect(proxyTrapCalls).toBe(0);
  });

  it("captures definition callbacks so later mutation cannot change execution", async () => {
    let originalBillingCalls = 0;
    const mutableDefinition = {
      ...ANTIGRAVITY_CLI_PROVIDER_DEFINITION,
      verifyBillingSafety: async (input: { readonly now: Date }) => {
        originalBillingCalls += 1;
        return {
          providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
          adapterVersion: ANTIGRAVITY_CLI_ADAPTER_VERSION,
          billingClass: "UNKNOWN",
          spendImpossible: false,
          checkedAt: input.now.toISOString(),
          accountFingerprint: "mutation-test",
          verificationSource: "PROVIDER_ADAPTER",
          dataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT",
          enforcementMechanism: "test"
        };
      }
    };
    const provider = new SupervisedCliReasoningProvider(mutableDefinition);
    Reflect.set(mutableDefinition, "verifyBillingSafety", async () => {
      throw new Error("mutated callback must not run");
    });

    await expect(provider.verifyBillingSafety({
      now: new Date("2026-09-02T00:00:00.000Z")
    })).resolves.toMatchObject({
      accountFingerprint: "mutation-test"
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
    expect(request?.args).toContain("--sandbox");
    expect(request?.args).toContain(ANTIGRAVITY_CLI_MODEL_ID);
    expect(request?.args).toContain("--agent");
    expect(request?.args).toContain(ANTIGRAVITY_CLI_AGENT_ID);
    expect(request?.args).not.toContain("--continue");
    expect(request?.args).not.toContain("--conversation");
    expect(request?.args).not.toContain("--dangerously-skip-permissions");

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
        '"permission_mode":"request-review"',
        '"permission_mode":"always-proceed"'
      ),
      antigravityStream().replace(
        '"permission_mode":"request-review"',
        '"permission_mode":"always-proceed","permission_mode":"request-review"'
      ),
      antigravityStream().replace(
        '"permission_mode":"request-review"',
        '"permissi\\u006fn_mode":"always-proceed","permission_mode":"request-review"'
      ),
      antigravityStream().replace(
        '"permission_mode":"request-review"',
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
          { length: 257 },
          (_, index) => DisclosureIdSchema.parse(
            `disclosure-${String(index)}`
          )
        )
      }),
      antigravityStream({
        ...PROPOSAL,
        speechText: undefined,
        boardActions: [{
          operation: "write_text",
          layer: "AI_ANNOTATION",
          content: "x".repeat(8_001),
          annotationPurpose: "bounded annotation"
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

  it("rejects an oversized turn context before launching the CLI", async () => {
    let calls = 0;
    const provider = createAntigravityCliReasoningProvider(
      fakeExecutor(async () => {
        calls += 1;
        return executionResult(antigravityStream());
      })
    );
    const session = await provider.createSession();

    await expect(collectProposals(session.sendTurn(turnInput({
      oversized: "x".repeat(128 * 1024)
    })))).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(calls).toBe(0);
    await session.close();
  });
});
