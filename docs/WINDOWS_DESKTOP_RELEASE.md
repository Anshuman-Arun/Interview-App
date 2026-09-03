# Windows desktop release

## Release shape

Windows x64 is the primary release target. Packaging uses the pinned stable
`electron-builder@26.15.3` release and produces a per-user NSIS installer:

```text
dist/windows/InterviewApp-Setup-<package version>.exe
```

The stable application identity is `com.anshuman.interviewapp`. The package
version is the release identity; timestamps and random values are not used in
artifact names.

`pnpm package:win` creates an unpacked Windows application for inspection.
`pnpm dist:win` creates the NSIS installer. Both run the public-release gate
and packaged-resource verifier.

## ASAR and resource boundary

Application JavaScript and production npm dependencies live in `app.asar`.
Files that must remain ordinary filesystem resources are deliberately outside
ASAR:

```text
<resources>/web/**
<resources>/preload.cjs
<resources>/workers/python/local_model_worker.py
<resources>/workers/python/requirements-local-model-runtime.txt
```

The production worker path remains Ivy's packaged boundary:

```text
<process.resourcesPath>/workers/python/local_model_worker.py
```

Model weights are never part of the base installer. Fake workers, test
fixtures, repository tests, development environment files, source databases and
logs are not packaging inputs.

## Python strategy

Personal-use v1 intentionally does **not** redistribute CPython. Voice uses a
compatible system CPython 3.12 or 3.13 installation plus the exact versions in
`requirements-local-model-runtime.txt`. Typed interviews do not require
Python and stay available when the local runtime is missing or invalid.

The desktop Settings page reports the voice capability and the Python
prerequisite. A missing interpreter is reported as unavailable rather than
falling back to a fixture worker.

For voice on a clean machine, install CPython 3.12 or 3.13 and install the
pinned requirements with that interpreter. A custom interpreter may be selected
with `INTERVIEW_LOCAL_PYTHON`; the runtime canonicalizes and validates it
before worker registration.

## Model setup

Settings exposes **Install / verify voice models**. It invokes the existing
`ModelAssetManager`; fixed source URLs, expected byte sizes and SHA-256
digests remain authoritative. Interrupted downloads stay in staging and are
cleaned/retried by the existing manager.

After a successful model install, restart Interview App. Ivy's runtime is
one-shot per application lifecycle, so the packaging layer does not hot-restart
it after changing the verified asset set.

The repository command `pnpm setup:desktop-models` remains available for
development, but a terminal is not required to download model weights in the
installed app.

## Data, cache and upgrade semantics

Electron per-user `userData` owns mutable state. With the packaged product
identity the expected Windows locations are:

```text
%APPDATA%\Interview App\data\interview-session.sqlite
%APPDATA%\Interview App\data\model-assets\
%APPDATA%\Interview App\data\runtime-models\
```

The installer is per-user; application binaries live separately under the
normal per-user program installation directory. The application never writes
the database, model cache or runtime views into the install directory.

The stable app ID and product identity permit in-place replacement. Installer
CI installs, launches, writes durable state, reinstalls, and verifies the
database/model-cache marker survived.

Default uninstall removes application binaries and intentionally leaves
`%APPDATA%\Interview App` intact. Delete that residual directory manually
only when interview history and cached models should actually be erased.

## Security

Packaging preserves the existing Electron trust model: context isolation,
sandboxing, disabled Node integration/webviews, navigation guards, exact
loopback authentication injection, trusted bootstrap and restricted microphone
permissions.

Model-management IPC is exposed only through preload and uses the same trusted
WebContents/main-frame/origin admission predicate as bootstrap IPC. No
filesystem path, shell, arbitrary command, worker token or backend client token
is exposed to the renderer.

## Signing and SmartScreen

Current CI/manual artifacts are **unsigned development installers**. No signing
certificate or private key is committed, generated or faked. A future release
workflow can provide a genuine signing identity securely without changing the
packaged resource boundary.

Unsigned installers can trigger Windows Defender SmartScreen warnings. That is
an expected current limitation, not a reason to weaken runtime or installer
security checks.

## Automated packaged checks

Windows packaging CI validates:

1. browser and desktop production builds;
2. public-release hygiene before packaging;
3. NSIS and unpacked package creation;
4. exact worker/preload resource hashes;
5. ASAR inclusion/exclusion rules;
6. launch from a copied path containing spaces and Unicode;
7. real packaged preload and renderer load;
8. loopback backend startup;
9. a typed session/input round trip;
10. SQLite persistence across a backend restart;
11. missing-Python graceful degradation;
12. OS single-instance lock behavior;
13. clean shutdown with no newly-owned `local_model_worker.py` process;
14. silent install/reinstall/uninstall with history/cache preservation.

No fake production inference is enabled by these checks.

## Manual release-machine checklist

Before treating an installer as a personal release, run the following on a
clean Windows x64 machine:

- Install into the default path and launch from Start Menu and the desktop shortcut.
- Repeat with a Windows username containing non-ASCII characters.
- Confirm typed interview creation/input/history work while offline.
- Confirm missing Python and an unsupported Python version leave typed mode
  usable and clearly report voice unavailable.
- Install CPython 3.12 or 3.13 plus pinned requirements, use Settings to install
  verified models, then restart.
- Interrupt model setup, relaunch, retry and confirm no partial asset is admitted.
- Exercise microphone/STT/TTS with real model weights.
- Quit during worker startup, inference and model download; confirm no owned
  worker descendants remain.
- Launch a second copy while the first is open; confirm the existing window is
  focused and no second backend/database writer appears.
- Make the install directory read-only and confirm mutable state still goes to
  per-user app data.
- Upgrade over a prior installer and verify interview history/model cache.
- Uninstall and verify binaries are removed while app data remains.
- Reinstall and verify preserved history/model cache are still usable.
- Inspect SmartScreen/Defender behavior for the unsigned build; do not bypass
  product security checks to suppress warnings.

## Remaining limitations

- The base installer does not bundle CPython or Python wheels.
- Model weights are intentionally downloaded after installation.
- CI does not exercise real Moonshine/Kokoro inference weights.
- The installer remains unsigned until a real certificate is securely supplied.
- Auto-update is not enabled; upgrades are explicit installer replacements.
- macOS signing/notarization and Linux packaging are outside this Windows-first
  slice.
