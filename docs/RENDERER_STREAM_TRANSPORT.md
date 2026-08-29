# Renderer Stream Transport — Phase 0

## Purpose

This slice is a narrow architecture harness for application-owned delivery transport. It does not implement a polished frontend, TTS, provider integration, Electron packaging, or a production voice stack.

Its purpose is to prove that TEXT and AUDIO traverse one stable DeliveryAtom / DeliveryId lifecycle:

[
	ext{QUEUED} ightarrow 	ext{DELIVERING} ightarrow 	ext{EXPOSED} ightarrow 	ext{COMPLETED}
]

with conservative recovery to `POSSIBLY_EXPOSED` when a persisted in-flight delivery is recovered after application restart.

Generation, validation, queueing, network transmission, physical exposure, and completion remain distinct operations.

## Files added or changed

Added:

- `apps/server/src/renderer-stream-server.ts`
- `apps/web/src/index.ts`
- `apps/web/src/renderer-client.ts`
- `apps/web/src/renderer-stream.ts`
- `packages/delivery/src/renderer-stream-protocol.ts`
- `tests/renderer-stream-transport.test.ts`
- `tests/renderer-audio-crash.test.ts`
- `tests/renderer-client-deduplication.test.ts`
- `docs/RENDERER_STREAM_TRANSPORT.md`

Changed:

- `packages/delivery/src/index.ts` only to export the new transport protocol.

No dependency, package-manager, event-schema, reducer, persistence, provider, verifier, architecture-checker, or CI files are changed.

## Authority boundary

The stream transport does not append events and does not own session state.

For a queued atom, `RendererStreamServer.publishDelivery()` delegates to the existing `DeliveryCoordinator.reconnect()`. That coordinator executes through the existing SessionWriter. Consequently:

1. `DELIVERY_STARTED` is persisted before the stream frame is written.
2. A same-runtime retry of a `DELIVERING` atom reuses the same DeliveryId and does not append another start event.
3. Renderer acknowledgements go through the existing authenticated `POST /v1/commands` endpoint.
4. Duplicate acknowledgement RequestIds remain durably idempotent through the existing SessionWriter / processed-request mechanism.
5. A persisted `DELIVERING` atom recovered after application restart becomes `POSSIBLY_EXPOSED` through the existing DeliveryCoordinator recovery path before it can be reissued.
6. `POSSIBLY_EXPOSED`, `EXPOSED`, `COMPLETED`, and other non-deliverable terminal states are never streamed again by this transport.

The renderer cache is non-authoritative. Losing the cache cannot change application state.

## Protocol

### Version

Renderer stream protocol version: `1`.

The stream-specific schemas are strict Zod schemas. Unknown fields and unknown message types are rejected.

External SessionId, DeliveryId, and acknowledgement RequestId values must use the application's generated prefix-plus-UUID form rather than merely being non-empty strings.

### Stream attachment

Endpoint:

`POST /v1/renderer-stream`

Request body:

```json
{
  "protocolVersion": 1,
  "type": "ATTACH_RENDERER_STREAM",
  "sessionId": "session_<uuid>"
}
```

The authentication token is not part of the body or URL.

### Server-to-renderer delivery

Wire framing uses a minimal SSE-compatible stream over authenticated `fetch`:

```text
event: delivery
data: {"protocolVersion":1,"type":"DELIVERY_COMMAND","command":{...}}

```

Logical message:

```json
{
  "protocolVersion": 1,
  "type": "DELIVERY_COMMAND",
  "command": {
    "deliveryId": "delivery_<uuid>",
    "content": {
      "medium": "TEXT",
      "text": "..."
    }
  }
}
```

or:

```json
{
  "protocolVersion": 1,
  "type": "DELIVERY_COMMAND",
  "command": {
    "deliveryId": "delivery_<uuid>",
    "content": {
      "medium": "AUDIO",
      "text": "...",
      "audioRef": "/local/audio/reference"
    }
  }
}
```

The content contract reuses the existing domain `DeliveryCommandSchema`, so each command contains one and only one discriminated content variant.

WHITEBOARD remains present in the shared domain contract. The renderer accepts it only when a WhiteboardPresenter is explicitly provided; this Phase 0 slice does not implement a whiteboard surface.

### Renderer acknowledgements

No second acknowledgement protocol is invented.

The renderer uses the existing authenticated command endpoint:

`POST /v1/commands`

with either:

- `ACK_DELIVERY_EXPOSED`
- `ACK_DELIVERY_COMPLETED`

Each milestone gets one stable RequestId in the renderer cache. A failed acknowledgement retries the same RequestId. The server's existing processed-request mechanism therefore makes duplicate acknowledgements durably idempotent.

