/**
 * YT Music Crossfade - content.js v1.4
 *
 * CHANGE (v1.4 — diagnostic pass):
 * maybeTriggerEndSkip() now logs the EXACT reason it exits on every tick
 * when remaining < 15s. This will reveal what's blocking the skip.
 * END-ZONE DIAG interval reduced to 1s for finer resolution.
 * Added state dump on every track RESET so we can see if reset is the culprit.
 */

const DEFAULT_SKIP_END_SEC = 5;
const DEFAULT_SKIP_START_SEC = 0;
const MIN_TRACK_SEC = 15;
const WATCHDOG_MS = 250;
const REBIND_MS = 1000;
const RETRY_DELAY_MS = 200;
const POST_CLICK_CHECK_MS = 500;
const MAX_NEXT_RETRIES = 10;
const END_TRIGGER_EPSILON_SEC = 0.35;
const TRANSITION_LOCK_TIMEOUT_MS = 8000;
const ROLLBACK_THRESHOLD_SEC = 10;
const ENDZONE_DIAG_INTERVAL_SEC = 1;   // 1s resolution in final window
const ENDZONE_DIAG_WINDOW_SEC = 15;    // start logging at 15s remaining

// 0 = off, 1 = key lifecycle events, 2 = every tick (verbose)
const DEBUG_LEVEL = 1;

const settings = {
  skipEndSec: DEFAULT_SKIP_END_SEC,
  skipStartSec: DEFAULT_SKIP_START_SEC,
  enabled: true,
};

const refs = {
  video: null,
  player: null,
  playerBar: null,
  playerObserver: null,
  playerBarObserver: null,
  domObserver: null,
  domDebounce: null,
  watchdogTimer: null,
  rebindTimer: null,
};

const state = {
  trackKey: "",
  introApplied: false,
  endTriggered: false,
  retryTimer: null,
  retryCount: 0,
  lastNextAttemptAt: 0,
  lastPlaybackTime: 0,
  transitioning: false,
  transitionLockTimer: null,
  nextClickedAt: 0,
  endSkipFiredCount: 0,
  lastEndzDiagAt: 0,
  lastGoodDuration: NaN,
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, ...args) {
  if (DEBUG_LEVEL < level) return;
  const ts = new Date().toISOString().split("T")[1].replace("Z", "");
  const prefix = level === 1 ? `[YTM-CF ${ts}]` : `[YTM-CF:v ${ts}]`;
  console.log(prefix, ...args);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function getEffectiveDuration(v) {
  if (!v) return NaN;
  if (Number.isFinite(v.duration) && v.duration > 0) {
    state.lastGoodDuration = v.duration;
    return v.duration;
  }

  // Use last stable duration if raw duration becomes transiently NaN/Infinity.
  if (Number.isFinite(state.lastGoodDuration) && state.lastGoodDuration > 0) {
    return state.lastGoodDuration;
  }

  try {
    if (v.seekable && v.seekable.length > 0) {
      const s = v.seekable.end(v.seekable.length - 1);
      if (Number.isFinite(s) && s > 0) {
        state.lastGoodDuration = s;
        return s;
      }
    }
  } catch (_) {}
  try {
    if (v.buffered && v.buffered.length > 0) {
      const b = v.buffered.end(v.buffered.length - 1);
      if (Number.isFinite(b) && b > 0) {
        state.lastGoodDuration = b;
        return b;
      }
    }
  } catch (_) {}
  return NaN;
}

function loadSettings() {
  chrome.storage.sync.get(
    { skipEndSeconds: DEFAULT_SKIP_END_SEC, skipStartSeconds: DEFAULT_SKIP_START_SEC, enabled: true },
    (items) => {
      settings.skipEndSec = clampInt(items.skipEndSeconds, 1, 30, DEFAULT_SKIP_END_SEC);
      settings.skipStartSec = clampInt(items.skipStartSeconds, 0, 30, DEFAULT_SKIP_START_SEC);
      settings.enabled = !!items.enabled;
      log(1, "settings loaded", { ...settings });
    }
  );
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.skipEndSeconds) {
    settings.skipEndSec = clampInt(changes.skipEndSeconds.newValue, 1, 30, DEFAULT_SKIP_END_SEC);
    state.endTriggered = false;
  }
  if (changes.skipStartSeconds) {
    settings.skipStartSec = clampInt(changes.skipStartSeconds.newValue, 0, 30, DEFAULT_SKIP_START_SEC);
    state.introApplied = false;
  }
  if (changes.enabled) {
    settings.enabled = !!changes.enabled.newValue;
    if (settings.enabled) {
      state.endTriggered = false;
      state.introApplied = false;
      clearTransitionLock("settings-re-enable");
      clearRetry();
    }
  }
  log(1, "settings changed", { ...settings });
  processTick("settings-change");
});

