# Local-first Technical Interview App

This repository is a Phase 0 architecture harness for the frozen design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The current executable path is intentionally backend-only and uses SQLite, a deterministic mock reasoning provider, a closed-world disclosure validator, and a mock renderer.

## Run

```powershell
pnpm install
pnpm check
pnpm demo
```

The Codex runtime on the bootstrap machine has a package-manager wrapper that may try to reconcile `node_modules` non-interactively. The repository-local executables are also directly usable:

```powershell
.\node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit
.\node_modules\.bin\eslint.cmd .
.\node_modules\.bin\vitest.cmd run
.\node_modules\.bin\tsx.cmd apps\server\src\run-synthetic.ts
```

No real provider, credential, remote request, frontend, voice stack, or production whiteboard integration is enabled in this slice.
