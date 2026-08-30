import { describe, expect, it } from "vitest";
import {
  ModelCapabilitiesSchema,
  newGenerationId,
  newSessionId,
  type InterviewerProposal
} from "../packages/domain/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  ProviderCoordinator,
  SessionRuntimeRegistry,
  TurnCoordinator
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  GeminiApiAdapter,
  ProviderExecutionError,
  openProviderExecutionSession
} from "../packages/providers/src/index.js";

const NOW = new Date("2026-08-30T04:00:00.000Z");

const FREE_TIER_POLICY = {
  allowMeteredUsage: false,
  maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT" as const,
  billingVerificationMaxAgeMs: 5_000
};

const METERED_POLICY = {
  allowMeteredUsage: true,
  maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT" as const,
  billingVerificationMaxAgeMs: 5_000
};

const LOCAL_ONLY_POLICY = {
  allowMeteredUsage: false,
  maximumDataUse: "LOCAL_ONLY" as const,
  billingVerificationMaxAgeMs: 5_000
};

const PROPOSAL: InterviewerProposal = {
  realizedAction: "PROBE_JUSTIFICATION",
  claimedDisclosureLevel: 0,
  claimedDisclosureIds: [],
  speechText: "Why must at least three edges share the same color from vertex A?"
};

function createGeminiResponse(proposal: InterviewerProposal | string): string {
  const text = typeof proposal === "string" ? proposal : JSON.stringify(proposal);
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ text }]
        }
      }
    ]
  });
}

describe("GeminiApiAdapter - ModelCapabilities & Interface Compliance", () => {
  it("declares honest and schema-compliant ModelCapabilities", () => {
    const adapter = new GeminiApiAdapter({ apiKey: "test-free-key" });

    expect(adapter.name).toBe("gemini-api");
    expect(adapter.adapterVersion).toBe("1.0.0");

    const parseResult = ModelCapabilitiesSchema.safeParse(adapter.capabilities);
    expect(parseResult.success).toBe(true);

    expect(adapter.capabilities.inputModalities).toEqual(new Set(["text"]));
    expect(adapter.capabilities.textStreaming).toBe(false);
    expect(adapter.capabilities.structuredOutput).toBe("FINAL_ONLY");
    expect(adapter.capabilities.persistentSession).toBe(false);
    expect(adapter.capabilities.resumableSession).toBe(false);
    expect(adapter.capabilities.cancellation).toBe("CLOSE_CLIENT_STREAM");
    expect(adapter.capabilities.sessionSurvivesClientAbort).toBe(false);
    expect(adapter.capabilities.sessionSurvivesProviderCancel).toBe(false);
    expect(adapter.capabilities.usageReporting).toBe(false);
    expect(adapter.capabilities.dataUse).toBe("REMOTE_MAY_BE_USED_FOR_IMPROVEMENT");
  });

  it("supports configurable dataUse and version parameters", () => {
    const adapter = new GeminiApiAdapter({
      name: "custom-gemini",
      adapterVersion: "2.1.0",
      dataUse: "REMOTE_NO_TRAINING"
    });

    expect(adapter.name).toBe("custom-gemini");
    expect(adapter.adapterVersion).toBe("2.1.0");
    expect(adapter.capabilities.dataUse).toBe("REMOTE_NO_TRAINING");
  });
});