There is deliberately no authoritative RECEIVED acknowledgement. Receipt is renderer-local transport state and does not imply exposure.

## Exposure definitions

### TEXT

TEXT is locally `RECEIVED` when the stream command has been validated and admitted into the renderer's bounded DeliveryId cache.

TEXT becomes `EXPOSED` only after the TextPresenter has inserted it into the visible renderer. The provided `DomTextPresenter` refuses to treat insertion into a detached container as exposure.

TEXT becomes `COMPLETED` after that presentation operation has completed. EXPOSED and COMPLETED remain separate acknowledgements even when they occur close together.

### AUDIO

AUDIO is locally `RECEIVED` when its delivery command has been validated.

Fetching, constructing, or decoding audio does not count as exposure.

AUDIO becomes `EXPOSED` only when the audio player invokes its actual-start callback. The provided `HtmlAudioPlayer` maps that callback to the HTML media `playing` event, not to `play()` invocation.

AUDIO becomes `COMPLETED` only when the player invokes its completion callback. The provided browser implementation maps completion to the `ended` event.

Tests inject a deterministic fake player and do not depend on physical speakers, browser timing, or TTS.

### WHITEBOARD

WHITEBOARD exposure remains contract-only in this slice. A future concrete presenter must acknowledge exposure only after the action is visibly applied.

## Authentication and trust boundary

The stream server:

- binds only to `127.0.0.1` or `::1`;
- requires at least one exact allowed Origin;
- validates exact Origin before attachment;
- authenticates POST attachment with the existing `x-interview-client-token` header;
- uses constant-time token comparison;
- never accepts the token in the URL or stream body;
- never puts the token in a command envelope, event, transport result, error body, or log;
- uses `no-store` responses;
- accepts only bounded JSON attachment bodies.

The browser renderer module itself does not accept or store the authentication token. It receives an `authenticatedFetch` capability from the launcher/bootstrap boundary. That capability is responsible for transient credential attachment. Renderer state contains only DeliveryIds, lifecycle phases, content fingerprints, acknowledgement RequestIds, and acknowledgement status.

This intentionally keeps credential provisioning outside the delivery renderer.

## Bounds

Server-side bounds:

- attachment body: 8 KiB;
- delivery stream message: 64 KiB maximum;
- active stream connections: 4 by default;
- active stream connections per session: 1 by default;
- retained pending delivery queue: zero.

The server does not buffer semantic deliveries awaiting a renderer. If no renderer is attached, `publishDelivery()` returns `NO_CLIENT` and a QUEUED atom remains QUEUED.

Renderer-side bounds:

- tracked DeliveryIds: 256 by default;
- only entries whose COMPLETED acknowledgement is confirmed may be evicted;
- if the cache is full of in-flight or unacknowledged deliveries, admission fails closed rather than forgetting an idempotency key.

Inbound stream parsing also bounds the accumulated undecoded event buffer and each parsed SSE event.

## Reconnect algorithm

1. Normal browser operation first establishes/uses the session through the authenticated command runtime.
2. The renderer attaches to the authenticated stream with its SessionId.
3. Stream attachment runs the existing uncertain-delivery recovery for that server runtime before the client is registered.
4. If a delivery is still QUEUED and a live renderer exists, publishing delegates to `DeliveryCoordinator.reconnect()`, which persists `DELIVERY_STARTED` before the stream write.
5. If a delivery is already DELIVERING in the same runtime, the coordinator returns the same DeliveryId/content without another start event.
6. A renderer that still has that DeliveryId in its bounded cache suppresses duplicate visible text and duplicate audio playback. It may retry any unpersisted acknowledgement with its original RequestId.
7. After application restart, persisted DELIVERING is recovered to POSSIBLY_EXPOSED before reattachment/publish. The transport refuses to replay POSSIBLY_EXPOSED.
8. Persisted EXPOSED is also never replayed; completion can be handled separately by later policy rather than duplicating presentation.

This is stable identity plus idempotent presentation/acknowledgement. It is not an exactly-once network-delivery claim.

## Crash and reconnect matrix

