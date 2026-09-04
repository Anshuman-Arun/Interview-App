# Interview App v{{VERSION}}

Source commit: `{{SOURCE_SHA}}`  
Release workflow: {{WORKFLOW_URL}}

## What's new

This is a versioned Windows desktop release built from the exact tagged source commit.

## Supported modes

- Oxford Mathematics
- Quant Trading
- Quant Research

Voice, whiteboard, review, and local-model capabilities are available according to the runtime readiness reported by this build.

## System requirements

- Windows x64.
- CPython 3.12 or 3.13 is required only for local model runtimes that report it as a prerequisite.
- Internet access is required for remote reasoning and for downloading optional model assets.
- Antigravity reasoning requires the supported local Antigravity CLI/runtime to be installed and authenticated.

## Setup

1. Download `InterviewApp-Setup-{{VERSION}}.exe` and its matching `.sha256` file.
2. Verify the checksum before installing.
3. Run the installer and launch Interview App.
4. Open Settings and resolve any local-runtime/model readiness items you intend to use.
5. Verify Antigravity readiness before starting a remote-reasoning interview.

## Known limitations

- The Windows installer is currently unsigned and may trigger SmartScreen warnings.
- Automatic updates are not enabled; upgrades use a newer installer.
- macOS and Linux packages are not part of this release.

## Upgrade notes

Install the newer version over the existing per-user installation. Interview session data, model assets, and settings are stored under the stable per-user application data identity and are expected to survive an in-place upgrade.

## Checksums

SHA-256:

```text
{{CHECKSUM}}  InterviewApp-Setup-{{VERSION}}.exe
```
