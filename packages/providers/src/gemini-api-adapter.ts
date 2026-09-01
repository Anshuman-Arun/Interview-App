import {
  InterviewerProposalSchema,
  redactSecrets,
  type GenerationId,
  type InterviewerProposal,
  type ModelCapabilities,
  type ReasoningProvider,
  type ReasoningSession,
  type ReasoningTurnInput
} from "../../domain/src/index.js";

export interface GeminiApiAdapterOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly billingVerificationFactory?: (now: Date) => unknown;
  readonly dataUse?: "LOCAL_ONLY" | "REMOTE_NO_TRAINING" | "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT";
  readonly name?: string;
  readonly adapterVersion?: string;
}

/**
 * GeminiApiAdapter implements ReasoningProvider for Google's Gemini models.
 *
 * NOTE: Remote Gemini API keys inherit Google Cloud project billing configurations
 * and do not offer technical guarantees against metered spend purely from key strings.
 * Therefore, under no-metered policy (`allowMeteredUsage: false`), this adapter
 * fails closed by default unless an explicit technical billing verification proof factory
 * is configured. It is treated as an experimental provider.
 */
export class GeminiApiAdapter implements ReasoningProvider {
  readonly #options: GeminiApiAdapterOptions;
  public readonly name: string;
  public readonly adapterVersion: string;
  public readonly capabilities: ModelCapabilities;

  public constructor(options: GeminiApiAdapterOptions = {}) {
    this.#options = options;
    this.name = options.name ?? "gemini-api";
    this.adapterVersion = options.adapterVersion ?? "1.0.0";
    this.capabilities = {
      inputModalities: new Set(["text"]),
      textStreaming: false,
      structuredOutput: "FINAL_ONLY",
      persistentSession: false,
      resumableSession: false,
      cancellation: "CLOSE_CLIENT_STREAM",
      sessionSurvivesClientAbort: false,
      sessionSurvivesProviderCancel: false,
      usageReporting: false,
      dataUse: options.dataUse ?? "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT"
    };
  }

  public async verifyBillingSafety(input: { readonly now: Date }): Promise<unknown> {
    if (this.#options.billingVerificationFactory !== undefined) {
      return this.#options.billingVerificationFactory(input.now);
    }

    // By default, Google AI Studio / Gemini API keys cannot prove impossibility of spend
    // without an active project-level sandbox/quota contract. Fail closed.
    return {
      billingClass: "UNKNOWN" as const,
      enforcementMechanism: "Unverified remote API key; automatic Google project billing verification is not implemented",
      verifiedAt: input.now.toISOString(),
      adapterVersion: this.adapterVersion,
      spendImpossible: false
    };
  }

  public async createSession(): Promise<ReasoningSession> {
    const controllers = new Map<GenerationId, AbortController>();
    let closed = false;
    const options = this.#options;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const apiKey = options.apiKey ?? "";
    const model = options.model ?? "gemini-2.5-flash";
    const baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/u, "");

    return {
      async *sendTurn(input: ReasoningTurnInput): AsyncIterable<InterviewerProposal> {
        if (closed) return;

        const controller = new AbortController();
        controllers.set(input.generationId, controller);

        try {
          const prompt = formatPrompt(input.context);
          const requestUrl = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
          const requestBody = {
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }]
              }
            ],
            generationConfig: {
              responseMimeType: "application/json"
            }
          };

          let response: Response;
          try {
            response = await fetchImpl(requestUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(apiKey.length > 0 ? { "x-goog-api-key": apiKey } : {})
              },
              credentials: "omit",
              signal: controller.signal,
              body: JSON.stringify(requestBody)
            });
          } catch (error) {
            if (controller.signal.aborted) return;
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Gemini API network error: ${redactSecrets(message)}`);
          }

          if (!response.ok) {
            let errorText = "";
            try {
              errorText = await response.text();
            } catch {
              // ignore body read error
            }
            const sanitized = redactSecrets(`HTTP ${String(response.status)} ${response.statusText}: ${errorText}`);
            throw new Error(`Gemini API request failed: ${sanitized}`);
          }

          let responseJson: unknown;
          try {
            responseJson = await response.json();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to parse Gemini response as JSON: ${redactSecrets(message)}`);
          }

          const proposalCandidate = extractProposalJson(responseJson);
          const parsed = InterviewerProposalSchema.safeParse(proposalCandidate);
          if (!parsed.success) {
            throw new Error(`Invalid interviewer proposal from Gemini: ${parsed.error.message}`);
          }

          if (!controller.signal.aborted) {
            yield parsed.data;
          }
        } finally {
          controllers.delete(input.generationId);
        }
      },

      async cancelTurn(generationId: GenerationId) {
        const controller = controllers.get(generationId);
        if (controller !== undefined) {
          controller.abort();
          controllers.delete(generationId);
        }
        return { semantics: "CLOSE_CLIENT_STREAM" as const, streamClosed: true };
      },

      async close() {
        if (closed) return;
        closed = true;
        for (const controller of controllers.values()) {
          controller.abort();
        }
        controllers.clear();
      }
    };
  }
}

