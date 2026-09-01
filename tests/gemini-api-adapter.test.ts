import { describe, expect, it } from "vitest";
import {
  DisclosureIdSchema,
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

const NO_METERED_POLICY = {
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
  speechText: "What relations exist between vertex A and the other five people?"
};

const VALID_PROOF_FACTORY = (now: Date) => ({
  billingClass: "VERIFIED_FREE_ONLY" as const,
  enforcementMechanism: "Explicit isolated sandbox key with zero metered spend path",
  verifiedAt: now.toISOString(),
  adapterVersion: "1.0.0",
  spendImpossible: true
});

function createGeminiResponse(proposal: InterviewerProposal | string | Record<string, unknown>): string {
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
    const adapter = new GeminiApiAdapter({ apiKey: "test-key" });

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

describe("GeminiApiAdapter - Billing Safety & Fail-Closed Behavior", () => {
  it("fails closed by default with UNKNOWN billing class and spendImpossible: false", async () => {
    const adapter = new GeminiApiAdapter({ apiKey: "any-google-api-key" });
    const verification = (await adapter.verifyBillingSafety({ now: NOW })) as Record<string, unknown>;

    expect(verification).toEqual({
      billingClass: "UNKNOWN",
      enforcementMechanism: "Unverified remote API key; automatic Google project billing verification is not implemented",
      verifiedAt: NOW.toISOString(),
      adapterVersion: "1.0.0",
      spendImpossible: false
    });
  });

  it("rejects default unverified adapter in no-metered mode without calling fetch", async () => {
    let fetchCalled = false;
    const fetchMock = () => {
      fetchCalled = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const adapter = new GeminiApiAdapter({
      apiKey: "unverified-key",
      fetchImpl: fetchMock
    });

    await expect(
      openProviderExecutionSession({
        provider: adapter,
        policy: NO_METERED_POLICY,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: "SPEND_NOT_PROVEN_IMPOSSIBLE"
    });

    expect(fetchCalled).toBe(false);
  });

  it("rejects stale verification proof (fail-closed)", async () => {
    const staleTime = new Date(NOW.getTime() - 100_000);
    const staleProof = () => ({
      billingClass: "VERIFIED_FREE_ONLY" as const,
      enforcementMechanism: "Expired sandbox quota",
      verifiedAt: staleTime.toISOString(),
      adapterVersion: "1.0.0",
      spendImpossible: true
    });

    const adapter = new GeminiApiAdapter({
      apiKey: "stale-key",
      billingVerificationFactory: staleProof
    });

    await expect(
      openProviderExecutionSession({
        provider: adapter,
        policy: NO_METERED_POLICY,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: "VERIFICATION_STALE"
    });
  });

  it("rejects malformed or forged verification proof", async () => {
    const forgedProof = () => ({
      billingClass: "VERIFIED_FREE_ONLY" as const,
      enforcementMechanism: "", // Empty mechanism is invalid
      verifiedAt: NOW.toISOString(),
      adapterVersion: "1.0.0",
      spendImpossible: true
    });

    const adapter = new GeminiApiAdapter({
      apiKey: "forged-key",
      billingVerificationFactory: forgedProof
    });

    await expect(
      openProviderExecutionSession({
        provider: adapter,
        policy: NO_METERED_POLICY,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: "INVALID_BILLING_VERIFICATION"
    });
  });

  it("admits verified adapter with explicit spend-impossibility proof in no-metered mode", async () => {
    const fetchMock = () =>
      Promise.resolve(
        new Response(createGeminiResponse(PROPOSAL), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "verified-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
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

  it("admits adapter when allowMeteredUsage is explicitly true", async () => {
    const fetchMock = () =>
      Promise.resolve(
        new Response(createGeminiResponse(PROPOSAL), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "metered-key",
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
      apiKey: "any-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
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
});

describe("GeminiApiAdapter - Proposal Parsing & Socratic Action Support", () => {
  it("formats prompt declaring canonical Socratic actions and levels 0-5", async () => {
    let capturedBody = "";
    const fetchMock = (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        new Response(createGeminiResponse(PROPOSAL), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    };

    const adapter = new GeminiApiAdapter({
      apiKey: "secret-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
      now: NOW
    });

    const compiledContext = {
      problemPrompt: "Prove that in any 2-coloring of K6, there exists a monochromatic triangle.",
      recentStudentWork: "Consider vertex A with 5 incident edges.",
      realizationRequest: {
        requiredAction: "PROBE_JUSTIFICATION",
        maximumDisclosure: 2
      },
      deliveredFacts: ["pigeonhole_applied"],
      forbiddenDisclosureIds: ["full_triangle_construction"]
    };

    const results: InterviewerProposal[] = [];
    for await (const p of session.sendTurn({ context: compiledContext, generationId: newGenerationId() })) {
      results.push(p);
    }

    expect(results).toEqual([PROPOSAL]);
    expect(capturedBody).toContain("PROBE_JUSTIFICATION");
    expect(capturedBody).toContain("0 | 1 | 2 | 3 | 4 | 5");
    expect(capturedBody).toContain("untrusted model metadata");
    await session.close();
  });

  it("parses high disclosure levels (level 4 and 5)", async () => {
    const level4Proposal: InterviewerProposal = {
      realizedAction: "EXPLICIT_HINT",
      claimedDisclosureLevel: 4,
      claimedDisclosureIds: [DisclosureIdSchema.parse("hint_step_4")],
      speechText: "Notice that triangle ABC is monochromatic."
    };

    const fetchMock = () =>
      Promise.resolve(
        new Response(createGeminiResponse(level4Proposal), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "test-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
      now: NOW
    });

    const results: InterviewerProposal[] = [];
    for await (const p of session.sendTurn({ context: {}, generationId: newGenerationId() })) {
      results.push(p);
    }

    expect(results).toEqual([level4Proposal]);
    await session.close();
  });

  it("rejects invalid disclosure levels (e.g. 6 or negative)", async () => {
    const invalidProposal = {
      realizedAction: "PROBE_JUSTIFICATION",
      claimedDisclosureLevel: 6,
      speechText: "Invalid level"
    };

    const fetchMock = () =>
      Promise.resolve(
        new Response(createGeminiResponse(invalidProposal), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "test-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
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

  it("rejects invalid Socratic actions", async () => {
    const invalidActionProposal = {
      realizedAction: "INVALID_UNKNOWN_ACTION",
      claimedDisclosureLevel: 0,
      speechText: "Invalid action"
    };

    const fetchMock = () =>
      Promise.resolve(
        new Response(createGeminiResponse(invalidActionProposal), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "test-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
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

  it("parses markdown-fenced JSON responses containing proposals", async () => {
    const validProposal: InterviewerProposal = {
      realizedAction: "PROBE_JUSTIFICATION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      speechText: "Why must that claim hold?"
    };

    const fencedJson = `\`\`\`json\n${JSON.stringify(validProposal, null, 2)}\n\`\`\``;
    const fetchMock = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: fencedJson }],
                  role: "model"
                },
                finishReason: "STOP"
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "test-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
      now: NOW
    });

    const results: InterviewerProposal[] = [];
    for await (const p of session.sendTurn({ context: {}, generationId: newGenerationId() })) {
      results.push(p);
    }

    expect(results).toEqual([validProposal]);
    await session.close();
  });

  it("parses direct raw JSON proposals without markdown fences", async () => {
    const directProposal: InterviewerProposal = {
      realizedAction: "PROBE_JUSTIFICATION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      speechText: "Can you formalize the first step?"
    };

    const fetchMock = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(directProposal) }],
                  role: "model"
                },
                finishReason: "STOP"
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "test-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
      now: NOW
    });

    const results: InterviewerProposal[] = [];
    for await (const p of session.sendTurn({ context: {}, generationId: newGenerationId() })) {
      results.push(p);
    }

    expect(results).toEqual([directProposal]);
    await session.close();
  });

  it("safely handles malformed non-JSON provider responses with ProviderExecutionError", async () => {
    const fetchMock = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "This is completely invalid raw text not conforming to JSON {{{" }],
                  role: "model"
                },
                finishReason: "STOP"
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "test-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
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

  it("rejects proposal responses that fail Zod schema validation", async () => {
    // Missing required field "realizedAction"
    const brokenSchemaProposal = {
      claimedDisclosureLevel: 0,
      speechText: "Missing realized action entirely"
    };

    const fetchMock = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(brokenSchemaProposal) }],
                  role: "model"
                },
                finishReason: "STOP"
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      );

    const adapter = new GeminiApiAdapter({
      apiKey: "test-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
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
  it("aborts fetch request via AbortController with CLOSE_CLIENT_STREAM semantics", async () => {
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

    const adapter = new GeminiApiAdapter({
      apiKey: "test-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
      now: NOW
    });

    const generationId = newGenerationId();
    const iterator = session.sendTurn({ context: {}, generationId })[Symbol.asyncIterator]();
    const pendingTurn = iterator.next();

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

    const adapter = new GeminiApiAdapter({
      apiKey: "test-key",
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
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
    const adapter = new GeminiApiAdapter({
      apiKey: "test-key",
      billingVerificationFactory: VALID_PROOF_FACTORY
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
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
              message: `API_KEY=${sensitiveKey} is invalid for authorization=Bearer secret-token`
            }
          }),
          {
            status: 401,
            statusText: "Unauthorized",
            headers: { "Content-Type": "application/json" }
          }
        )
      );

    const adapter = new GeminiApiAdapter({
      apiKey: sensitiveKey,
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
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

    const adapter = new GeminiApiAdapter({
      apiKey: sensitiveKey,
      billingVerificationFactory: VALID_PROOF_FACTORY,
      fetchImpl: fetchMock
    });

    const session = await openProviderExecutionSession({
      provider: adapter,
      policy: NO_METERED_POLICY,
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
      await turns.selectAction(turnId, sixPeopleProblem);

      const fetchMock = () =>
        Promise.resolve(
          new Response(createGeminiResponse(PROPOSAL), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
        );

      const adapter = new GeminiApiAdapter({
        apiKey: "test-gemini-key",
        billingVerificationFactory: VALID_PROOF_FACTORY,
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
        policy: NO_METERED_POLICY,
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
