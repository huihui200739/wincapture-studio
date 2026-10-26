# Unified desktop interface

The visual reference is [DogSC](https://github.com/laogou717/dogsc), inspected at
commit `567fd6ed3bf113227dcf3e815f87ce60f0b69497`, alongside the user's supplied screenshots.
Its MIT notice is retained in [third-party/DogSC-LICENSE.txt](third-party/DogSC-LICENSE.txt).
This project implements the interface in React/CSS; DogSC's macOS frameworks,
application icon, recordings and wallpaper assets are not bundled.

Reference areas: `RecorderSurfaceStyle.swift`, `AppSettingsView.swift`,
`AppSettingsComponents.swift`, `EditorWorkspaceLayout.swift`, `EditorControls.swift`,
and `EditorExportViews.swift` in `Sources/DogSCApp`.

The interface font is Alibaba PuHuiTi 3.0 (unmodified OTFs from the reference
repository under its own free license, notice in
`src/renderer/fonts/LICENSE.txt`). The shared tokens in `src/renderer/design.css`
cover paper/graphite surfaces, recessed tracks, raised choices, typography,
radii, spacing, motion and focus. Editor, recorder, review card, project
library, tutorial, settings and export use the same tokens. Light is the
default; dark/system appearance and reduced motion are local preferences.

Editor chrome follows the reference docked layout: a 46px title bar, 1px
hairline separators, the 18px line-icon set ported to SVG
(`components/LineIcon.tsx`), a 60px inspector tab bar with a gliding capsule,
and a timeline with task-coloured lanes, bottom-anchored ruler ticks and the
red playhead. Windows keeps its own window controls, and the HUD keeps the
audio-audition toggle that the reference has no counterpart for.

Settings and export are dialogs over the current workspace. The editor stays
mounted, playback pauses, background commands are blocked, and closing returns
to the prior workspace. Export cannot be dismissed while its task is running;
the cancel action preserves the existing cancellation protocol.

Layout dials edit existing canvas properties and commit once per gesture.
Timeline waveform mode opens actual audio tracks. Export preview renders the
selected output variant with the same compositor as the editor.

Timeline navigation was also compared with `EditorTimelineLayout.swift`,
`EditorTimelineZoomTransport.swift` and `EditorTimelineMagneticSnap.swift` at the
same reference commit. The React timeline exposes a snapping toggle and usable
zoom buttons, preserves a visible playhead (or the viewport centre) while zooming,
and synchronizes the lane labels with vertical scrolling. Snapping remains on by
default, with Alt bypass, to preserve this project's existing editing behaviour.
These view controls do not change the project or add undo entries.

The grouped shortcut reference follows `EditorShortcutCheatsheet.swift` at the
same commit, adapted to the Windows bindings actually implemented here (Ctrl,
Delete, Shift+F10 and F1). Unsupported reference gestures are not advertised.

Run `npm run verify:design` after building. It captures the editor, settings
sections, light/dark appearance, export states, waveform mode, library, recording,
tutorial and compact dialogs into `dist/verify/design/`. It also checks workspace
preservation, output settings, explicit export failure and renderer errors.
`npm run verify:studio` additionally records real media and exports it through
the actual export sheet, checking progress, dismissal protection and the MP4 file.
