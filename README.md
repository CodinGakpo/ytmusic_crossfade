# YT Music Crossfade (Chrome Extension)

Skip the end of the current track and skip the start of the next track on YouTube Music.

- Platform: Chrome Extension Manifest V3
- Stack: Vanilla JavaScript (no bundler)
- Scope: `https://music.youtube.com/*`

---

## Current Features

1. `Skip last N sec` (end skip)
   - When remaining time is within threshold, extension triggers Next.
2. `Skip first M sec` (intro skip)
   - On each new track, extension seeks to `M` seconds once.
3. Live settings updates
   - Popup updates apply immediately via `chrome.storage.onChanged`.
4. SPA resilience
   - Handles DOM swaps and player re-renders in YouTube Music.

---

## What Has Been Implemented / Hardened

The extension has gone through multiple reliability passes and currently includes:

1. Per-track state machine
   - Track state: `trackKey`, `introApplied`, `endTriggered`.
   - Prevents duplicate end triggers and duplicate intro seeks.

2. Multi-source track detection
   - Primary key: `ytmusic-player[video-id]`.
   - Fallback key: `video.currentSrc`.

3. Persistent rebinding for SPA behavior
   - DOM MutationObserver + periodic rebind timers.
   - Reattaches player/video listeners if nodes are replaced.

4. End-skip retry engine
   - Repeated Next attempts for transient UI states.
   - Re-arms if retries are exhausted.

5. Next-button hardening
   - Multiple selectors, including `tp-yt-paper-icon-button` variants.
   - Filters disabled/aria-disabled controls.
   - Keyboard fallback attempts (`Shift+N`, `MediaTrackNext`).

6. Settings stability
   - Values are clamped (`skipEnd: 1..30`, `skipStart: 0..30`).
   - Slider writes are committed on `change` (not every drag tick).

7. Edge fallback paths
   - `ended` fallback trigger if threshold path is missed.
   - Extra processing on seek/seeking/metadata.

---

## Runtime Flow (Actual)

```text
Extension injects content.js on music.youtube.com
  -> loadSettings() from chrome.storage.sync
  -> bindRefs(): locate ytmusic-player + <video>
  -> attach player observer (video-id changes)
  -> attach video listeners (timeupdate, loadedmetadata, seeking, seeked, ended)
  -> start timers:
       - watchdog (250ms): process tick + rebind safety
       - rebind (1000ms): re-discover player/video nodes
  -> start DOM observer for SPA mutations

On each processing tick:
  1) Resolve current track key
  2) If track key changed -> reset per-track state
  3) Apply intro skip once for this track (if enabled)
  4) Check end threshold and trigger Next with retries
```

---

## File-by-File Function

### `manifest.json`

Defines extension metadata and wiring:

1. Manifest V3 declaration
2. `storage` permission
3. Host permission for `music.youtube.com`
4. Injects `content.js` into matching pages
5. Registers popup UI (`popup.html`)
6. Registers extension icons

### `content.js`

Main runtime controller injected into YouTube Music.

Responsibilities:

1. Settings load/sync (`skipEndSeconds`, `skipStartSeconds`, `enabled`)
2. Player/video node discovery and reattachment
3. Track boundary detection and per-track state reset
4. Intro skip logic
5. End skip logic with retry strategy
6. DOM + timer-based resilience for SPA updates

Key internal sections:

1. Config constants
2. `settings`, `refs`, `state` objects
3. Storage listeners and clamping
4. Next-action helpers (`clickNextButton`, `tryNextWithRetry`)
5. Track-state helpers (`ensureTrackBoundaries`, `resetTrackState`)
6. Tick pipeline (`processTick`)
7. Attach/bind/init pipeline

### `popup.html`

Popup UI layout and styling.

Provides:

1. Enable toggle
2. `Skip last` slider (1..30)
3. `Skip first` slider (0..30)
4. Lightweight visual labels for values

### `popup.js`

Popup behavior + storage writes.

Responsibilities:

1. Load current values from `chrome.storage.sync`
2. Update labels during slider drag (`input`)
3. Persist values on commit (`change`)
4. Persist toggle state on change

### `icons/`

Static extension icons required by Chrome:

1. `icon16.png`
2. `icon48.png`
3. `icon128.png`

---

## Storage Keys

The extension uses these sync keys:

1. `enabled` (boolean)
2. `skipEndSeconds` (int, clamped 1..30)
3. `skipStartSeconds` (int, clamped 0..30)

---

## Edge Cases Covered

1. Video/player nodes replaced during SPA navigation
2. Temporary missing metadata (`duration` not finite)
3. Short media segments (ignored with `MIN_TRACK_SEC`)
4. Next button absent/disabled for a moment
5. Settings changed during active playback
6. Extension re-enabled mid-track
7. Manual seeking into or near end-skip zone

---

## Local Run / Test

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this folder (`ytmusic_crossfade`)
5. Open `https://music.youtube.com`
6. Test:
   - natural transitions
   - manual seek near end zone
   - slider value changes during playback
   - multiple consecutive tracks

After code changes:

1. Reload extension in `chrome://extensions`
2. Refresh YouTube Music tab

---

## Known Limitations

1. YouTube Music DOM and labels can change over time.
2. Keyboard fallback behavior may vary by browser/platform policy.
3. Because YouTube Music is a SPA, occasional platform-side timing quirks are possible and are handled via retries/watchdogs.

---

## Quick Maintenance Notes

1. Keep selector list in `clickNextButton()` updated if YT UI changes.
2. Keep state reset logic centralized in `resetTrackState()`.
3. Keep slider commit behavior in popup (`change` writes) to avoid runtime churn.