describe("GeminiApiAdapter - Billing Safety & Preflight Verification", () => {
  it("provides deterministic no-metered billing proof for free tier keys", async () => {
    const adapter = new GeminiApiAdapter({ apiKey: "free-ai-studio-key" });
    const verification = (await adapter.verifyBillingSafety({ now: NOW })) as Record<string, unknown>;

    expect(verification).toEqual({
      billingClass: "VERIFIED_FREE_ONLY",
      enforcementMechanism: "Google AI Studio Free Tier key with hard rate-limiting and zero metered spend path",
      verifiedAt: NOW.toISOString(),
      adapterVersion: "1.0.0",
      spendImpossible: true
    });
  });

  it("fails closed with metered billing class when isFreeTierKey is false", async () => {
    const adapter = new GeminiApiAdapter({
      apiKey: "paid-metered-key",
      isFreeTierKey: false
    });
    const verification = (await adapter.verifyBillingSafety({ now: NOW })) as Record<string, unknown>;

    expect(verification).toMatchObject({
      billingClass: "METERED",
      spendImpossible: false
    });
  });

  it("admits free tier adapter in no-metered policy mode", async () => {
    const fetchMock = () =>
      Promise.resolve(
        new Response(createGeminiResponse(PROPOSAL), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "ai-studio-free-key",
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    expect(session.providerName).toBe("gemini-api");
    expect(session.adapterVersion).toBe("1.0.0");
    expect(session.capabilities.cancellation).toBe("CLOSE_CLIENT_STREAM");

    const results: InterviewerProposal[] = [];
    for await (const proposal of session.sendTurn({
      context: { problemPrompt: "Ramsey R(3,3)" },
      generationId: newGenerationId()
    })) {
      results.push(proposal);
    }

    expect(results).toEqual([PROPOSAL]);
    await session.close();
  });

  it("rejects metered adapter in no-metered mode (fail-closed)", async () => {
    const adapter = new GeminiApiAdapter({
      apiKey: "metered-key",
      isFreeTierKey: false
    });

    await expect(
      openProviderExecutionSession({
        provider: adapter,
        policy: FREE_TIER_POLICY,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: "SPEND_NOT_PROVEN_IMPOSSIBLE"
    });
  });

  it("admits metered adapter when allowMeteredUsage is explicitly true", async () => {
    const fetchMock = () =>
      Promise.resolve(
        new Response(createGeminiResponse(PROPOSAL), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "metered-key",
      isFreeTierKey: false,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: METERED_POLICY,
      now: NOW
    });

    expect(session.providerName).toBe("gemini-api");
    await session.close();
  });

  it("rejects session when dataUse policy is exceeded (e.g. LOCAL_ONLY)", async () => {
    const adapter = new GeminiApiAdapter({
      apiKey: "free-key",
      dataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT"
    });

    await expect(
      openProviderExecutionSession({
        provider: adapter,
        policy: LOCAL_ONLY_POLICY,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: "DATA_USE_EXCEEDS_POLICY"
    });
  });

  it("supports custom billing proof factory", async () => {
    const customProof = (now: Date) => ({
      billingClass: "ACCOUNT_QUOTA" as const,
      enforcementMechanism: "Prepaid zero-overdraft sandbox quota",
      verifiedAt: now.toISOString(),
      adapterVersion: "1.0.0",
      spendImpossible: true
    });

    const adapter = new GeminiApiAdapter({
      apiKey: "quota-key",
      billingVerificationFactory: customProof
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    expect(session.providerName).toBe("gemini-api");
    await session.close();
  });
});

describe("GeminiApiAdapter - Prompt Formatting & Proposal Parsing", () => {
  it("formats CompiledContext into Gemini generateContent JSON request with credentials: omit", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const fetchMock = (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedInit = init;
      return Promise.resolve(
        new Response(createGeminiResponse(PROPOSAL), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    };

    const adapter = new GeminiApiAdapter({
      apiKey: "secret-gemini-key",
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    const compiledContext = {
      problemPrompt: "Prove that in any 2-coloring of K6, there exists a monochromatic triangle.",
      recentStudentWork: "Consider vertex A with 5 incident edges. By PHP, 3 must have color C.",
      realizationRequest: {
        targetAction: "PROBE_JUSTIFICATION",
        maxDisclosureLevel: 0
      },
      deliveredFacts: ["pigeonhole_applied"],
      forbiddenDisclosureIds: ["full_triangle_construction"]
    };

    const generationId = newGenerationId();
    const results: InterviewerProposal[] = [];
    for await (const p of session.sendTurn({ context: compiledContext, generationId })) {
      results.push(p);
    }

    expect(results).toEqual([PROPOSAL]);
    expect(capturedUrl).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.credentials).toBe("omit");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("secret-gemini-key");
    expect(headers["Content-Type"]).toBe("application/json");

    const bodyString = typeof capturedInit?.body === "string" ? capturedInit.body : "";
    const parsedBody = JSON.parse(bodyString) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    const promptText = parsedBody.contents[0]?.parts[0]?.text ?? "";
    expect(promptText).toContain("Prove that in any 2-coloring of K6");
    expect(promptText).toContain("Consider vertex A with 5 incident edges");
    expect(promptText).toContain("pigeonhole_applied");
    expect(promptText).toContain("full_triangle_construction");

    await session.close();
  });

  it("handles markdown code fences in Gemini JSON response", async () => {
    const fencedResponse = "```json\n" + JSON.stringify(PROPOSAL) + "\n```";
    const fetchMock = () =>
      Promise.resolve(
        new Response(createGeminiResponse(fencedResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({ apiKey: "test-key", fetchImpl: fetchMock });
    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    const results: InterviewerProposal[] = [];
    for await (const p of session.sendTurn({ context: {}, generationId: newGenerationId() })) {
      results.push(p);
    }

    expect(results).toEqual([PROPOSAL]);
    await session.close();
  });

  it("handles direct proposal JSON without candidate wrapper (mock proxy mode)", async () => {
    const fetchMock = () =>
      Promise.resolve(
        new Response(JSON.stringify(PROPOSAL), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({ apiKey: "test-key", fetchImpl: fetchMock });
    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    const results: InterviewerProposal[] = [];
    for await (const p of session.sendTurn({ context: {}, generationId: newGenerationId() })) {
      results.push(p);
    }

    expect(results).toEqual([PROPOSAL]);
    await session.close();
  });

  it("throws ProviderExecutionError when Gemini returns malformed or invalid proposal JSON", async () => {
    const fetchMock = () =>
      Promise.resolve(
        new Response(createGeminiResponse("{ invalid json proposal"), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({ apiKey: "test-key", fetchImpl: fetchMock });
    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of session.sendTurn({ context: {}, generationId: newGenerationId() })) {
        // iterate
      }
    }).rejects.toThrow(ProviderExecutionError);

    await session.close();
  });

  it("throws ProviderExecutionError when proposal schema validation fails", async () => {
    const invalidProposal = {
      realizedAction: "INVALID_ACTION_NAME",
      claimedDisclosureLevel: 99
    };
    const fetchMock = () =>
      Promise.resolve(
        new Response(createGeminiResponse(JSON.stringify(invalidProposal)), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({ apiKey: "test-key", fetchImpl: fetchMock });
    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of session.sendTurn({ context: {}, generationId: newGenerationId() })) {
        // iterate
      }
    }).rejects.toThrow(ProviderExecutionError);

    await session.close();
  });
});

describe("GeminiApiAdapter - Honest Cancellation & Lifecycle", () => {
  it("aborts fetch request via AbortController and returns honest CLOSE_CLIENT_STREAM semantics", async () => {
    let aborted = false;
    let signalRef: AbortSignal | undefined;

    const fetchMock = (_input: RequestInfo | URL, init?: RequestInit) => {
      signalRef = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signalRef?.addEventListener("abort", () => {
          aborted = true;
          const abortErr = new Error("This operation was aborted");
          abortErr.name = "AbortError";
          reject(abortErr);
        });
      });
    };

    const adapter = new GeminiApiAdapter({ apiKey: "test-key", fetchImpl: fetchMock });
    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    const generationId = newGenerationId();
    const iterator = session.sendTurn({ context: {}, generationId })[Symbol.asyncIterator]();
    const pendingTurn = iterator.next();

    // Trigger cancellation
    const cancelReport = await session.cancelTurn(generationId);

    expect(aborted).toBe(true);
    expect(signalRef?.aborted).toBe(true);
    expect(cancelReport).toEqual({
      generationId,
      outputDisposition: "DROP_OUTPUT",
      adapterResult: {
        semantics: "CLOSE_CLIENT_STREAM",
        streamClosed: true
      }
    });

    const turnResult = await pendingTurn;
    expect(turnResult.done).toBe(true);
    expect(turnResult.value).toBeUndefined();

    await session.close();
  });

  it("aborts all active turns on session.close()", async () => {
    let aborted1 = false;
    let aborted2 = false;

    const fetchMock = (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          if (!aborted1) {
            aborted1 = true;
          } else {
            aborted2 = true;
          }
          const abortErr = new Error("Aborted");
          abortErr.name = "AbortError";
          reject(abortErr);
        });
      });
    };

    const adapter = new GeminiApiAdapter({ apiKey: "test-key", fetchImpl: fetchMock });
    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    const gen1 = newGenerationId();
    const gen2 = newGenerationId();
    const iter1 = session.sendTurn({ context: {}, generationId: gen1 })[Symbol.asyncIterator]();
    const iter2 = session.sendTurn({ context: {}, generationId: gen2 })[Symbol.asyncIterator]();
    const p1 = iter1.next();
    const p2 = iter2.next();

    await session.close();

    expect(aborted1).toBe(true);
    expect(aborted2).toBe(true);
    expect(await p1).toEqual({ value: undefined, done: true });
    expect(await p2).toEqual({ value: undefined, done: true });
  });

  it("rejects operations after session is closed", async () => {
    const adapter = new GeminiApiAdapter({ apiKey: "test-key" });
    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    await session.close();

    await expect(session.cancelTurn(newGenerationId())).rejects.toMatchObject({
      code: "SESSION_CLOSED"
    });

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of session.sendTurn({ context: {}, generationId: newGenerationId() })) {
        // iterate
      }
    }).rejects.toMatchObject({
      code: "SESSION_CLOSED"
    });
  });
});

describe("GeminiApiAdapter - Secret Redaction & Error Sanitization", () => {
  it("redacts API keys and authorization secrets on HTTP error responses", async () => {
    const sensitiveKey = "AIzaSySecretApiKey123456";
    const fetchMock = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 401,
              message: `API_KEY=${sensitiveKey} is invalid or expired for authorization=Bearer secret-token`
            }
          }),
          {
            status: 401,
            statusText: "Unauthorized",
            headers: { "Content-Type": "application/json" }
          }
        )
      );

    const adapter = new GeminiApiAdapter({ apiKey: sensitiveKey, fetchImpl: fetchMock });
    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    let caughtError: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of session.sendTurn({ context: {}, generationId: newGenerationId() })) {
        // iterate
      }
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ProviderExecutionError);
    const errorStr = String(caughtError);
    expect(errorStr).not.toContain(sensitiveKey);
    expect(errorStr).not.toContain("secret-token");

    await session.close();
  });

  it("redacts network exception details containing secrets", async () => {
    const sensitiveKey = "SecretKey-Network-Fail-999";
    const fetchMock = () => {
      const netErr = new Error(`Connection failed to api_key: ${sensitiveKey} on remote gateway`);
      return Promise.reject(netErr);
    };

    const adapter = new GeminiApiAdapter({ apiKey: sensitiveKey, fetchImpl: fetchMock });
    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: FREE_TIER_POLICY,
      now: NOW
    });

    let caughtError: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of session.sendTurn({ context: {}, generationId: newGenerationId() })) {
        // iterate
      }
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ProviderExecutionError);
    const errorStr = String(caughtError);
    expect(errorStr).not.toContain(sensitiveKey);

    await session.close();
  });
});