| Boundary | Authoritative state | Renderer behavior | Recovery / retry |
| --- | --- | --- | --- |
| Generated or validated but not queued | no delivery exposure | none | normal generation policy |
| QUEUED, no renderer attached | QUEUED | none | safely publish later |
| Renderer attached, before publish | QUEUED | none | safely publish later |
| STARTED persisted, command not physically presented yet | DELIVERING | possibly RECEIVED | same-runtime retry uses same DeliveryId and renderer cache |
| Duplicate TEXT command to same renderer cache | DELIVERING or later | no second insertion | original acknowledgement state reused |
| Duplicate AUDIO command to same renderer cache | DELIVERING or later | playback not restarted | original callbacks/acknowledgement state reused |
| TEXT inserted visibly | EXPOSED after ACK persistence | visible once | duplicate ACK is idempotent |
| AUDIO playback actually starts | EXPOSED after ACK persistence | audible once per cached DeliveryId | duplicate ACK is idempotent |
| Presentation completes | COMPLETED after ACK persistence | no replay | duplicate COMPLETED ACK is idempotent |
| Renderer receives command, disconnects before exposure, same renderer state reconnects | DELIVERING | cached DeliveryId suppresses duplicate presentation startup | same DeliveryId may be reissued |
| Exposure begins, ACK transport is lost, then application crashes | persisted DELIVERING | renderer had begun presentation | restart recovers POSSIBLY_EXPOSED before reconnect; no replay |
| Application restarts with persisted DELIVERING | POSSIBLY_EXPOSED | no replay | counts as disclosed under existing reducer policy |
| Renderer crashes after persisted EXPOSED but before COMPLETED | EXPOSED | fresh renderer receives no replay command | remains EXPOSED until a later completion policy acts |
| Malformed/oversized attach or stream message | unchanged | fail closed | no guessed interpretation |
| Wrong Origin/token | unchanged | cannot attach/acknowledge | generic secret-free error |

## Tests

`tests/renderer-client-deduplication.test.ts` covers renderer-local receipt/exposure/completion separation, TEXT deduplication, AUDIO no-restart behavior, content mismatch fail-closed behavior, cache bounds, malformed/oversized inbound stream handling, and strict schemas.

`tests/renderer-stream-transport.test.ts` covers authenticated attachment, exact Origin/token rejection, bounds, TEXT/AUDIO use of the same transport abstraction, no-client QUEUED behavior, durable/idempotent acknowledgement routing through the existing command server, and secret exclusion.

`tests/renderer-audio-crash.test.ts` covers deterministic audio start/completion callbacks, same-ID reconnect before exposure, lost exposure acknowledgement followed by application restart, POSSIBLY_EXPOSED recovery/no-replay, and persisted EXPOSED/no-replay after renderer crash.

## Known limitations and requested changes outside this branch

### 1. Existing command endpoint needs browser CORS integration

The new stream endpoint implements exact-Origin CORS preflight for its custom authentication header.

The existing `apps/server/src/loopback-command-server.ts` does not currently handle browser OPTIONS preflight or emit `Access-Control-Allow-Origin`. A browser page served from a separate development origin such as `http://127.0.0.1:5173` therefore cannot use the custom-token acknowledgement POST path directly even though the command path's authentication and semantics are correct.

That file is outside this task's exclusive write scope, so it was not changed.

Minimal requested integration change:

- add OPTIONS handling for `/v1/commands`;
- accept only an exact configured Origin;
- allow only POST plus `content-type` and `x-interview-client-token`;
- emit exact `Access-Control-Allow-Origin` on permitted command responses;
- keep credential authentication mandatory on POST and keep credential values out of command bodies/domain envelopes/errors.

An equally valid later composition is to serve/reverse-proxy the renderer and command endpoint under one same-origin local application boundary.

Until one of those changes is made, the browser-facing classes are an architecture harness and Node integration tests, not a claim of complete cross-origin browser E2E operation.

### 2. Session recovery ownership is duplicated between the two server adapters

The existing command server owns a per-instance “first authenticated use” recovery guard. The new stream server must independently perform the same recovery before stream attachment because no shared public recovery coordinator exists.

Normal flow is safe when the command runtime is used to create/read the session before any stream delivery starts, which is how the integration tests are composed.

A future cleanup should expose one application-owned session-recovery coordinator that both adapters call. Implementing that cleanly would require edits to existing server/interview-engine ownership outside this branch's allowed scope. No such change is made here.

### 3. No durable renderer cache

The renderer's processed-DeliveryId cache is intentionally bounded and in memory. It is not authoritative and contains no authentication secret.

Same-runtime reconnect can therefore deduplicate reissued DeliveryIds while that renderer state survives. Application restart remains safe because persisted DELIVERING is conservatively promoted to POSSIBLY_EXPOSED before replay.

A later browser lifecycle design may choose a carefully scoped local idempotency cache, but this slice does not add browser persistence.

### 4. No real audio generation

AUDIO transports an existing local `audioRef`. This slice does not synthesize speech, stream audio frames, or persist transient audio chunks.

### 5. No exactly-once network guarantee

SSE/fetch writes can fail or disconnect after durable start. The architecture deliberately relies on stable DeliveryId identity, renderer deduplication, idempotent acknowledgements, and conservative recovery rather than claiming exactly-once network or physical delivery.
