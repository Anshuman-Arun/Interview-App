# Browser Command Client

## Purpose

`apps/web/src/command-client.ts` is the typed browser-side transport client for the authenticated loopback command protocol.

It does not own interview state, session state, delivery state, or retry semantics. It constructs protocol commands, sends them to the local command endpoint, validates responses, and preserves enough request identity for higher-level code to recover safely from uncertain transport outcomes.

## Browser boundary

The client accepts only an HTTP loopback base origin:

```text
http://127.0.0.1:<port>
http://[::1]:<port>
```

It rejects:

- HTTPS/non-HTTP schemes;
- `localhost` or remote hostnames;
- URL credentials;
- paths;
- query strings;
- fragments.

The command path is fixed internally to:

```text
/v1/commands
```

The client does not manually set `Origin`. Browsers own the `Origin` header and the command server validates it against its exact allowlist.

## Authentication handling

The client token is stored in an ECMAScript private field and is used only in:

```text
x-interview-client-token
```

Requests explicitly use:

```text
credentials: omit
redirect: error
referrerPolicy: no-referrer
cache: no-store
mode: cors
```

This prevents the command transport from relying on ambient cookies and prevents an HTTP redirect from becoming an alternate command destination.

The token is never placed in:

- the command URL;
- command JSON;
- RequestId;
- returned error objects;
- raw response errors.

Ordinary object serialization of the client does not expose its private fields.

## Typed command methods

The client exposes typed methods for:

- `startSession`;
- `commitTypedInput`;
- `getSessionSummary`;
- `reconnectDelivery`;
- `acknowledgeDeliveryExposed`;
- `acknowledgeDeliveryCompleted`.

Commands are checked with the application-owned `ClientCommandSchema` before transmission.

Success responses are parsed against the exact response schema for the requested operation rather than against only the broad success union.

The client additionally checks correlation that schemas alone cannot establish:

- every success must return the same `RequestId`;
- session start/summary must return the requested `SessionId`;
- reconnect/acknowledgement must return the requested `DeliveryId`;
- acknowledgement phase must match the requested acknowledgement command.

## RequestId and retry behavior

A new logical call receives a new RequestId by default.

Callers may explicitly pass:

```ts
{ requestId }
```

This is important after an uncertain network result. If a request may have reached the server but the browser did not receive the response, the higher-level caller can retry the same logical command with the same RequestId and rely on the server's durable idempotency boundary.

The client does not automatically retry commands. Automatic retries would require policy about timing, aborts, UI state, and whether the original outcome is actually uncertain.

A transport error carries the RequestId but does not retain the raw fetch/body-read error or its message. Failure while consuming the response body remains transport uncertainty because the server may already have committed the command.

## Error classes

### BrowserCommandTransportError

Represents:

- `NETWORK`;
- `ABORTED`.

It carries the RequestId so a controller can decide whether a stable-ID retry is appropriate.

A signal that is already aborted fails before `fetch` is called.

### BrowserCommandProtocolError

Represents a strict, valid protocol-error response from the command server.

It exposes:

- HTTP status;
- protocol error code;
- RequestId.

It intentionally does not retain the server's free-form error message.

### BrowserCommandResponseError

Represents an invalid or inconsistent server response:

- non-JSON content type;
- malformed JSON;
- strict schema mismatch;
- wrong RequestId;
- wrong session/delivery/acknowledgement correlation.

It uses a fixed error message and does not retain malformed response content.

## Authority boundary

The browser client:

- creates no events;
- does not mutate SessionWriter state;
- does not infer command success from network transmission;
- does not mark deliveries exposed/completed locally on its own;
- does not retry automatically;
- does not persist authentication credentials.

Authoritative mutation remains entirely server-side after authentication and protocol validation.

## Current integration status

`apps/web/src/index.ts` exports the command client together with the renderer client and authenticated renderer-stream consumer. The command server's exact-Origin CORS boundary is covered by a dedicated real-loopback suite.

The repository does not yet contain the final Vite/browser build harness. This slice is validated through TypeScript, ESLint, Node's standards-compatible `fetch`/Web API implementation, and real loopback server integration tests. A later browser-build slice should verify the complete dependency graph under the actual browser bundle.

## Project credential constraint

This transport uses only the application's local client token. It introduces no OpenAI API key and no paid per-token API dependency.
