# Secret Redaction Boundary

## Purpose

Diagnostic text must not leak credentials. `redactSecrets(text)` is a deterministic log/error sanitization helper for recognizable credential-bearing syntax.

The current project does **not** assume an OpenAI API key. Normal OpenAI access is through a ChatGPT Plus subscription, and no paid per-token OpenAI API credential is part of this architecture.

The redactor remains generic because the application does have credential-like local/security material, including the authenticated loopback client token, and future permitted integrations may have their own credentials.

## Recognized syntax

The redactor targets explicit credential assignments rather than guessing from entropy.

Examples include:

```text
Authorization: Bearer <credential>
Authorization: Basic <credential>
HTTP_AUTHORIZATION=Bearer <credential>

api-key=<credential>
API_KEY=<credential>
providerApiKey=<credential>
x-api-key=<credential>

token=<credential>
session_token=<credential>
clientToken=<credential>
INTERVIEW_CLIENT_TOKEN=<credential>
accessToken=<credential>

secret=<credential>
provider_secret=<credential>
```

It also handles quoted JSON-like keys and values:

```json
{"apiKey":"<credential>","clientToken":"<credential>"}
```

and query/log fragments such as:

```text
?token=<credential>&mode=test
```

Quoted secret values retain their quote style. JSON containing recognized quoted secret fields therefore remains structurally useful after redaction.

## What is deliberately not detected

The helper does not classify arbitrary high-entropy or key-looking strings as secrets.

For example, these are not redacted merely from their appearance:

```text
request_id=3ac90bbf9b244382
state=abc.def.ghi
random=sk_like_but_not_labeled
```

Likewise, ordinary prose is left alone:

```text
token count = 500
secret sharing theorem
authorization failed
```

This avoids a heuristic security subsystem that unpredictably destroys diagnostics or treats mathematical/technical language as credentials.

## Replacement behavior

Unquoted credential assignments are normalized to:

```text
credentialName=[REDACTED]
```

Quoted values remain quoted:

```text
API_KEY="[REDACTED]"
```

Quoted JSON-like keys remain quoted:

```json
{"apiKey":"[REDACTED]"}
```

The operation is idempotent:

```text
redactSecrets(redactSecrets(text)) === redactSecrets(text)
```

Adjacent fields and query parameters are not intentionally consumed by a neighboring match.

## Security properties and limits

The implementation uses bounded credential-syntax regular expressions with no nested unbounded ambiguity or entropy scanning. Tests cover large diagnostic strings to guard against accidental pathological behavior.

This helper is defense in depth. It does not make it acceptable to intentionally send secrets into:

- event payloads;
- provider context;
- renderer state;
- persisted session state;
- application logs.

The primary architecture rule remains to keep credentials out of those surfaces in the first place.

The redactor is intended for diagnostic/error boundaries where unexpected text may still contain a recognizable credential assignment.

## Project-specific note

No OpenAI API key infrastructure is introduced by this slice. Examples and tests use generic provider labels and the application's local `INTERVIEW_CLIENT_TOKEN`.

Normal project operation remains constrained to avoid paid per-token API usage.
