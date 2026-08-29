import { describe, expect, it } from "vitest";
import { redactSecrets } from "../packages/domain/src/index.js";

describe("secret redaction hardening", () => {
  it("preserves the existing common secret behavior", () => {
    expect(redactSecrets("authorization=Bearer-abc api_key:xyz")).toBe(
      "authorization=[REDACTED] api_key=[REDACTED]"
    );
  });

  it.each([
    ["Authorization: Bearer abc123", "Authorization=[REDACTED]"],
    ["Authorization: Basic YWJjOmRlZg==", "Authorization=[REDACTED]"],
    ["HTTP_AUTHORIZATION=Bearer abc123", "HTTP_AUTHORIZATION=[REDACTED]"]
  ])("redacts authorization credentials: %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    ["api-key: abc", "api-key=[REDACTED]"],
    ["API_KEY=abc", "API_KEY=[REDACTED]"],
    ["providerApiKey=abc", "providerApiKey=[REDACTED]"],
    ["x-api-key=abc", "x-api-key=[REDACTED]"],
    ["accessToken=abc", "accessToken=[REDACTED]"],
    ["session_token=abc", "session_token=[REDACTED]"],
    ["INTERVIEW_CLIENT_TOKEN=abc", "INTERVIEW_CLIENT_TOKEN=[REDACTED]"],
    ["provider_secret=abc", "provider_secret=[REDACTED]"]
  ])("redacts credential-bearing assignment syntax: %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("preserves quote style around quoted values", () => {
    expect(redactSecrets('API_KEY="abc" token=\'def\'')).toBe(
      'API_KEY="[REDACTED]" token=\'[REDACTED]\''
    );
  });

  it("redacts JSON-like secret fields without destroying surrounding JSON", () => {
    const redacted = redactSecrets(
      '{"apiKey":"abc","clientToken":"def","status":"ok"}'
    );

    expect(JSON.parse(redacted)).toEqual({
      apiKey: "[REDACTED]",
      clientToken: "[REDACTED]",
      status: "ok"
    });
  });

  it("handles escaped characters inside a quoted secret value", () => {
    const redacted = redactSecrets(
      String.raw`{"apiKey":"abc\"def","status":"ok"}`
    );

    expect(JSON.parse(redacted)).toEqual({
      apiKey: "[REDACTED]",
      status: "ok"
    });
  });

  it("redacts query-style credentials without consuming later parameters", () => {
    expect(redactSecrets("?token=abc&mode=test&client_token=def")).toBe(
      "?token=[REDACTED]&mode=test&client_token=[REDACTED]"
    );
  });

  it("redacts several secrets independently on one diagnostic line", () => {
    expect(
      redactSecrets(
        "Authorization: Bearer abc api_key=def status=401 clientToken=ghi"
      )
    ).toBe(
      "Authorization=[REDACTED] api_key=[REDACTED] status=401 clientToken=[REDACTED]"
    );
  });

  it("redacts secrets independently across multiple lines", () => {
    expect(
      redactSecrets(
        "first=ok\nINTERVIEW_CLIENT_TOKEN=abc\nAuthorization: Basic ZGVm\nlast=ok"
      )
    ).toBe(
      "first=ok\nINTERVIEW_CLIENT_TOKEN=[REDACTED]\nAuthorization=[REDACTED]\nlast=ok"
    );
  });

  it.each([
    "token count = 500",
    "secret sharing theorem",
    "authorization failed",
    "api key rotation is disabled",
    "client token validation failed",
    "this sentence contains the word secret"
  ])("does not redact non-assignment prose: %s", (input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it("does not redact unrelated assignments merely because their values look random", () => {
    const input = "request_id=3ac90bbf9b244382 state=abc.def.ghi random=sk_like_but_not_labeled";
    expect(redactSecrets(input)).toBe(input);
  });

  it("is idempotent", () => {
    const input =
      'Authorization: Bearer abc {"apiKey":"def"} INTERVIEW_CLIENT_TOKEN=ghi';
    const once = redactSecrets(input);

    expect(redactSecrets(once)).toBe(once);
  });

  it("leaves already-redacted credentials stable", () => {
    expect(
      redactSecrets(
        'Authorization=[REDACTED] API_KEY="[REDACTED]" token=[REDACTED]'
      )
    ).toBe(
      'Authorization=[REDACTED] API_KEY="[REDACTED]" token=[REDACTED]'
    );
  });

  it("removes the original secret substrings while retaining diagnostic context", () => {
    const firstSecret = "alpha-private";
    const secondSecret = "beta-private";
    const thirdSecret = "gamma-private";
    const secrets = [firstSecret, secondSecret, thirdSecret];
    const redacted = redactSecrets(
      `status=failed Authorization: Bearer ${firstSecret} api_key=${secondSecret} clientToken=${thirdSecret} retry=false`
    );

    for (const secret of secrets) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("status=failed");
    expect(redacted).toContain("retry=false");
    expect(redacted.match(/\[REDACTED\]/gu)).toHaveLength(3);
  });

  it("handles Unicode diagnostic context deterministically", () => {
    const input = "状態=失敗 token=秘密値 reason=接続失敗";
    expect(redactSecrets(input)).toBe(
      "状態=失敗 token=[REDACTED] reason=接続失敗"
    );
  });

  it("handles a large diagnostic string without changing unrelated content", () => {
    const prefix = "ordinary diagnostic text ".repeat(5_000);
    const input = `${prefix}INTERVIEW_CLIENT_TOKEN=large-secret suffix=ok`;
    const redacted = redactSecrets(input);

    expect(redacted.startsWith(prefix)).toBe(true);
    expect(redacted).toContain("INTERVIEW_CLIENT_TOKEN=[REDACTED]");
    expect(redacted).toContain("suffix=ok");
    expect(redacted).not.toContain("large-secret");
  });

  it("never throws for arbitrary strings", () => {
    const samples = [
      "",
      " ",
      "\0",
      "::::",
      "token=",
      '{"token":}',
      "authorization:",
      "[]{}()",
      "🔐 token=秘密"
    ];

    for (const sample of samples) {
      expect(() => redactSecrets(sample)).not.toThrow();
    }
  });
});
