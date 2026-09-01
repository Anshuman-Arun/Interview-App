# Browser Runtime Compatibility

## Purpose

The browser MVP loads shared runtime schemas and ID helpers from the application packages. Those browser-reachable modules must not depend on Node-only builtins.

This slice removes the concrete blocker in `packages/domain/src/ids.ts` and adds a transitive static-import guard so future changes cannot silently reintroduce a Node builtin into the shared browser runtime graph.

## ID generation

Public ID factories now use:

```ts
globalThis.crypto.randomUUID()
```

instead of importing `randomUUID` from `node:crypto`.

Web Crypto is available in the supported Node 22 runtime and in modern secure browser contexts. The application does not fall back to `Math.random()` or another weaker source.

The public API and generated value shape remain unchanged:

```text
session_<uuid-v4>
event_<uuid-v4>
request_<uuid-v4>
utterance_<uuid-v4>
episode_<uuid-v4>
turn_<uuid-v4>
generation_<uuid-v4>
delivery_<uuid-v4>
```

Existing branded types and Zod schemas remain authoritative.

## Browser-shared runtime roots

The compatibility test walks the transitive local TypeScript import graph starting from:

```text
packages/domain/src/index.ts
packages/delivery/src/index.ts
```

These are the shared package surfaces currently reached by the isolated browser command and renderer work.

The scan follows relative imports recursively across project packages. It rejects Node builtins whether written as:

```text
node:crypto
node:fs
crypto
fs
fs/promises
```

Bare third-party packages such as `zod` are not classified as Node builtins.

The test also asserts that the graph actually reaches representative modules such as:

- `packages/domain/src/ids.ts`;
- `packages/domain/src/protocol.ts`;
- `packages/delivery/src/renderer.ts`.

That prevents the guard from passing because of a broken or empty graph traversal.

## Why both domain and delivery are scanned

The browser command client consumes domain protocol schemas.

The isolated renderer-stream branch consumes the delivery package public surface. Scanning both roots prevents browser compatibility from depending on bundler tree-shaking to hide a Node-only transitive import.

This is intentionally stricter than saying "the currently imported symbol happens not to execute Node code."

## Tests

The regression suite verifies that every public ID factory:

- emits the same prefix as before;
- emits a UUID-v4-shaped suffix;
- passes its existing Zod schema;
- produces unique values across a representative sample.

It separately confirms that `ids.ts` contains the Web Crypto implementation and no Node crypto import.

## Limits

This historical slice did not add Vite, React, or a browser build pipeline.

The static import guard proves that the shared runtime graph it covers does not import Node builtins; that remains a separate invariant from bundler compatibility. The current repository now also has a React/Vite browser shell and authoritative CI runs `pnpm build:web`, so the production bundle is validated in addition to this static import-graph check. Browser behavior is covered by the repository's browser/integration tests; this document should no longer be read as saying the build pipeline is absent.

## Authority boundary

This change does not alter:

- event semantics;
- SessionWriter behavior;
- persistence;
- provider policy;
- delivery state transitions;
- interview pedagogy;
- protocol wire shapes.

Only the source of secure UUID generation changes.

## Credential constraint

This slice introduces no provider credential, OpenAI API key, or paid per-token API dependency.
