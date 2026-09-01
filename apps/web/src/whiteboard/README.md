# Browser whiteboard integration

The browser whiteboard uses the real `tldraw` editor. `WhiteboardCanvas` owns the React mount and wraps the native editor in `RealTldrawEditorBridge`, which preserves the existing frontend `TldrawWhiteboardAdapter` boundary.

## Ownership

- Shapes created through ordinary tldraw interaction are tagged `STUDENT`.
- AI annotations remain tagged `AI_ANNOTATION`, are locked in tldraw, and are changed only through guarded adapter operations.
- `SYSTEM_DECORATION` shapes receive the same protection from ordinary user mutation.
- AI overlay creation, clearing, and erasure do not rewrite student shapes.

## Normalized change seam

Future synchronization code should subscribe through `RealTldrawEditorBridge.subscribeToNormalizedStudentChanges`. It emits application-level `StudentShape` records for additions, edits, and deletions rather than exposing tldraw store internals.

This frontend seam deliberately does **not** define authoritative backend events, persistence, reconciliation, or a wire protocol. It also does not perform screenshot capture, computer vision, mathematical interpretation, or model calls. Those remain separate integration tasks.

## TypeScript declaration compatibility

Repository source and tests remain under strict TypeScript checking. The root
`skipLibCheck` setting is enabled for this integration only because
`tldraw@5.3.2` currently exposes incompatible/transitively incomplete declaration
files from tldraw/Tiptap/lodash packages under the repository's TypeScript version.
It does not suppress type checking of this whiteboard source or its tests.