describe("GeminiApiAdapter - Integration with ProviderCoordinator", () => {
  it("executes full context-to-proposal turn in ProviderCoordinator", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const { inputEpisodeId, turnId } = await turns.commitInput(
        "Let's choose vertex A. There are 5 edges coming out of A."
      );
      await turns.selectAction(turnId);

      const fetchMock = () =>
        Promise.resolve(
          new Response(createGeminiResponse(PROPOSAL), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
        );

      const adapter = new GeminiApiAdapter({
        apiKey: "test-gemini-free-key",
        fetchImpl: fetchMock
      });

      const validator = new DisclosureValidator(
        new ClosedWorldDisclosureAnalyzer([PROPOSAL.speechText ?? ""])
      );
      const coordinator = new ProviderCoordinator(writer);

      const execution = await coordinator.start({
        inputEpisodeId,
        turnId,
        provider: adapter,
        policy: FREE_TIER_POLICY,
        problem: sixPeopleProblem,
        validator,
        now: NOW
      });

      const outcome = await execution.completion;
      expect(outcome.status).toBe("ACCEPTED");
      if (outcome.status !== "ACCEPTED") throw new Error("Expected accepted proposal");

      expect(outcome.deliveryAtoms).toHaveLength(1);
      expect(writer.getState().generations[execution.generationId]).toMatchObject({
        provider: "gemini-api",
        status: "VALIDATED"
      });
    } finally {
      store.close();
    }
  });
});