const CANONICAL_SOCRATIC_ACTIONS = [
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

function formatPrompt(context: unknown): string {
  if (typeof context === "object" && context !== null) {
    const record = context as Record<string, unknown>;
    const sections: string[] = [
      "You are an Oxford-style mathematical interview tutor realizing an application-selected Socratic action.",
      "Your role is to guide the student toward rigorous mathematical reasoning using Socratic questions with the minimum necessary disclosure.",
      "The application owns all pedagogical policy and disclosure authorization. You are realizing the requested action.",
      "Respond strictly with a single JSON object conforming to the InterviewerProposal schema."
    ];

    if (typeof record["problemPrompt"] === "string") {
      sections.push(`\nProblem Statement:\n${record["problemPrompt"]}`);
    }
    if (typeof record["recentStudentWork"] === "string") {
      sections.push(`\nRecent Student Work:\n${record["recentStudentWork"]}`);
    }
    if (record["realizationRequest"] !== undefined) {
      sections.push(`\nApplication Realization Request:\n${JSON.stringify(record["realizationRequest"], null, 2)}`);
    }
    if (Array.isArray(record["deliveredFacts"])) {
      sections.push(`\nDelivered Disclosures:\n${record["deliveredFacts"].join(", ")}`);
    }
    if (Array.isArray(record["forbiddenDisclosureIds"])) {
      sections.push(`\nProtected/Forbidden Disclosures:\n${record["forbiddenDisclosureIds"].join(", ")}`);
    }

    sections.push(
      "\nExpected Output Schema (InterviewerProposal):",
      JSON.stringify(
        {
          realizedAction: CANONICAL_SOCRATIC_ACTIONS.join(" | "),
          claimedDisclosureLevel: "0 | 1 | 2 | 3 | 4 | 5",
          claimedDisclosureIds: ["<string>"],
          speechText: "<string>",
          boardActions: []
        },
        null,
        2
      ),
      "\nNote: claimedDisclosureLevel (0-5) and claimedDisclosureIds are untrusted model metadata and will be independently validated against the application disclosure boundary."
    );

    return sections.join("\n");
  }

  return `Context:\n${JSON.stringify(context, null, 2)}\n\nPlease respond with an InterviewerProposal JSON object.`;
}

function extractProposalJson(responseJson: unknown): unknown {
  if (typeof responseJson === "object" && responseJson !== null) {
    const record = responseJson as Record<string, unknown>;
    const candidates = record["candidates"];
    if (Array.isArray(candidates) && candidates.length > 0) {
      const firstCandidate = candidates[0] as Record<string, unknown> | undefined;
      const content = firstCandidate?.["content"] as Record<string, unknown> | undefined;
      const parts = content?.["parts"];
      if (Array.isArray(parts) && parts.length > 0) {
        const firstPart = parts[0] as Record<string, unknown> | undefined;
        const text = firstPart?.["text"];
        if (typeof text === "string") {
          try {
            return JSON.parse(text);
          } catch {
            const trimmed = text.trim();
            const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
            if (fenceMatch?.[1] !== undefined) {
              return JSON.parse(fenceMatch[1]);
            }
            throw new Error(`Failed to parse Gemini candidate text as JSON: ${text.slice(0, 100)}`);
          }
        }
      }
    }
    if ("realizedAction" in record && "claimedDisclosureLevel" in record) {
      return record;
    }
  }
  return responseJson;
}
