# Secure Electron Desktop Bootstrap

## Scope

This desktop slice wraps the existing Interview App architecture. It does not change interview state, provider execution, problems, Quant logic, whiteboard behavior, audio, or session-resume semantics.

This document originated with the isolated desktop-bootstrap slice based on `27090745ccc34367b0edc1622de9d11ca04b808f`. The implementation is now integrated into the current repository; the old base SHA is historical provenance, not a statement about the present branch.

## Architecture

```text
Electron main
  ├─ starts existing createAndStartServer()
  │    ├─ command server on ephemeral 127.0.0.1 port
  │    └─ renderer stream on ephemeral 127.0.0.1 port
  ├─ generates one high-entropy per-launch client token
  ├─ keeps that token in the main process
  ├─ creates an isolated Electron session/window
  └─ exposes safe bootstrap metadata through preload
        ↓
existing web frontend
        ↓  x-interview-client-token: desktop-managed-v1
Electron webRequest boundary replaces marker on exact endpoints only
        ↓  x-interview-client-token: <per-launch secret>
authenticated loopback backend
```

The real client token is never returned by preload, placed in a URL, embedded in static assets, or logged.

## Backend lifecycle

Electron imports the existing `createAndStartServer()` API directly. No backend code is duplicated and no child process is created.

The desktop controller coalesces concurrent starts, treats resolution of `createAndStartServer()` as readiness, clears failed startup state for an explicit retry, and waits for an in-flight start before shutdown. The existing server instance supplies the clean `stop()` path.

Both backend ports are requested as port `0`, so the OS chooses free loopback ports. A bind failure is fatal rather than causing authentication to be disabled.

## Frontend lifecycle

Development mode expects the existing Vite frontend at `http://127.0.0.1:5173`. Set `INTERVIEW_DESKTOP_DEV_URL` in the Electron main-process environment to another exact HTTP loopback origin if needed.

Run development in two terminals:

```text
pnpm dev:web
pnpm dev:desktop
```

The backend is started by Electron itself, so there is no separate desktop backend command.

Production mode:

```text
pnpm start:desktop
```

builds the existing Vite frontend and serves it from a desktop-owned ephemeral loopback HTTP server. This intentionally avoids a `file://` / opaque Origin, preserving the backend's exact-Origin security model. The production static server does not serve content until the backend origins have been configured and applies a restrictive CSP.

Windows packaging now uses the repository `electron-builder.yml` and the `package:win` / `dist:win` scripts. Current installer artifacts are intentionally unsigned; code signing and auto-update remain deferred. See `docs/WINDOWS_DESKTOP_RELEASE.md` for the resource boundary and release checklist.

## Preload surface

The preload bridge exposes one operation:

```ts
window.interviewDesktop.getBootstrap()
```

It returns only:

- command loopback origin;
- renderer-stream loopback URL;
- a non-secret desktop authentication marker;
- application version;
- platform.

It does not expose Node, `fs`, `child_process`, `process.env`, arbitrary IPC, shell execution, or filesystem paths.

## Electron security properties

The main window uses:

- `contextIsolation: true`
- `nodeIntegration: false`
- `nodeIntegrationInWorker: false`
- `nodeIntegrationInSubFrames: false`
- `sandbox: true`
- `webSecurity: true`
- `allowRunningInsecureContent: false`
- `webviewTag: false`
- an in-memory desktop session partition
- permission requests denied by default except for the exact trusted main-window, main-frame, trusted-origin, audio-only media capability
- denied popup creation
- main-frame and subframe navigation restricted to the trusted frontend origin

The authentication injector is scoped to the current window's WebContents ID, the current trusted main frame, POST requests, and the exact command/renderer-stream endpoints. Requests from subframes, stale frames, other WebContents, other methods/endpoints, or requests without the exact known non-secret marker are not upgraded with credentials. The main-frame identity is resolved for each request so a same-origin reload does not keep a stale frame credential boundary.

## Application data path

The desktop bootstrap creates and owns the durable data root:

```text
app.getPath("userData")/data
```

The authoritative SQLite file is opened at:

```text
app.getPath("userData")/data/interview-session.sqlite
```

Electron passes that exact stable path to the existing server's `databasePath`. It is independent of the process working directory and remains in the main process; neither the path nor any database details are exposed through renderer bootstrap data.

## Shutdown

On application quit the desktop layer:

1. stops accepting bootstrap IPC;
2. revokes the audio permission capability and token-injection listener;
3. destroys the capable renderer if either capability revocation fails;
4. clears the in-memory token reference;
5. waits for the existing backend to stop cleanly;
6. closes the production frontend server;
7. then allows Electron to quit.

Because the backend is in-process, there is no child process to orphan.

## Failure behavior

Startup fails closed when:

- the frontend build is missing;
- the frontend loopback server cannot bind;
- the existing backend cannot bind/start;
- bootstrap metadata is malformed;
- preload cannot obtain a valid bootstrap;
- the initial renderer load fails.

No failure path disables loopback binding, Origin checks, or client authentication.

## Validation

Desktop-specific tests cover secure web preferences, safe preload/bootstrap data, malformed bootstrap rejection, backend start deduplication/readiness/failure/shutdown, exact main-frame token-injection boundaries, audio-only permission checks, stable SQLite persistence across backend lifecycles, app-data path resolution, development/production configuration, and production frontend serving/CSP.

Repository commands:

```text
pnpm test:desktop
pnpm typecheck
pnpm lint
pnpm build:web
pnpm build:desktop
node scripts/check-architecture-boundaries.mjs
pnpm test
```

CI runs the desktop emit build and desktop-only tests on both Ubuntu and Windows in addition to the full repository matrix. Graphical window launch remains environment-dependent; CI runners do not provide a trusted interactive desktop session, so the non-GUI lifecycle/security behavior is the automated verification boundary for this slice.
