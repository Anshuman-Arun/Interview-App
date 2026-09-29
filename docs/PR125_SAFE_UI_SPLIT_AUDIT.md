# PR #125: isolated editorial UI audit (2026-09-29)

Source: PR #125, head `bf7ef65ae44f13b34063b5c409eb658c04cd1447`. Baseline: `main` at `d4231498353a55f21434e4e269e9b0a7ac2fdd1d`.

## Boundary decision

The original PR changes 109 files and is not an acceptable UI-only merge. This extraction starts directly from main, never merges or cherry-picks PR #125's mixed ancestry, and preserves the main-version `apps/web/src/App.tsx` **byte for byte**. It also preserves `NewInterviewPage.tsx`, `VoiceControls.tsx`, `StudentInputArea.tsx`, `TranscriptFeed.tsx`, every session hook, every provider, all server/desktop modules, model workers, generation/context code and dependencies.

## Included — visual/presentation-only

- `theme.css`, appearance defaults/accent labels, static `BrandMark.tsx`.
- `AppearanceDock.{tsx,css}` (visual appearance menu/zoom application), `ProductFrame.{tsx,css}`, `HomePage.{tsx,css}`.
- `ProductPageRouter.tsx`: existing provider-availability data is displayed as status, existing entry pending interlocks Sessions, and an ACTIVE count is derived from already-available session summaries. No new network requests, no session lifecycle changes. Status says `CHECK ON START` until existing main performs its authoritative start check; it does not falsely claim ongoing verification.
- Scoped `editorial-v10.css`: only common colors, product shell, Home, Sessions, Review and Settings rules. This deliberately strips mixed live Oxford, Quant, New Interview model-selector and mixed responsive override sections from the PR #125 stylesheet.
- `SessionsPage.{tsx,css}` and `ReviewPageShell.{tsx,css}` user-facing layout, text and tab navigation (existing stored-session/evaluation/replay data sources are preserved).
- CSS-only updates for New Interview's *existing native controls*, Settings, ReviewReadPanel, Quant, typed-input composer and VoiceControls. Voice CSS restores main's original chevron/selection CSS and appends only visual treatments.
- Existing targeted appearance/product-page tests updated to revised visible labels; entry/import updated to load scoped CSS.

## Excluded — do not merge with the UI

- Antigravity schema-enforcement changes (nested `proposalJson` string, relaxed multi-step execution, accepted tool surface), model/tier mapping, prompt changes, and canonicalization to the first authorized utterance when proposal validation fails.
- `useInterviewSession.ts` 90-second response watchdog and voice/typed-turn cycle tracking.
- TTS worker's streaming-to-batch synthesis, opening audio synthesis endpoint, voice transport, voice-client changes and live transcript delivery/retry changes.
- Desktop bootstrap, splash and activation policy, CLI runtime/readiness, model asset preparation, Python process supervision, packaging and diagnostics changes.
- Context compiler, proposal realization, event reducer/state, provider catalog, problem realization and review export changes.
- New Interview's rewritten model/tier/default provider selection and microphone meter; the existing main launch behavior remains authoritative.
- The live Oxford split/pane-focus/drag/End popover and related 4,000-line stylesheet's live overrides: requires a separate review because the original JSX is interleaved with lifecycle, whiteboard and transport authority.

## Latency hypotheses (not established root cause)

The excluded Antigravity adapter changes schema and acceptance semantics, including a possible generic fallback; the excluded hook's 90-second watchdog only reports delay rather than reducing it. The excluded Python TTS batch path can change time to first audio. Investigate these independently with a timed speech-commit → CLI-start → CLI-completion → TTS-first-audio trace. No claim is made that this UI PR resolves the observed ~3-minute response time.

## Acceptance before merge

- Verify compare to main contains only allowlisted presentation, CSS, navigation rendering, tests and this document; `App.tsx` and all runtime/session/provider/desktop/worker files have zero diff.
- Run typecheck, lint, browser and desktop builds, appearance/page/active-session regressions, and light/dark/zoom smoke.
- Test Home, New Interview existing provider selection, Sessions recovery, Review tabs, and paused Home, then test an end-to-end mock interview including voice/TTS, ideally comparing time-to-first-audio to unchanged main.
- Keep original PR #125 unmerged and this PR draft until acceptance completes.