// ---------------------------------------------------------------------------
// Retry / transition lock
// ---------------------------------------------------------------------------

function clearRetry() {
  if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
  state.retryCount = 0;
}

function setTransitionLock(reason) {
  state.transitioning = true;
  log(1, "transition lock SET", reason);
  clearTransitionLockTimer();
  state.transitionLockTimer = setTimeout(() => {
    log(1, "transition lock EXPIRED (safety release)");
    clearTransitionLock("timeout");
    state.endTriggered = false;
  }, TRANSITION_LOCK_TIMEOUT_MS);
}

function clearTransitionLock(reason) {
  if (state.transitioning) log(1, "transition lock CLEARED", reason);
  state.transitioning = false;
  clearTransitionLockTimer();
}

function clearTransitionLockTimer() {
  if (state.transitionLockTimer) { clearTimeout(state.transitionLockTimer); state.transitionLockTimer = null; }
}

// ---------------------------------------------------------------------------
// Track key
// ---------------------------------------------------------------------------

function getTrackTitle() {
  return document.querySelector("ytmusic-player-bar .title.ytmusic-player-bar")?.textContent?.trim()
    || document.querySelector(".content-info-wrapper .title")?.textContent?.trim()
    || "";
}

function getTrackKey() {
  const barId = refs.playerBar?.getAttribute("video-id")
    || document.querySelector("ytmusic-player-bar")?.getAttribute("video-id") || "";
  if (barId) return `id:${barId}`;

  const playerId = refs.player?.getAttribute("video-id")
    || document.querySelector("ytmusic-player")?.getAttribute("video-id") || "";
  if (playerId) return `id:${playerId}`;

  // Avoid URL-based key while a track is actively playing because YT Music can
  // update the URL to the upcoming track before audible transition.
  if (!refs.video || refs.video.currentTime < 1.0 || refs.video.paused) {
    try {
      const vParam = new URL(location.href).searchParams.get("v");
      if (vParam) return `url:${vParam}`;
    } catch (_) {}
  }

  const src = refs.video?.currentSrc || "";
  if (src) return `src:${src}`;
  return "";
}

// ---------------------------------------------------------------------------
// Track state
// ---------------------------------------------------------------------------

