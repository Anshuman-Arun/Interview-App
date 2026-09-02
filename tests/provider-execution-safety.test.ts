import { describe, expect, it } from "vitest";
import {
  newGenerationId,
  type InterviewerProposal,
  type ModelCapabilities,
  type ProviderCancellationResult,
  type ReasoningProvider,
  type ReasoningSession
} from "../packages/domain/src/index.js";
import {
  MockModelAdapter,
  ProviderExecutionError,
  openProviderExecutionSession,
  snapshotReasoningProviderName
} from "../packages/providers/src/index.js";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const NO_METERED_POLICY = {
  allowMeteredUsage: false,
  maximumDataUse: "LOCAL_ONLY" as const,
  billingVerificationMaxAgeMs: 1_000
};
const METERED_POLICY = { ...NO_METERED_POLICY, allowMeteredUsage: true };
const PROPOSAL: InterviewerProposal = {
  realizedAction: "WAIT",
  claimedDisclosureLevel: 0,
  claimedDisclosureIds: [],
  speechText: "Please continue."
};
const CAPABILITIES: ModelCapabilities = {
  inputModalities: new Set(["text"]),
  textStreaming: false,
  structuredOutput: "FINAL_ONLY",
  persistentSession: false,
  resumableSession: false,
  cancellation: "NONE",
  sessionSurvivesClientAbort: false,
  sessionSurvivesProviderCancel: false,
  usageReporting: false,
  dataUse: "LOCAL_ONLY"
};

