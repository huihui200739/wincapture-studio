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

Shared controls were additionally compared with `EditorInspectorTabBar.swift`,
`EditorControls.swift`, `AppSettingsComponents.swift`, `AppChoiceFeedback.swift`
and `EditorDesignTokens.swift` at the pinned commit:

| Control | React/CSS implementation |
| --- | --- |
| Inspector task tabs | 60px bar, 44px targets, 17px icons; only the active label appears, with 14/16px horizontal insets and a measured sliding capsule. Measurement follows font loading and resizing. |
| Primary / quiet / toolbar buttons | 32px normal actions, 30px compact actions; theme-aware hover/press washes, .96/.97 press scales and distinct disabled opacities. Large recorder actions retain their larger targets. |
| Choice feedback | `ChoiceButton.tsx` holds visual feedback for at least 100ms without delaying activation. The previously selected choice scales its foreground to .96; other choices scale only their icon to .90. Pointer exit, blur and cancellation release feedback. |
| Segmented choices | Recessed capsule with 3px inset and a measured raised thumb; shared by inspector fields and export options. Left/Right, Home/End move focus and selection. Export locks the whole group while running. |
| Editor toggles | 38×22px track, 18px knob stretched to 22px on press. The label, description and empty row area activate the native switch once; the capsule keeps its size. Light and dark on/off states remain distinct. |
| Linear sliders | 32px target, 3px filled rail, 14px thumb with 7px inset, hover/drag scales 1.10/1.22 and a floating readout. Near-thumb drags are relative; rail clicks are absolute. |
| Type and surfaces | 15px panel headings, 13px controls, 12px field labels, 11px supporting toggle text; shared paper/wash surfaces, hairlines, shadows, 14px panel insets and 30px close buttons. |

Slider drafts commit once on pointer release or the end of a repeated key
gesture. Escape, pointer cancellation/capture loss, blur, resize and hiding the
document restore the last committed value. Keyboard increments are at least the
declared parameter step and normally 1% of the range; Shift/Page keys use 10%.
Native accessibility changes commit immediately. The native range input keeps
its label, value text and keyboard focus; control-owned keys do not seek the
timeline. Reduced motion removes spatial feedback.

The choice feedback is used by both levels of inspector tabs, settings
navigation, timeline display choices and the shared segmented control. If an
advanced export value (for example 720p) has no quick-choice counterpart, the
quick group shows no selected thumb and remains reachable by keyboard.

This is a source-guided Windows adaptation. The inspector keeps its five
implemented groups (camera is under canvas, audio under clips), and the Windows
Ctrl/Delete/context-menu bindings and recording/export pipeline remain in use.
The Mac browser's “界面预览” badge identifies mock data and is hidden in the
native app. Specialized reference controls such as `EditorBarSlider` and macOS
system pickers are not represented as newly implemented features.

The grouped shortcut reference follows `EditorShortcutCheatsheet.swift` at the
same commit, adapted to the Windows bindings actually implemented here (Ctrl,
Delete, Shift+F10 and F1). Unsupported reference gestures are not advertised.

Run `npm run verify:design` after building. It captures the editor, settings
sections, light/dark appearance, export states, waveform mode, library, recording,
tutorial and compact dialogs into `dist/verify/design/`. It also checks workspace
preservation, output settings, explicit export failure and renderer errors.
`npm run verify:studio` additionally records real media and exports it through
the actual export sheet, checking progress, dismissal protection and the MP4 file.
