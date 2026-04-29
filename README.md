# YT Music Crossfade — Chrome Extension

> Auto-skips the last N seconds of any YouTube Music track and advances to the next one.  
> Manifest V3 · Vanilla JS · No external libraries

---

## Project Structure

```
yt-music-crossfade/
├── manifest.json     ← Extension manifest (MV3)
├── content.js        ← Core logic injected into music.youtube.com
├── popup.html        ← Extension popup UI
├── popup.js          ← Popup logic (reads/writes chrome.storage.sync)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

> **Do you need React / a bundler?**  
> **No.** This is a plain folder with a few files — no `npm init`, no Vite, no webpack.  
> MV3 extensions load raw JS files directly. Only add a build step if you later need TypeScript, module imports, or React in a DevTools panel. For this MVP, a folder + VS Code is all you need.

---

## How It Works

### Core Flow

```
Page loads on music.youtube.com
        │
        ▼
content.js injected by Chrome
        │
        ├─► loadSettings()          ← pull skipSeconds + enabled from chrome.storage.sync
        │
        ├─► startPolling()          ← setInterval every 800ms looking for <video>
        │
        └─► MutationObserver        ← watches entire DOM for SPA navigation changes
                │
                ▼
        findAndAttach()             ← finds <video>, calls attachToVideo()
                │
                ▼
        attachToVideo(video)
        ├── removes old timeupdate listener (if any)
        ├── resets hasSkipped = false
        └── adds:
            ├── timeupdate  → onTimeUpdate()
            ├── emptied     → reset hasSkipped (src changed)
            └── loadedmetadata → reset hasSkipped (new track metadata)
                │
                ▼
        onTimeUpdate()
        ├── guard: enabled && !hasSkipped
        ├── guard: duration >= 15s (skip ads/short clips)
        └── if (duration - currentTime) <= skipBuffer
                └─► hasSkipped = true → clickNext()
```

### Why Each Piece Exists

| Mechanism | Reason |
|---|---|
| `setInterval` poll | `<video>` doesn't exist at script injection time on a SPA |
| `MutationObserver` | SPA navigation swaps `<video>` out without a page reload |
| `hasSkipped` flag | `timeupdate` fires ~4× per second — prevents multiple Next clicks |
| `emptied` + `loadedmetadata` events | Reset the guard when a new track loads into the same `<video>` |
| `MIN_TRACK_SEC = 15` | Prevents misfiring on ad segments or pre-roll clips |
| `chrome.storage.onChanged` listener | Popup writes settings → content script picks them up live, no reload needed |

---

## Step-by-Step Build Plan

### Phase 0 — Folder Setup (5 min)

```bash
mkdir yt-music-crossfade
cd yt-music-crossfade
touch manifest.json content.js popup.html popup.js
mkdir icons
```

Add three placeholder icons (any 16×16, 48×48, 128×128 PNGs) to `icons/`.  
You can generate them quickly with any image editor or use a free icon generator online.

---

### Phase 1 — Load the Extension Unpacked (5 min)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select your `yt-music-crossfade/` folder
4. The extension should appear in the list with no errors
5. Navigate to `https://music.youtube.com` and open DevTools → Console  
   You should see the content script is active (add a `console.log('crossfade loaded')` to verify)

---

### Phase 2 — Core Logic (content.js) (30 min)

**Goals:**
- Find the `<video>` element
- Attach `timeupdate` listener
- Trigger Next button when remaining ≤ `skipBuffer`
- Guard against double-firing

**Key selectors to verify in DevTools:**

```js
// In YTMusic DevTools console:
document.querySelector('video')                           // the player
document.querySelector('button[aria-label="Next"]')      // next track button
```

> ⚠️ YouTube sometimes changes `aria-label` values. If `"Next"` stops working, inspect the button in DevTools and update the selector.

**Test checklist:**
- [ ] Play a track, scrub to 10 seconds before the end — does it auto-advance?
- [ ] Does it only skip once (not repeatedly click Next)?
- [ ] Does it work on the second track after auto-advancing?
- [ ] Does it survive navigating to a different album/playlist?

---

### Phase 3 — Popup UI (popup.html + popup.js) (20 min)