function resetTrackState(newTrackKey, reason) {
  const prevKey = state.trackKey;
  state.trackKey = newTrackKey || "";
  state.introApplied = false;
  state.endTriggered = false;
  state.lastPlaybackTime = 0;
  state.lastEndzDiagAt = 0;
  state.lastGoodDuration = NaN;
  clearRetry();
  clearTransitionLock("track-reset");
  log(1, "track RESET", {
    reason,
    prev: prevKey || null,
    next: state.trackKey || null,
    title: getTrackTitle(),
    endSkipFiredTotal: state.endSkipFiredCount,
    // Extra: show video state at reset time for diagnostics
    videoTime: refs.video ? refs.video.currentTime.toFixed(2) : "no-video",
    videoDurRaw: refs.video ? refs.video.duration : "no-video",
  });
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function getPlayerEl()    { return document.querySelector("ytmusic-player"); }
function getPlayerBarEl() { return document.querySelector("ytmusic-player-bar"); }
function getVideoEl()     { return document.querySelector("video"); }

// ---------------------------------------------------------------------------
// Next-button
// ---------------------------------------------------------------------------

function clickNextButton() {
  const selectors = [
    "ytmusic-player-bar tp-yt-paper-icon-button.next-button",
    "ytmusic-player-bar .next-button",
    "ytmusic-player-bar button[aria-label*='Next']",
    "ytmusic-player-bar button[title*='Next']",
    "ytmusic-player-bar tp-yt-paper-icon-button[aria-label*='Next']",
    "ytmusic-player-bar tp-yt-paper-icon-button[title*='Next']",
    "tp-yt-paper-icon-button.next-button",
    ".next-button",
    "button[aria-label*='Next']",
    "button[title*='Next']",
  ];

  for (const sel of selectors) {
    const hit = document.querySelector(sel);
    if (!hit) continue;
    const btn = hit.matches("button, tp-yt-paper-icon-button")
      ? hit : hit.closest("button, tp-yt-paper-icon-button");
    if (!btn) continue;
    if (!btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      log(1, "next CLICKED:", sel);
      return true;
    }
  }

  log(1, "next button not found — keyboard fallback");
  try {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", shiftKey: true, bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "MediaTrackNext", code: "MediaTrackNext", bubbles: true, cancelable: true }));
  } catch (_) {}
  return false;
}

// ---------------------------------------------------------------------------
// Retry engine
// ---------------------------------------------------------------------------

function tryNextWithRetry(reason) {
  if (state.transitioning) { log(2, "retry skipped — transitioning"); return; }
  const now = Date.now();
  if (now - state.lastNextAttemptAt < 80) return;
  state.lastNextAttemptAt = now;

  if (state.retryCount >= MAX_NEXT_RETRIES) {
    log(1, "retries EXHAUSTED — transition lock", reason);
    setTransitionLock("retry-exhausted");
    clearRetry();
    return;
  }

  state.retryCount += 1;
  const clicked = clickNextButton();
  log(1, `retry attempt #${state.retryCount}`, { reason, clicked });

  if (clicked) { state.nextClickedAt = Date.now(); setTransitionLock("next-clicked"); }

  state.retryTimer = setTimeout(() => {
    if (!state.endTriggered || !state.transitioning) { clearRetry(); return; }
    tryNextWithRetry(clicked ? "post-click-check" : "retry");
  }, clicked ? POST_CLICK_CHECK_MS : RETRY_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Track boundary detection
// ---------------------------------------------------------------------------

function ensureTrackBoundaries(source) {
  const key = getTrackKey();
  if (!key) return;
  if (key !== state.trackKey) resetTrackState(key, source);
}

// ---------------------------------------------------------------------------
// Intro skip
// ---------------------------------------------------------------------------

function maybeApplyIntroSkip() {
  if (!settings.enabled || settings.skipStartSec <= 0 || state.introApplied) return;
  const v = refs.video;
  const dur = getEffectiveDuration(v);
  if (!v || !Number.isFinite(dur) || dur < MIN_TRACK_SEC) return;
  const target = Math.min(settings.skipStartSec, Math.max(0, dur - 1));
  if (target <= 0) { state.introApplied = true; return; }
  if (v.currentTime < target - 0.05) {
    log(1, "intro skip APPLIED", { from: v.currentTime.toFixed(2), to: target });
    v.currentTime = target;
  }
  state.introApplied = true;
}

// ---------------------------------------------------------------------------
// End skip — with per-tick exit reason logging near end of track
// ---------------------------------------------------------------------------

function maybeTriggerEndSkip() {
  const v = refs.video;
  const dur = v ? getEffectiveDuration(v) : NaN;
  const nowSec = v ? v.currentTime : 0;
  const remaining = Number.isFinite(dur) ? dur - nowSec : Infinity;
  const threshold = settings.skipEndSec + END_TRIGGER_EPSILON_SEC;
  const nearEnd = remaining < ENDZONE_DIAG_WINDOW_SEC;

  // --- Per-tick exit reason logging when near end ---
  if (nearEnd) {
    const diagNow = Date.now();
    const diagDue = diagNow - state.lastEndzDiagAt > ENDZONE_DIAG_INTERVAL_SEC * 1000;

    if (diagDue) {
      state.lastEndzDiagAt = diagNow;

      // Check each guard and report why we'd exit
      let blockReason = null;
      if (!settings.enabled)    blockReason = "DISABLED";
      else if (state.endTriggered)   blockReason = "already-triggered";
      else if (state.transitioning)  blockReason = "transitioning";
      else if (!v)                   blockReason = "no-video";
      else if (!Number.isFinite(dur)) blockReason = `bad-duration(${v.duration})`;
      else if (dur < MIN_TRACK_SEC)  blockReason = `duration-too-short(${dur})`;
      else if (remaining > threshold) blockReason = `not-in-zone(remaining=${remaining.toFixed(2)},threshold=${threshold.toFixed(2)})`;
      else if (remaining <= -0.5)    blockReason = "past-end";

      log(1, blockReason ? `END-SKIP BLOCKED [${blockReason}]` : "END-ZONE DIAG (approaching threshold)", {
        title: getTrackTitle(),
        currentTime: nowSec.toFixed(2),
        duration_raw: v?.duration,
        duration_eff: Number.isFinite(dur) ? dur.toFixed(2) : "NaN",
        remaining: Number.isFinite(remaining) ? remaining.toFixed(2) : "Inf",
        threshold: threshold.toFixed(2),
        endTriggered: state.endTriggered,
        transitioning: state.transitioning,
        trackKey: state.trackKey,
        seekableLen: v?.seekable?.length,
        seekableEnd: (() => { try { return v?.seekable?.length > 0 ? v.seekable.end(v.seekable.length-1).toFixed(2) : "n/a"; } catch(e) { return "err"; } })(),
      });
    }
  }

  // --- Actual guards ---
  if (!settings.enabled || state.endTriggered || state.transitioning) return;
  if (!v || !Number.isFinite(dur) || dur < MIN_TRACK_SEC) return;
  if (remaining <= threshold && remaining > -0.5) {
    state.endTriggered = true;
    state.endSkipFiredCount += 1;
    log(1, "end-skip TRIGGERED ✓", {
      title: getTrackTitle(),
      track: state.trackKey,
      currentTime: nowSec.toFixed(2),
      duration_raw: v.duration,
      duration_eff: dur.toFixed(2),
      remaining: remaining.toFixed(2),
      threshold: threshold.toFixed(2),
      totalFired: state.endSkipFiredCount,
    });
    tryNextWithRetry("threshold");
  }
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

function processTick(source) {
  if (!refs.video || !settings.enabled) return;
  const v = refs.video;

  if (!v.paused && state.lastPlaybackTime > 0 && v.currentTime + ROLLBACK_THRESHOLD_SEC < state.lastPlaybackTime) {
    log(1, "rollback detected", { from: state.lastPlaybackTime.toFixed(2), to: v.currentTime.toFixed(2) });
    resetTrackState(state.trackKey, "time-rollback");
  }

  ensureTrackBoundaries(source);
  maybeApplyIntroSkip();
  maybeTriggerEndSkip();
  if (!v.paused) state.lastPlaybackTime = v.currentTime;

  log(2, "tick", {
    src: source, key: state.trackKey,
    t: v.currentTime.toFixed(2),
    dur: (() => { const d = getEffectiveDuration(v); return Number.isFinite(d) ? d.toFixed(2) : `inf/nan(raw:${v.duration})`; })(),
    end: state.endTriggered, tx: state.transitioning,
  });
}

// ---------------------------------------------------------------------------
// Video event handlers
// ---------------------------------------------------------------------------

function onVideoTimeUpdate()    { processTick("timeupdate"); }
function onVideoSeeking()       { processTick("seeking"); }
function onVideoSeeked()        { processTick("seeked"); }

function onVideoLoadedMetadata() {
  const v = refs.video;
  const dur = getEffectiveDuration(v);
  log(1, "loadedmetadata", { duration_raw: v?.duration, duration_eff: Number.isFinite(dur) ? dur.toFixed(2) : "NaN", key: getTrackKey() });
  ensureTrackBoundaries("loadedmetadata");
  processTick("loadedmetadata");
}

function onVideoEnded() {
  log(1, "video ENDED", { endTriggered: state.endTriggered, track: state.trackKey });
  if (!settings.enabled || state.endTriggered) return;
  state.endTriggered = true;
  state.endSkipFiredCount += 1;
  tryNextWithRetry("ended-fallback");
}

function onVideoPlay() {
  log(1, "video play", { t: refs.video?.currentTime?.toFixed(2), track: state.trackKey });
  if (state.transitioning) ensureTrackBoundaries("play-during-transition");
}

function onVideoLoadStart() {
  log(1, "loadstart", { src: refs.video?.currentSrc?.slice(0, 80), key: state.trackKey });
  ensureTrackBoundaries("loadstart");
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

function attachVideo(videoEl) {
  if (refs.video === videoEl) return;
  if (refs.video) {
    ["timeupdate","loadedmetadata","seeking","seeked","ended","play","loadstart"]
      .forEach(e => refs.video.removeEventListener(e, {
        timeupdate: onVideoTimeUpdate, loadedmetadata: onVideoLoadedMetadata,
        seeking: onVideoSeeking, seeked: onVideoSeeked, ended: onVideoEnded,
        play: onVideoPlay, loadstart: onVideoLoadStart,
      }[e]));
    log(1, "video DETACHED");
  }
  refs.video = videoEl;
  if (!refs.video) return;
  refs.video.addEventListener("timeupdate",    onVideoTimeUpdate);
  refs.video.addEventListener("loadedmetadata",onVideoLoadedMetadata);
  refs.video.addEventListener("seeking",       onVideoSeeking);
  refs.video.addEventListener("seeked",        onVideoSeeked);
  refs.video.addEventListener("ended",         onVideoEnded);
  refs.video.addEventListener("play",          onVideoPlay);
  refs.video.addEventListener("loadstart",     onVideoLoadStart);
  ensureTrackBoundaries("attach-video");
  processTick("attach-video");
  log(1, "video ATTACHED");
}

function attachPlayerBar(playerBarEl) {
  if (refs.playerBar === playerBarEl) return;
  if (refs.playerBarObserver) { refs.playerBarObserver.disconnect(); refs.playerBarObserver = null; }
  refs.playerBar = playerBarEl;
  if (!refs.playerBar) return;
  refs.playerBarObserver = new MutationObserver(() => {
    log(1, "player-bar video-id →", refs.playerBar.getAttribute("video-id"), "|", getTrackTitle());
    ensureTrackBoundaries("player-bar-mutation");
    processTick("player-bar-mutation");
  });
  refs.playerBarObserver.observe(refs.playerBar, { attributes: true, attributeFilter: ["video-id"] });
  ensureTrackBoundaries("attach-player-bar");
  log(1, "player-bar ATTACHED, video-id:", refs.playerBar.getAttribute("video-id"));
}

function attachPlayer(playerEl) {
  if (refs.player === playerEl) return;
  if (refs.playerObserver) { refs.playerObserver.disconnect(); refs.playerObserver = null; }
  refs.player = playerEl;
  if (!refs.player) return;
  refs.playerObserver = new MutationObserver(() => {
    ensureTrackBoundaries("player-mutation");
    processTick("player-mutation");
  });
  refs.playerObserver.observe(refs.player, { attributes: true, attributeFilter: ["video-id"] });
  ensureTrackBoundaries("attach-player");
  log(1, "player ATTACHED, video-id:", refs.player.getAttribute("video-id"));
}

// ---------------------------------------------------------------------------
// Bind / init
// ---------------------------------------------------------------------------

function bindRefs() {
  attachPlayerBar(getPlayerBarEl());
  attachPlayer(getPlayerEl());
  attachVideo(getVideoEl());
}

function scheduleBindRefs() {
  if (refs.domDebounce) clearTimeout(refs.domDebounce);
  refs.domDebounce = setTimeout(() => { bindRefs(); processTick("dom-mutation"); }, 120);
}

function initDomObserver() {
  refs.domObserver = new MutationObserver(() => scheduleBindRefs());
  refs.domObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function initTimers() {
  refs.watchdogTimer = setInterval(() => { bindRefs(); processTick("watchdog"); }, WATCHDOG_MS);
  refs.rebindTimer = setInterval(() => bindRefs(), REBIND_MS);
}

function init() {
  loadSettings();
  bindRefs();
  initDomObserver();
  initTimers();
  log(1, "content script started v1.4 — DEBUG_LEVEL=" + DEBUG_LEVEL);
}

init();