describe("provider execution admission", () => {
  it("obtains current provider-specific billing proof before creating a no-metered session", async () => {
    let verificationCalls = 0;
    let sessionCreations = 0;
    const provider = testProvider({
      verifyBillingSafety: async ({ now }) => {
        verificationCalls += 1;
        return validVerification(now);
      },
      createSession: async () => {
        sessionCreations += 1;
        return proposalSession();
      }
    });

    const session = await openProviderExecutionSession({ provider, policy: NO_METERED_POLICY, now: NOW });
    expect(verificationCalls).toBe(1);
    expect(sessionCreations).toBe(1);
    expect(await collect(session.sendTurn({ context: {}, generationId: newGenerationId() }))).toEqual([PROPOSAL]);
    await session.close();
  });

  it("never creates a session when billing proof is missing, stale, or throws", async () => {
    let sessionCreations = 0;
    const createSession = async () => {
      sessionCreations += 1;
      return proposalSession();
    };
    const missingVerifier = {
      name: "missing-verifier",
      adapterVersion: "test@1",
      capabilities: CAPABILITIES,
      createSession
    } as unknown as ReasoningProvider;
    await expect(openProviderExecutionSession({ provider: missingVerifier, policy: NO_METERED_POLICY, now: NOW }))
      .rejects.toMatchObject({ code: "MISSING_BILLING_VERIFIER" });

    const stale = testProvider({
      verifyBillingSafety: async () => validVerification(new Date(NOW.getTime() - 1_001)),
      createSession
    });
    await expect(openProviderExecutionSession({ provider: stale, policy: NO_METERED_POLICY, now: NOW }))
      .rejects.toMatchObject({ code: "VERIFICATION_STALE" });

    const secret = "provider-secret-must-not-escape";
    const throwing = testProvider({
      verifyBillingSafety: async () => { throw new Error(secret); },
      createSession
    });
    let caught: unknown;
    try {
      await openProviderExecutionSession({ provider: throwing, policy: NO_METERED_POLICY, now: NOW });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderExecutionError);
    expect(caught).toMatchObject({ code: "BILLING_VERIFICATION_FAILED" });
    expect(String(caught)).not.toContain(secret);
    expect(sessionCreations).toBe(0);
  });

  it("does not invoke billing verification when metered use is explicitly enabled", async () => {
    let verificationCalls = 0;
    const provider = testProvider({
      verifyBillingSafety: async () => {
        verificationCalls += 1;
        throw new Error("must not run");
      }
    });
    const session = await openProviderExecutionSession({ provider, policy: METERED_POLICY, now: NOW });
    expect(verificationCalls).toBe(0);
    await session.close();
  });

  it("rejects malformed runtime capabilities before billing verification or session creation", async () => {
    let verificationCalls = 0;
    let sessionCreations = 0;
    const provider = testProvider({
      capabilities: { ...CAPABILITIES, cancellation: "SERVER_SIDE_MAGIC" } as unknown as ModelCapabilities,
      verifyBillingSafety: async () => {
        verificationCalls += 1;
        return validVerification(NOW);
      },
      createSession: async () => {
        sessionCreations += 1;
        return proposalSession();
      }
    });
    await expect(openProviderExecutionSession({ provider, policy: NO_METERED_POLICY, now: NOW }))
      .rejects.toMatchObject({ code: "INVALID_PROVIDER_CAPABILITIES" });
    expect(verificationCalls).toBe(0);
    expect(sessionCreations).toBe(0);
  });

  it("rejects policy, privacy, and clock failures before invoking any adapter method", async () => {
    let verificationCalls = 0;
    let sessionCreations = 0;
    const provider = testProvider({
      capabilities: { ...CAPABILITIES, dataUse: "REMOTE_NO_TRAINING" },
      verifyBillingSafety: async ({ now }) => {
        verificationCalls += 1;
        return validVerification(now);
      },
      createSession: async () => {
        sessionCreations += 1;
        return proposalSession();
      }
    });

    await expect(openProviderExecutionSession({ provider, policy: NO_METERED_POLICY, now: NOW }))
      .rejects.toMatchObject({ code: "DATA_USE_EXCEEDS_POLICY" });
    await expect(openProviderExecutionSession({
      provider,
      policy: { ...NO_METERED_POLICY, maximumDataUse: "REMOTE_NO_TRAINING" },
      now: new Date(Number.NaN)
    })).rejects.toMatchObject({ code: "INVALID_CLOCK" });
    await expect(openProviderExecutionSession({ provider, policy: { allowMeteredUsage: false }, now: NOW }))
      .rejects.toMatchObject({ code: "INVALID_POLICY" });

    expect(verificationCalls).toBe(0);
    expect(sessionCreations).toBe(0);
  });


  it("captures provider operations before billing verification can swap execution behavior", async () => {
    let verificationEntered: (() => void) | undefined;
    let releaseVerification: (() => void) | undefined;
    let originalSessionCreations = 0;
    let replacementSessionCreations = 0;
    const entered = new Promise<void>((resolve) => {
      verificationEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const provider = testProvider({
      async verifyBillingSafety({ now }) {
        verificationEntered?.();
        await blocked;
        return validVerification(now);
      },
      async createSession() {
        originalSessionCreations += 1;
        return proposalSession();
      }
    });

    const opening = openProviderExecutionSession({
      provider,
      policy: NO_METERED_POLICY,
      now: NOW
    });
    await entered;
    Reflect.set(provider, "createSession", async () => {
      replacementSessionCreations += 1;
      throw new Error("replacement createSession must not execute");
    });
    releaseVerification?.();

    const session = await opening;
    expect(originalSessionCreations).toBe(1);
    expect(replacementSessionCreations).toBe(0);
    expect(await collect(session.sendTurn({
      context: {},
      generationId: newGenerationId()
    }))).toEqual([PROPOSAL]);
    await session.close();
  });

  it("keeps the parsed policy authoritative when caller policy mutates during billing verification", async () => {
    const mutablePolicy = {
      allowMeteredUsage: false,
      maximumDataUse: "LOCAL_ONLY" as const,
      billingVerificationMaxAgeMs: 1_000
    };
    const provider = testProvider({
      async verifyBillingSafety() {
        mutablePolicy.billingVerificationMaxAgeMs = 1_000_000;
        return validVerification(new Date(NOW.getTime() - 1_001));
      }
    });

    await expect(openProviderExecutionSession({
      provider,
      policy: mutablePolicy,
      now: NOW
    })).rejects.toMatchObject({ code: "VERIFICATION_STALE" });
  });

  it("does not lend the authoritative admission clock to provider billing code", async () => {
    const callerNow = new Date(NOW.getTime());
    const originalTime = callerNow.getTime();
    const provider = testProvider({
      async verifyBillingSafety({ now }) {
        now.setTime(originalTime - 10_000);
        return validVerification(now);
      }
    });

    await expect(openProviderExecutionSession({
      provider,
      policy: NO_METERED_POLICY,
      now: callerNow
    })).rejects.toMatchObject({ code: "VERIFICATION_STALE" });
    expect(callerNow.getTime()).toBe(originalTime);
  });

  it("returns an immutable capability snapshot that cannot change cancellation or modality semantics", async () => {
    const provider = testProvider({
      capabilities: {
        ...CAPABILITIES,
        reasoningLevels: ["low"]
      }
    });
    const session = await openProviderExecutionSession({
      provider,
      policy: NO_METERED_POLICY,
      now: NOW
    });

    expect(Reflect.set(session.capabilities, "cancellation", "CANCEL_PROVIDER_COMPUTE"))
      .toBe(false);
    expect(session.capabilities.cancellation).toBe("NONE");
    const modalities = session.capabilities.inputModalities;
    modalities.add("image");
    modalities.delete("text");
    Set.prototype.add.call(modalities, "image");
    expect([...modalities]).toEqual(["image"]);
    expect([...session.capabilities.inputModalities]).toEqual(["text"]);

    const levels = session.capabilities.reasoningLevels;
    levels?.push("high");
    expect(levels).toEqual(["low", "high"]);
    expect(session.capabilities.reasoningLevels).toEqual(["low"]);

    await session.close();
  });

  it("rejects accessor- and Proxy-backed provider names without invoking user code", () => {
    let getterCalls = 0;
    const accessorProvider = testProvider();
    Object.defineProperty(accessorProvider, "name", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      }
    });

    expect(() => snapshotReasoningProviderName(accessorProvider))
      .toThrow(ProviderExecutionError);
    expect(getterCalls).toBe(0);

    let proxyTrapCalls = 0;
    const proxyProvider = new Proxy(testProvider(), {
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("must-not-run");
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("must-not-run");
      }
    });
    expect(() => snapshotReasoningProviderName(proxyProvider))
      .toThrow(ProviderExecutionError);
    expect(proxyTrapCalls).toBe(0);

    const malformed = testProvider();
    Reflect.set(malformed, "name", " name with spaces ");
    expect(() => snapshotReasoningProviderName(malformed))
      .toThrow(ProviderExecutionError);
  });

  it("snapshots guarded turn input before async iteration begins", async () => {
    let observedGenerationId: unknown;
    let observedContext: unknown;
    const provider = testProvider({
      session: {
        sendTurn(input) {
          observedGenerationId = input.generationId;
          observedContext = input.context;
          return proposalStream(PROPOSAL);
        },
        async close() {}
      }
    });
    const session = await openProviderExecutionSession({
      provider,
      policy: LOCAL_POLICY
    });

    const generationId = newGenerationId();
    const mutable = {
      generationId,
      context: { marker: "original" }
    };
    const stream = session.sendTurn(mutable);
    mutable.context = { marker: "mutated" };

    await expect(collect(stream)).resolves.toEqual([PROPOSAL]);
    expect(observedGenerationId).toBe(generationId);
    expect(observedContext).toEqual({ marker: "original" });
    await session.close();
  });

  it("rejects accessor-backed provider operations without invoking them", async () => {
    let getterCalls = 0;
    const provider = testProvider();
    Object.defineProperty(provider, "createSession", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return async () => proposalSession();
      }
    });

    await expect(openProviderExecutionSession({
      provider,
      policy: NO_METERED_POLICY,
      now: NOW
    })).rejects.toMatchObject({ code: "SESSION_CREATION_FAILED" });
    expect(getterCalls).toBe(0);

    const verifierAccessor = testProvider();
    Object.defineProperty(verifierAccessor, "verifyBillingSafety", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return async ({ now }: { readonly now: Date }) => validVerification(now);
      }
    });
    await expect(openProviderExecutionSession({
      provider: verifierAccessor,
      policy: NO_METERED_POLICY,
      now: NOW
    })).rejects.toMatchObject({ code: "MISSING_BILLING_VERIFIER" });
    expect(getterCalls).toBe(0);

    const capabilityAccessor = testProvider();
    Object.defineProperty(capabilityAccessor, "capabilities", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return CAPABILITIES;
      }
    });
    await expect(openProviderExecutionSession({
      provider: capabilityAccessor,
      policy: NO_METERED_POLICY,
      now: NOW
    })).rejects.toMatchObject({ code: "INVALID_PROVIDER_CAPABILITIES" });
    expect(getterCalls).toBe(0);
  });

  it("rejects Proxy prototype chains without invoking prototype traps", async () => {
    let providerPrototypeTrapCalls = 0;
    const providerPrototype = new Proxy({}, {
      getOwnPropertyDescriptor() {
        providerPrototypeTrapCalls += 1;
        throw new Error("must-not-run");
      },
      getPrototypeOf() {
        providerPrototypeTrapCalls += 1;
        throw new Error("must-not-run");
      }
    });
    const provider = Object.create(providerPrototype) as ReasoningProvider;

    await expect(openProviderExecutionSession({
      provider,
      policy: NO_METERED_POLICY,
      now: NOW
    })).rejects.toMatchObject({ code: "INVALID_PROVIDER_IDENTITY" });
    expect(providerPrototypeTrapCalls).toBe(0);

    let sessionPrototypeTrapCalls = 0;
    const sessionPrototype = new Proxy({}, {
      getOwnPropertyDescriptor() {
        sessionPrototypeTrapCalls += 1;
        throw new Error("must-not-run");
      },
      getPrototypeOf() {
        sessionPrototypeTrapCalls += 1;
        throw new Error("must-not-run");
      }
    });
    const rawSession = Object.create(sessionPrototype) as ReasoningSession;

    await expect(openProviderExecutionSession({
      provider: testProvider({
        createSession: async () => rawSession
      }),
      policy: NO_METERED_POLICY,
      now: NOW
    })).rejects.toMatchObject({ code: "SESSION_CREATION_FAILED" });
    expect(sessionPrototypeTrapCalls).toBe(0);
  });

  it("rejects Proxy-backed providers and sessions without invoking traps", async () => {
    let providerTrapCalls = 0;
    const providerProxy = new Proxy(testProvider(), {
      getOwnPropertyDescriptor() {
        providerTrapCalls += 1;
        throw new Error("must-not-run");
      },
      getPrototypeOf() {
        providerTrapCalls += 1;
        throw new Error("must-not-run");
      }
    });
    await expect(openProviderExecutionSession({
      provider: providerProxy,
      policy: NO_METERED_POLICY,
      now: NOW
    })).rejects.toMatchObject({ code: "INVALID_PROVIDER_IDENTITY" });
    expect(providerTrapCalls).toBe(0);

    let sessionTrapCalls = 0;
    const sessionProxy = new Proxy(proposalSession(), {
      getOwnPropertyDescriptor() {
        sessionTrapCalls += 1;
        throw new Error("must-not-run");
      },
      getPrototypeOf() {
        sessionTrapCalls += 1;
        throw new Error("must-not-run");
      }
    });
    await expect(openProviderExecutionSession({
      provider: testProvider({
        createSession: async () => sessionProxy
      }),
      policy: NO_METERED_POLICY,
      now: NOW
    })).rejects.toMatchObject({ code: "SESSION_CREATION_FAILED" });
    expect(sessionTrapCalls).toBe(0);
  });

  it("drops a provider result released after cancellation even when the provider ignores cancellation", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const rawSession: ReasoningSession = {
      async *sendTurn() {
        await blocked;
        yield PROPOSAL;
      },
      async cancelTurn() { return { semantics: "NONE" }; },
      async close() {}
    };
    const provider = testProvider({ createSession: async () => rawSession });
    const session = await openProviderExecutionSession({ provider, policy: NO_METERED_POLICY, now: NOW });
    const generationId = newGenerationId();
    const iterator = session.sendTurn({ context: {}, generationId })[Symbol.asyncIterator]();
    const pending = iterator.next();
    const report = await session.cancelTurn(generationId);
    release?.();

    expect(report).toEqual({ generationId, outputDisposition: "DROP_OUTPUT", adapterResult: { semantics: "NONE" } });
    expect(await pending).toEqual({ value: undefined, done: true });
    await session.close();
  });

  it("keeps provider-switch cancellation isolated by GenerationId", async () => {
    const providerA = new MockModelAdapter({ proposal: PROPOSAL, cancellationBehavior: "IGNORE" });
    const providerB = new MockModelAdapter({ proposal: PROPOSAL });
    const sessionA = await openProviderExecutionSession({ provider: providerA, policy: NO_METERED_POLICY, now: NOW });
    const sessionB = await openProviderExecutionSession({ provider: providerB, policy: NO_METERED_POLICY, now: NOW });
    const oldGenerationId = newGenerationId();
    const replacementGenerationId = newGenerationId();
    await sessionA.cancelTurn(oldGenerationId);

    expect(await collect(sessionA.sendTurn({ context: {}, generationId: oldGenerationId }))).toEqual([]);
    expect(await collect(sessionB.sendTurn({ context: {}, generationId: replacementGenerationId }))).toEqual([PROPOSAL]);
    await sessionA.close();
    await sessionB.close();
  });

  it("rejects cancellation overclaims without permitting later output", async () => {
    const rawSession = proposalSession({ semantics: "CANCEL_PROVIDER_COMPUTE", providerConfirmed: true });
    const provider = testProvider({
      capabilities: { ...CAPABILITIES, cancellation: "CLOSE_CLIENT_STREAM" },
      createSession: async () => rawSession
    });
    const session = await openProviderExecutionSession({ provider, policy: NO_METERED_POLICY, now: NOW });
    const generationId = newGenerationId();
    await expect(session.cancelTurn(generationId)).rejects.toMatchObject({ code: "CANCELLATION_OVERCLAIMED" });
    expect(await collect(session.sendTurn({ context: {}, generationId }))).toEqual([]);
    await session.close();
  });

  it("captures reasoning-session operation identities once and rejects accessor-backed operations without invoking them", async () => {
    let replacementSendTurnCalls = 0;
    let replacementCloseCalls = 0;
    const rawSession: ReasoningSession = {
      async *sendTurn() {
        yield PROPOSAL;
      },
      async cancelTurn() {
        return { semantics: "NONE" };
      },
      async close() {}
    };
    const provider = testProvider({
      createSession: async () => rawSession
    });
    const session = await openProviderExecutionSession({
      provider,
      policy: NO_METERED_POLICY,
      now: NOW
    });

    Reflect.set(rawSession, "sendTurn", async function* () {
      replacementSendTurnCalls += 1;
      await Promise.reject(new Error("replacement sendTurn must not execute"));
      yield PROPOSAL;
    });
    Reflect.set(rawSession, "close", async () => {
      replacementCloseCalls += 1;
      throw new Error("replacement close must not execute");
    });

    expect(await collect(session.sendTurn({
      context: {},
      generationId: newGenerationId()
    }))).toEqual([PROPOSAL]);
    await expect(session.close()).resolves.toBeUndefined();
    expect(replacementSendTurnCalls).toBe(0);
    expect(replacementCloseCalls).toBe(0);

    let getterCalls = 0;
    const accessorSessionCandidate: object = {
      async close() {}
    };
    Object.defineProperty(accessorSessionCandidate, "sendTurn", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return async function* () {
          yield PROPOSAL;
        };
      }
    });
    const accessorSession = accessorSessionCandidate as unknown as ReasoningSession;
    await expect(openProviderExecutionSession({
      provider: testProvider({ createSession: async () => accessorSession }),
      policy: NO_METERED_POLICY,
      now: NOW
    })).rejects.toMatchObject({ code: "SESSION_CREATION_FAILED" });
    expect(getterCalls).toBe(0);
  });

  it("rejects Proxy/accessor provider data before schema validation invokes traps", async () => {
    let proposalGetterCalls = 0;
    const accessorProposal = Object.defineProperty({
      realizedAction: "WAIT",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: []
    }, "speechText", {
      enumerable: true,
      get() {
        proposalGetterCalls += 1;
        return "must-not-run";
      }
    }) as unknown as InterviewerProposal;
    const proposalProvider = testProvider({
      createSession: async () => ({
        async *sendTurn() {
          yield accessorProposal;
        },
        async close() {}
      })
    });
    const proposalSessionGuard = await openProviderExecutionSession({
      provider: proposalProvider,
      policy: NO_METERED_POLICY,
      now: NOW
    });
    await expect(collect(proposalSessionGuard.sendTurn({
      context: {},
      generationId: newGenerationId()
    }))).rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    expect(proposalGetterCalls).toBe(0);
    await proposalSessionGuard.close();

    let cancellationTrapCalls = 0;
    const cancellationProxy = new Proxy({}, {
      ownKeys() {
        cancellationTrapCalls += 1;
        throw new Error("must-not-run");
      },
      getOwnPropertyDescriptor() {
        cancellationTrapCalls += 1;
        throw new Error("must-not-run");
      }
    }) as unknown as ProviderCancellationResult;
    const cancellationProvider = testProvider({
      createSession: async () => ({
        async *sendTurn() {
          yield PROPOSAL;
        },
        async cancelTurn() {
          return cancellationProxy;
        },
        async close() {}
      })
    });
    const cancellationSession = await openProviderExecutionSession({
      provider: cancellationProvider,
      policy: NO_METERED_POLICY,
      now: NOW
    });
    await expect(cancellationSession.cancelTurn(newGenerationId()))
      .rejects.toMatchObject({ code: "INVALID_CANCELLATION_RESULT" });
    expect(cancellationTrapCalls).toBe(0);
    await cancellationSession.close();
  });

  it("runtime-validates provider output and suppresses provider error secrets", async () => {
    const outputSecret = "malformed-output-secret";
    const outputProvider = testProvider({
      createSession: async () => ({
        async *sendTurn() { yield { speechText: outputSecret } as InterviewerProposal; },
        async close() {}
      })
    });
    const outputSession = await openProviderExecutionSession({ provider: outputProvider, policy: NO_METERED_POLICY, now: NOW });
    await expect(collect(outputSession.sendTurn({ context: {}, generationId: newGenerationId() })))
      .rejects.toMatchObject({ code: "INVALID_PROVIDER_OUTPUT" });
    await outputSession.close();

    const streamSecret = "provider-stream-secret";
    const streamProvider = testProvider({
      createSession: async () => ({
        async *sendTurn() { yield await Promise.reject<InterviewerProposal>(new Error(streamSecret)); },
        async close() {}
      })
    });
    const streamSession = await openProviderExecutionSession({ provider: streamProvider, policy: NO_METERED_POLICY, now: NOW });
    let caught: unknown;
    try {
      await collect(streamSession.sendTurn({ context: {}, generationId: newGenerationId() }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "PROVIDER_STREAM_FAILED" });
    expect(String(caught)).not.toContain(streamSecret);
    await streamSession.close();
  });
});

function testProvider(overrides: Partial<ReasoningProvider> = {}): ReasoningProvider {
  return {
    name: "test-provider",
    adapterVersion: "test@1",
    capabilities: CAPABILITIES,
    async verifyBillingSafety({ now }) { return validVerification(now); },
    async createSession() { return proposalSession(); },
    ...overrides
  };
}

function validVerification(now: Date) {
  return {
    billingClass: "VERIFIED_FREE_ONLY" as const,
    enforcementMechanism: "Test adapter has no network or spend path",
    verifiedAt: now.toISOString(),
    adapterVersion: "test@1",
    spendImpossible: true
  };
}

function proposalSession(cancellationResult: ProviderCancellationResult = { semantics: "NONE" }): ReasoningSession {
  return {
    async *sendTurn() { yield PROPOSAL; },
    async cancelTurn() { return cancellationResult; },
    async close() {}
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<readonly T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}