**Goals:**
- Toggle extension on/off
- Slider for skip buffer (1–30 seconds)
- Persist settings via `chrome.storage.sync`

**Flow:**
```
popup.html loads
    → popup.js reads chrome.storage.sync
    → renders current values
    → on change → writes back to chrome.storage.sync
    → content.js hears chrome.storage.onChanged → updates live
```

**Test checklist:**
- [ ] Change skip seconds in popup → play a track → does it skip at the new time?
- [ ] Disable in popup → does the extension stop skipping?
- [ ] Close and reopen Chrome — do settings persist?

---

### Phase 4 — SPA Resilience (15 min)

YouTube Music is a Single Page Application. The `<video>` element can be:
- Replaced entirely when navigating between sections
- Briefly removed and re-added
- Reused with a new `src`

The `MutationObserver` + debounced `findAndAttach()` handles this.  
The `setInterval` poll acts as a fallback.

**Test checklist:**
- [ ] Navigate from Home → Library → an Album — does skipping still work?
- [ ] Use the browser back button — still works?
- [ ] Open YouTube Music in a new tab — fresh attach works?

---

### Phase 5 — Edge Cases & Hardening (15 min)

| Edge Case | How It's Handled |
|---|---|
| No `<video>` on page | Polling retries every 800ms |
| `duration` is `NaN` | Guard in `onTimeUpdate`: `isNaN(video.duration)` check |
| Track shorter than 15s (ad) | `MIN_TRACK_SEC` guard |
| Next button not in DOM | `clickNext()` returns false → resets `hasSkipped` so it retries |
| Settings changed while music plays | `chrome.storage.onChanged` updates values live |
| Extension disabled mid-track | `enabled` check at top of `onTimeUpdate` |

---

### Phase 6 — Icons (10 min)

MV3 requires actual icon files or Chrome will warn on load.

Quick options:
- Use any PNG editor (Figma, Paint, GIMP)
- Or generate programmatically:

```bash
# Using ImageMagick (if installed):
convert -size 128x128 xc:"#ff0033" icons/icon128.png
convert -size 48x48  xc:"#ff0033" icons/icon48.png
convert -size 16x16  xc:"#ff0033" icons/icon16.png
```

---

### Phase 7 — Optional Enhancements

| Feature | Approach |
|---|---|
| Fade audio before skip | Ramp `video.volume` to 0 over N seconds, then click Next, then restore volume |
| Show current track info in popup | `chrome.tabs.sendMessage` → content script returns `video.title` or DOM scrape |
| Per-site enable/disable | Already scoped to `music.youtube.com` via `host_permissions` |
| Keyboard shortcut | Add `commands` to manifest.json + background service worker |
| Publish to Chrome Web Store | Zip the folder, submit at [chromewebstore.google.com](https://chromewebstore.google.com/category/extensions) |

---

## Debugging Tips

```js
// Run in DevTools console on music.youtube.com:

// Check video state
const v = document.querySelector('video');
console.log(v.currentTime, v.duration, v.duration - v.currentTime);

// Manually trigger next
document.querySelector('button[aria-label="Next"]').click();

// Check storage values
chrome.storage.sync.get(null, console.log);
```

**Reload the extension after editing files:**  
`chrome://extensions` → click the refresh (↺) icon on your extension card.  
You also need to refresh the YouTube Music tab.

---

## Known Limitations

- YouTube can silently rename `aria-label` attributes — check this if the Next button stops working after a YouTube update.
- The extension only runs on `music.youtube.com`, not `youtube.com`.
- `chrome.storage.sync` has a 100KB quota — more than enough for these settings.
- MV3 does not support persistent background pages; settings sync relies on `storage.onChanged` and is re-read on each page load.

---

## File Reference

| File | Purpose |
|---|---|
| `manifest.json` | Extension config: permissions, content script, popup, icons |
| `content.js` | Injected into YTMusic; detects video, monitors time, triggers Next |
| `popup.html` | UI shell for the settings popup |
| `popup.js` | Reads/writes `chrome.storage.sync`; live-updates content script |
| `icons/*.png` | Required by Chrome; 16px, 48px, 128px variants |
