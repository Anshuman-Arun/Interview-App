# Laptop Diagnostics

This diagnostic suite is intended for real Windows machines running the Interview App desktop stack. It uses the same packaged Python workers, installed model assets, supervised Antigravity runtime, provider adapter, server transports, and turn orchestration used by the application.

## Before running

1. Close Interview App completely.
2. Ensure the repository checkout is on the latest `ui/editorial-v10-port` branch.
3. Ensure `pnpm` 11.19.0 is available through Corepack.
4. Ensure Antigravity CLI is already signed in if remote probes are enabled.

## One-command run

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-laptop-diagnostics.ps1
```

To run real inference against every supported Gemini Flash tier:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-laptop-diagnostics.ps1 -AllModels
```

To override desktop paths if automatic detection fails:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-laptop-diagnostics.ps1 `
  -AppDataRoot "$env:APPDATA\Interview App" `
  -ResourcesPath "$env:LOCALAPPDATA\Programs\Interview App\resources"
```

## What it checks

The focused contract phase covers malformed provider output, permission-mode drift, normalized model IDs, process supervision, voice authority, TTS delivery, barge-in, replay behavior, and desktop-runtime lifecycle cases already encoded in the repository test suite.

The real-machine phase then checks:

- installed desktop app-data and packaged worker paths;
- the actual managed Python runtime and installed local model assets;
- real Moonshine + Kokoro worker startup through `DesktopLocalRuntimeComposition`;
- Kokoro synthesis at the production 24 kHz output setting;
- Kokoro 48 kHz synthesis fed back through the real Moonshine/Silero speech worker;
- raw Antigravity CLI executable/version discovery;
- app-supervised Antigravity user-profile safety validation;
- supervised zero-turn Antigravity protocol readiness;
- a real remote Antigravity inference that must return exactly one valid `InterviewerProposal`;
- the actual configured Oxford session path:
  configured session -> typed student input -> turn orchestration -> real Antigravity -> validated proposal -> renderer delivery -> TTS audio asset.

## Antigravity trace

The report contains a bounded trace for the supervised provider runtime. It never records prompts, credentials, API keys, raw provider output, or raw stderr.

Each subprocess stage records:

- `USER_PROFILE_SAFETY`
- `VERSION_CHECK`
- `ZERO_TURN_PREFLIGHT`
- `TURN_EXECUTION`

with:

- start timestamp;
- elapsed milliseconds;
- success/failure;
- process exit code when available;
- stdout byte count;
- stderr byte count;
- bounded error class/code when available.

## Output

Every run creates:

```text
diagnostics-output\<timestamp>\report.txt
diagnostics-output\<timestamp>\report.json
```

Upload **both files** when debugging a laptop failure. The JSON contains the useful details that are intentionally omitted from the compact text summary.

A nonzero process exit means at least one check failed; the report is still written whenever the suite reached normal completion.

## Useful switches

- `-AllModels` — real inference on all supported Gemini Flash model/reasoning tiers.
- `-SkipRemote` — test only local/runtime behavior and skip remote inference.
- `-SkipContracts` — skip the repository adversarial test phase.
- `-Model gemini-3.7-flash-high` — choose the model used for the real full-turn probe.

Remote inference probes can consume provider quota. The default run performs real inference only for the selected default model plus one full configured interview turn.
