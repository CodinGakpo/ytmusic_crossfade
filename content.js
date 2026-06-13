/**
 * YT Music Crossfade - content.js v2.7
 * - startup grace: ignores src changes in first 4s of a track (initial blob attach)
 * - rebuffer guard: src changes mid-track (CDN rebuffer) no longer reset state
 * - preload guard: ignores early DOM video-id updates from YT prefetch
 * - dual-source remaining time: DOM progress bar + video element cross-check
 * - wall-clock extrapolation: fires end-skip even when YT freezes timeupdate
 * - crash isolation: all observer callbacks and processTick are try/catch wrapped
 * - duration preservation: lastGoodDuration survives track resets
 */

const DEFAULT_SKIP_END_SEC = 5;
const DEFAULT_SKIP_START_SEC = 0;
const MIN_TRACK_SEC = 15;

const WATCHDOG_MS = 250;
const REBIND_MS = 1000;
const RETRY_DELAY_MS = 220;
const MAX_NEXT_RETRIES = 12;
const END_TRIGGER_EPSILON_SEC = 0.35;
const ROLLBACK_NEW_TRACK_SEC = 12;

// YT Music preloads the next track's video-id in the DOM ~10s before the
// actual media transition. We ignore DOM video-id changes that happen while
// the video is still playing well past the start of the track.
// A real transition is confirmed by: currentTime rolling back close to 0
// OR currentSrc changing to a meaningfully different URL.
const PRELOAD_GUARD_MIN_TIME_SEC = 8;  // currentTime must be < this to accept id change as real
const SRC_CHANGE_DEBOUNCE_MS    = 400; // wait this long after src change before trusting it

// Ignore src changes that happen within this many seconds of a track starting.
// YT Music assigns the blob URL to currentSrc right at load time — this is not
// a transition, it's just the initial stream attachment.
const SRC_CHANGE_STARTUP_GRACE_SEC = 4;

// YT Music's internal player clock (shown in the progress bar) can diverge
// from video.currentTime by several seconds. We read both and use whichever
// suggests we're closer to the end — erring on the side of triggering early
// rather than missing the window entirely.
const DOM_TIME_MAX_DIVERGENCE_SEC = 15; // if DOM and video times differ by more than this, distrust DOM

// 0 off, 1 lifecycle, 2 verbose
const DEBUG_LEVEL = 0;

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
  pendingTrackKey: "",
  pendingTrackSeen: 0,
  lastNearEndLogBucket: null,
  introApplied: false,
  endTriggered: false,
  lastPlaybackTime: 0,
  lastGoodDuration: NaN,

  // Wall-clock stall detection: when video.currentTime stops advancing
  // (YT Music freezes timeupdate near end of short tracks), we extrapolate
  // using real elapsed wall time so the end-skip still fires.
  lastObservedCT: NaN,       // last video.currentTime we saw advance
  lastObservedCTAt: 0,       // Date.now() when we saw that value
  lastObservedPlaybackRate: 1,

  // Tracks the actual <video>.currentSrc so we can detect real media swaps
  // independently of DOM video-id attribute changes (which YT preloads early).
  activeSrc: "",
  srcChangedAt: 0,  // timestamp when currentSrc last changed

  nextActive: false,
  nextAttempts: 0,
  hasClickedNext: false,
  nextTimer: null,
  nextBaselineTrackKey: "",
  nextBaselineTime: 0,

  lastDomCT: NaN,
  lastTickLogSec: 0,

  seeking: false,
  seekGraceUntil: 0,
};

function log(level, ...args) {
  if (DEBUG_LEVEL < level) return;
  const ts = new Date().toISOString().split("T")[1].replace("Z", "");
  const p = level === 1 ? `[YTM-CF ${ts}]` : `[YTM-CF:v ${ts}]`;
  console.log(p, ...args);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function getPlayerEl() {
  return document.querySelector("ytmusic-player");
}

function getPlayerBarEl() {
  return document.querySelector("ytmusic-player-bar");
}

function getVideoEl() {
  return document.querySelector("video");
}

function getTrackTitle() {
  const t1 = document.querySelector("ytmusic-player-bar .title.ytmusic-player-bar")?.textContent?.trim();
  if (t1) return t1;
  const t2 = document.querySelector(".content-info-wrapper .title")?.textContent?.trim();
  return t2 || "";
}

function getTrackArtist() {
  const a1 = document.querySelector("ytmusic-player-bar .byline.ytmusic-player-bar")?.textContent?.trim();
  if (a1) return a1;
  const a2 = document.querySelector(".content-info-wrapper .subtitle")?.textContent?.trim();
  return a2 || "";
}

function normalizeMeta(text) {
  return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function extractVideoIdFromHref(href) {
  if (!href) return "";
  try {
    const url = new URL(href, location.origin);
    if (url.hostname !== "music.youtube.com") return "";
    return url.searchParams.get("v") || "";
  } catch (_) {
    return "";
  }
}

function getEffectiveDuration(v) {
  if (!v) return NaN;

  if (Number.isFinite(v.duration) && v.duration > 0) {
    state.lastGoodDuration = v.duration;
    return v.duration;
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

  if (Number.isFinite(state.lastGoodDuration) && state.lastGoodDuration > 0) {
    return state.lastGoodDuration;
  }

  return NaN;
}

function getTrackKey() {
  // Strongest signals first
  const barId = refs.playerBar?.getAttribute("video-id") || document.querySelector("ytmusic-player-bar")?.getAttribute("video-id") || "";
  if (barId) return `id:${barId}`;

  const playerId = refs.player?.getAttribute("video-id") || document.querySelector("ytmusic-player")?.getAttribute("video-id") || "";
  if (playerId) return `id:${playerId}`;

  // Player bar often has a watch link even when video-id attributes are null.
  const barHrefId = extractVideoIdFromHref(
    refs.playerBar?.querySelector("a[href*='watch?v=']")?.getAttribute("href") ||
      document.querySelector("ytmusic-player-bar a[href*='watch?v=']")?.getAttribute("href") ||
      ""
  );
  if (barHrefId) return `id:${barHrefId}`;

  // Last fallback
  const src = refs.video?.currentSrc || "";
  if (src) return `src:${src}`;

  // Metadata fallback for edge layouts where ids/src are temporarily unavailable.
  const title = normalizeMeta(getTrackTitle());
  const artist = normalizeMeta(getTrackArtist());
  if (title || artist) return `meta:${title}|${artist}`;

  // URL id is useful, but can lag behind real media transitions.
  const pageId = new URLSearchParams(location.search).get("v") || "";
  if (pageId) return `id:${pageId}`;

  return "";
}

function clearTimer(name) {
  if (state[name]) {
    clearTimeout(state[name]);
    state[name] = null;
  }
}

function stopNextOperation(reason) {
  if (state.nextActive) log(1, "next-op stop", reason);
  state.nextActive = false;
  state.nextAttempts = 0;
  state.hasClickedNext = false;
  state.nextBaselineTrackKey = "";
  state.nextBaselineTime = 0;
  clearTimer("nextTimer");
}

function resetTrackState(newKey, reason) {
  const prev = state.trackKey;
  state.trackKey = newKey || "";
  state.pendingTrackKey = "";
  state.pendingTrackSeen = 0;
  state.lastNearEndLogBucket = null;
  state.introApplied = false;
  state.endTriggered = false;
  state.lastPlaybackTime = 0;
  // Intentionally NOT clearing lastGoodDuration — if the src-swap fires
  // before new metadata arrives, we still need a valid duration to compute
  // remaining time and fire end-skip. It will be overwritten naturally on
  // the next durationchange / loadedmetadata event.

  // Refresh activeSrc from the live video element so the next transition
  // is measured against the new stream's src, not the previous track's.
  state.activeSrc = refs.video?.currentSrc || "";
  state.srcChangedAt = 0;
  state.lastDomCT = NaN;

  // Seed the wall-clock anchor immediately from whatever currentTime is
  // available right now. This matters when YT has already frozen timeupdate
  // before the reset fires — without seeding here, the stall detector would
  // never get an anchor and extrapolation would never start.
  const v = refs.video;
  if (v && Number.isFinite(v.currentTime)) {
    state.lastObservedCT = v.currentTime;
    state.lastObservedCTAt = Date.now();
    state.lastObservedPlaybackRate = v.playbackRate || 1;
  } else {
    state.lastObservedCT = NaN;
    state.lastObservedCTAt = 0;
    state.lastObservedPlaybackRate = 1;
  }

  stopNextOperation("track-reset");
  log(1, "track reset", { reason, prev: prev || null, next: state.trackKey || null, title: getTrackTitle() });
}

/**
 * Check whether the <video> element has actually swapped its media stream.
 * YT Music updates the DOM video-id ~10 s early (preload), but currentSrc
 * only changes when the new stream really starts.  We track the last known
 * src and only acknowledge a real transition when:
 *   (a) currentSrc changed AND debounce period has elapsed, OR
 *   (b) currentTime rolled back close to 0 (natural transition by time).
 *
 * Returns true when a real media transition was just detected (and updates
 * state.activeSrc accordingly).
 */
function checkRealMediaTransition() {
  const v = refs.video;
  if (!v) return false;

  const src = v.currentSrc || "";
  const now = Date.now();

  // Detect src change
  if (src && src !== state.activeSrc) {
    const prevSrc = state.activeSrc;
    state.activeSrc = src;

    // Case 1: first-ever src assignment (activeSrc was ""). This is just YT
    // attaching the initial stream — never a real transition.
    if (!prevSrc) {
      log(2, "src init (ignored)", { src: src.slice(-50) });
      return false;
    }

    state.srcChangedAt = now;
    log(1, "src changed", { src: src.slice(-60) });

    // Case 2: startup grace — src changed but we're still within the first few
    // seconds of the track. YT often swaps blob URLs during initial buffering.
    const ct = v.currentTime;
    if (Number.isFinite(ct) && ct < SRC_CHANGE_STARTUP_GRACE_SEC) {
      log(1, "src-swap suppressed (startup grace)", {
        ct: Number(ct.toFixed(2)), grace: SRC_CHANGE_STARTUP_GRACE_SEC,
      });
      return false;
    }

    // Case 3: rebuffer guard — src changed but playback is well underway.
    // YT swaps CDN segments mid-track without changing the actual song.
    if (Number.isFinite(ct) && ct >= PRELOAD_GUARD_MIN_TIME_SEC) {
      log(1, "src-swap suppressed (rebuffer guard)", {
        ct: Number(ct.toFixed(2)), minForReal: PRELOAD_GUARD_MIN_TIME_SEC,
      });
      return false;
    }

    // Don't commit immediately — wait for debounce
    return false;
  }

  // Debounce has elapsed since src changed → real transition
  if (state.srcChangedAt > 0 && now - state.srcChangedAt >= SRC_CHANGE_DEBOUNCE_MS) {
    if (state.srcChangedAt !== -1) {
      state.srcChangedAt = -1; // sentinel: transition already reported
      return true;
    }
  }

  return false;
}

function ensureTrackBoundaries(source) {
  const key = getTrackKey();
  if (!key) return;

  // Always check for a real media swap first — this is the ground-truth signal.
  const realTransition = checkRealMediaTransition();
  if (realTransition) {
    resetTrackState(key, `${source}:src-swap`);
    return;
  }

  // Detect DOM time rollback (gapless playback transition)
  const domCT = getDomElapsedSec();
  if (Number.isFinite(domCT)) {
    if (state.lastDomCT > 10 && domCT < 5) {
      resetTrackState(key, `${source}:dom-time-rollback`);
      state.lastDomCT = domCT;
      return;
    }
    state.lastDomCT = domCT;
  }

  if (!state.trackKey) {
    resetTrackState(key, `${source}:init`);
    return;
  }

  if (key === state.trackKey) {
    state.pendingTrackKey = "";
    state.pendingTrackSeen = 0;
    return;
  }

  // ----- ID-based change: could be real OR preload -----
  if (key.startsWith("id:")) {
    const v = refs.video;
    const { ct } = getBestTimeEstimate(v);

    // PRELOAD GUARD: YT Music preloads the next song's DOM elements early.
    // We only accept an ID change as a real track boundary if the video has
    // actually started playing from the beginning (ct < 2).
    // Otherwise, we wait for a real src-swap or time-rollback.
    if (Number.isFinite(ct) && ct >= 2) {
      log(2, "id-change suppressed (not at start of track)", {
        source, from: state.trackKey, to: key, ct: Number(ct.toFixed(2))
      });
      return;
    }

    // currentTime is near zero: real switch.
    resetTrackState(key, `${source}:id-switch`);
    return;
  }

  // ----- Downgrade from id-key to weaker signal -----
  if (state.trackKey.startsWith("id:")) {
    const v = refs.video;
    const likelyTransitionByTime =
      !!v &&
      Number.isFinite(v.currentTime) &&
      Number.isFinite(state.lastPlaybackTime) &&
      state.lastPlaybackTime > 20 &&
      v.currentTime < PRELOAD_GUARD_MIN_TIME_SEC &&
      v.currentTime + ROLLBACK_NEW_TRACK_SEC < state.lastPlaybackTime;

    if (likelyTransitionByTime) {
      resetTrackState(key, `${source}:fallback-switch`);
    }
    return;
  }

  // ----- Weaker fallbacks (meta/src): require two consecutive ticks -----
  if (state.pendingTrackKey !== key) {
    state.pendingTrackKey = key;
    state.pendingTrackSeen = 1;
    log(2, "track-key pending", { source, from: state.trackKey, to: key });
    return;
  }

  state.pendingTrackSeen += 1;
  if (state.pendingTrackSeen >= 2) {
    resetTrackState(key, `${source}:confirmed`);
  }
}

function clickNextButton() {
  const selectors = [
    "ytmusic-player-bar tp-yt-paper-icon-button.next-button",
    "ytmusic-player-bar button.next-button",
    "ytmusic-player-bar .next-button",
    "ytmusic-player-bar button[aria-label*='Next']",
    "ytmusic-player-bar button[title*='Next']",
    "ytmusic-player-bar tp-yt-paper-icon-button[aria-label*='Next']",
    "ytmusic-player-bar tp-yt-paper-icon-button[title*='Next']",
    "tp-yt-paper-icon-button.next-button",
    "button.next-button",
    "button[aria-label*='Next']",
    "button[title*='Next']",
  ];

  for (const sel of selectors) {
    const hit = document.querySelector(sel);
    if (!hit) continue;

    const btn = hit.matches("button, tp-yt-paper-icon-button")
      ? hit
      : hit.closest("button, tp-yt-paper-icon-button");
    if (!btn) continue;

    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;

    btn.click();
    log(1, "next clicked", sel);
    return true;
  }

  try {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "n",
      code: "KeyN",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "MediaTrackNext",
      code: "MediaTrackNext",
      bubbles: true,
      cancelable: true,
    }));
    log(1, "next keyboard fallback dispatched");
  } catch (_) {}

  return false;
}

function transitionDetected() {
  const v = refs.video;
  if (!v) return false;

  const { ct } = getBestTimeEstimate(v);

  // Has the video rolled back to the beginning?
  if (ct + 5 < state.nextBaselineTime) return true;

  // Has the video source changed?
  if (state.activeSrc && v.currentSrc && state.activeSrc !== v.currentSrc) return true;

  return false;
}

function nextAttempt(reason) {
  if (!state.nextActive) return;
  if (!settings.enabled) {
    stopNextOperation("disabled");
    return;
  }

  ensureTrackBoundaries("next-attempt");

  if (transitionDetected()) {
    resetTrackState(getTrackKey() || state.trackKey, "next-transition-detected");
    stopNextOperation("transition-detected");
    return;
  }

  if (state.nextAttempts >= MAX_NEXT_RETRIES) {
    log(1, "next retries exhausted", reason);
    state.endTriggered = false;
    stopNextOperation("retry-exhausted");
    return;
  }

  state.nextAttempts += 1;
  let clicked = false;
  if (!state.hasClickedNext) {
    clicked = clickNextButton();
    if (clicked) {
      state.hasClickedNext = true;
    }
  }
  
  log(1, `next attempt #${state.nextAttempts}`, { reason, clicked, hasClicked: state.hasClickedNext, track: state.trackKey });

  state.nextTimer = setTimeout(() => {
    nextAttempt(clicked ? "post-click-check" : "retry");
  }, clicked ? 500 : RETRY_DELAY_MS);
}

function startNextOperation(reason) {
  if (state.nextActive) return;
  const v = refs.video;
  const { ct } = getBestTimeEstimate(v);
  state.nextActive = true;
  state.nextAttempts = 0;
  state.hasClickedNext = false;
  state.nextBaselineTrackKey = state.trackKey;
  state.nextBaselineTime = ct;
  log(1, "next-op start", {
    reason,
    baselineTrack: state.nextBaselineTrackKey,
    baselineTime: Number(state.nextBaselineTime.toFixed(2)),
  });
  nextAttempt(reason);
}

function triggerEndSkip(reason) {
  if (state.endTriggered) return;
  state.endTriggered = true;
  log(1, "end skip triggered", { reason, track: state.trackKey, title: getTrackTitle() });
  startNextOperation(reason);
}

function maybeApplyIntroSkip() {
  if (!settings.enabled || settings.skipStartSec <= 0 || state.introApplied) return;

  const v = refs.video;
  const { ct, dur } = getBestTimeEstimate(v);
  if (!Number.isFinite(dur) || dur < MIN_TRACK_SEC) return;

  const target = Math.min(settings.skipStartSec, Math.max(0, dur - 1));
  if (target <= 0) {
    state.introApplied = true;
    return;
  }

  if (ct > target + 5) {
    return;
  }

  if (ct < target - 0.05) {
    const rawCT = v.currentTime;
    let seekTo = target;
    // Apply offset for gapless playback scenarios
    if (Math.abs(rawCT - ct) > 5) {
      seekTo = target + (rawCT - ct);
    }
    const fromRaw = v.currentTime;
    v.currentTime = seekTo;
    log(1, "intro skip applied", { fromCT: Number(ct.toFixed(2)), toCT: target, fromRaw: Number(fromRaw.toFixed(2)), rawSeek: Number(seekTo.toFixed(2)) });
    state.introApplied = true;
  } else if (ct >= target - 0.05) {
    state.introApplied = true;
  }
}

/**
 * Parse a "M:SS" or "H:MM:SS" time string to seconds.
 */
function parseTimeStr(str) {
  if (!str) return NaN;
  const parts = str.trim().split(":").map(Number);
  if (parts.some(isNaN)) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

/**
 * Read the current elapsed time directly from YT Music's progress bar DOM.
 * YT Music updates this on its own schedule and is the authoritative display.
 * Returns NaN if not readable.
 *
 * Selectors tried (YT Music has changed these over time):
 *   - .time-info  (most common: "1:23 / 3:45")
 *   - .ytmusic-player-bar span[class*="time"]
 *   - tp-yt-paper-slider progress time text nodes
 */
function getDomElapsedSec() {
  // Primary: .time-info contains "elapsed / total"
  const timeInfo = document.querySelector(
    "ytmusic-player-bar .time-info, " +
    "ytmusic-player-bar #left-controls .time-info, " +
    ".ytmusic-player-bar .time-info"
  );
  if (timeInfo) {
    const text = timeInfo.textContent || "";
    // Format: "1:56 / 1:57" or "1:56/ 1:57"
    const slashIdx = text.indexOf("/");
    if (slashIdx !== -1) {
      const elapsed = parseTimeStr(text.slice(0, slashIdx));
      if (Number.isFinite(elapsed)) return elapsed;
    }
  }

  // Fallback: separate elapsed/duration spans
  const elapsedEl = document.querySelector(
    "ytmusic-player-bar .elapsed-time, " +
    "ytmusic-player-bar [class*='elapsed'], " +
    "ytmusic-player-bar span.time-current"
  );
  if (elapsedEl) {
    const elapsed = parseTimeStr(elapsedEl.textContent);
    if (Number.isFinite(elapsed)) return elapsed;
  }

  return NaN;
}

/**
 * Read total duration from YT Music's progress bar DOM.
 * Returns NaN if not readable.
 */
function getDomDurationSec() {
  const timeInfo = document.querySelector(
    "ytmusic-player-bar .time-info, " +
    "ytmusic-player-bar #left-controls .time-info, " +
    ".ytmusic-player-bar .time-info"
  );
  if (timeInfo) {
    const text = timeInfo.textContent || "";
    const slashIdx = text.indexOf("/");
    if (slashIdx !== -1) {
      const dur = parseTimeStr(text.slice(slashIdx + 1));
      if (Number.isFinite(dur) && dur > 0) return dur;
    }
  }

  const durationEl = document.querySelector(
    "ytmusic-player-bar .duration, " +
    "ytmusic-player-bar [class*='duration'], " +
    "ytmusic-player-bar span.time-duration"
  );
  if (durationEl) {
    const dur = parseTimeStr(durationEl.textContent);
    if (Number.isFinite(dur) && dur > 0) return dur;
  }

  return NaN;
}

/**
 * Get the best estimate of (currentTime, duration, remaining) by cross-checking
 * video element values, the DOM progress bar, and a wall-clock extrapolation
 * for when YT Music freezes timeupdate events near the end of short tracks.
 *
 * Strategy:
 *   1. Update the wall-clock anchor whenever currentTime actually advances.
 *   2. If currentTime is stalled (video playing but CT hasn't moved in >800ms),
 *      extrapolate forward using Date.now() — this catches YT's frozen-clock bug.
 *   3. Cross-check with DOM .time-info; use whichever gives smaller remaining.
 */
function updateWallClockAnchor(v) {
  if (!v || v.paused) return;
  const ct = v.currentTime;
  const rate = v.playbackRate || 1;
  if (!Number.isFinite(ct)) return;

  // If CT has advanced since last check, update the anchor
  if (!Number.isFinite(state.lastObservedCT) || ct !== state.lastObservedCT) {
    state.lastObservedCT = ct;
    state.lastObservedCTAt = Date.now();
    state.lastObservedPlaybackRate = rate;
  }
}

function getWallClockCT(v) {
  if (!v || v.paused) return v ? v.currentTime : NaN;
  if (!Number.isFinite(state.lastObservedCT) || state.lastObservedCTAt === 0) {
    return v.currentTime;
  }

  const stallMs = Date.now() - state.lastObservedCTAt;
  // If stalled for more than 800ms while playing, extrapolate
  if (stallMs > 800) {
    const extrapolated = state.lastObservedCT + (stallMs / 1000) * state.lastObservedPlaybackRate;
    log(2, "wall-clock extrapolation", {
      anchor: Number(state.lastObservedCT.toFixed(2)),
      stallMs,
      extrapolated: Number(extrapolated.toFixed(2)),
    });
    return extrapolated;
  }

  return v.currentTime;
}

function getBestTimeEstimate(v) {
  const videoCT  = getWallClockCT(v);   // may be extrapolated if stalled
  const rawCT    = v ? v.currentTime : NaN;
  const videoDur = getEffectiveDuration(v);
  const domCT    = getDomElapsedSec();
  const domDur   = getDomDurationSec();

  // Prefer DOM duration unconditionally when valid
  let dur = videoDur;
  if (Number.isFinite(domDur) && domDur > MIN_TRACK_SEC) {
    dur = domDur;
  }

  let ct = videoCT;
  if (Number.isFinite(domCT)) {
    const divergence = Math.abs(domCT - videoCT);
    if (divergence > DOM_TIME_MAX_DIVERGENCE_SEC) {
      // Large divergence means gapless playback is active and videoCT is desynced
      ct = domCT;
    } else {
      ct = Math.max(domCT, videoCT);
    }
  }

  return { ct, dur, remaining: dur - ct, domCT, videoCT, domDur, videoDur };
}

function maybeTriggerEndSkip(source) {
  if (!settings.enabled || state.endTriggered || !refs.video) return;

  const v = refs.video;
  const { ct, dur, remaining } = getBestTimeEstimate(v);

  if (!Number.isFinite(dur) || dur < MIN_TRACK_SEC) return;
  if (!Number.isFinite(remaining)) return;

  const threshold = settings.skipEndSec + END_TRIGGER_EPSILON_SEC;
  const remainingBucket = Math.floor(remaining);

  if (
    remaining <= settings.skipEndSec + 12 &&
    remaining >= -1 &&
    state.lastNearEndLogBucket !== remainingBucket
  ) {
    state.lastNearEndLogBucket = remainingBucket;
    log(1, "end-zone monitor", {
      source,
      currentTime: Number(ct.toFixed(2)),
      videoCT: Number(v.currentTime.toFixed(2)),
      duration: Number(dur.toFixed(2)),
      remaining: Number(remaining.toFixed(2)),
      threshold: Number(threshold.toFixed(2)),
      endTriggered: state.endTriggered,
      nextActive: state.nextActive,
      track: state.trackKey,
      title: getTrackTitle(),
    });
  }

  if (remaining <= threshold && remaining > -0.6) {
    triggerEndSkip(`zone-cross:${source}`);
  }
}

function processTick(source) {
  try {
    _processTickInner(source);
  } catch (err) {
    // Never let a tick crash kill the watchdog interval or observer.
    // Log at level 1 so it's visible even in production builds.
    log(1, "processTick ERROR", { source, err: String(err) });
  }
}

function _processTickInner(source) {
  if (!refs.video) return;

  // Update wall-clock anchor FIRST so extrapolation is always fresh
  updateWallClockAnchor(refs.video);

  ensureTrackBoundaries(source);
  if (!settings.enabled) return;

  const v = refs.video;
  const now = Date.now();

  // If not in explicit user seek flow, large rollback likely means new song.
  if (!v.paused &&
      now > state.seekGraceUntil &&
      !state.seeking &&
      state.lastPlaybackTime > 0 &&
      v.currentTime + ROLLBACK_NEW_TRACK_SEC < state.lastPlaybackTime) {
    resetTrackState(state.trackKey, "time-rollback");
  }

  maybeApplyIntroSkip();
  maybeTriggerEndSkip(source);

  if (!v.paused) state.lastPlaybackTime = v.currentTime;
}

function onVideoTimeUpdate() { processTick("timeupdate"); }
function onVideoPlay() { processTick("play"); }
function onVideoPause() { processTick("pause"); }
function onVideoLoadedMetadata() { processTick("loadedmetadata"); }
function onVideoDurationChange() { processTick("durationchange"); }
function onVideoRateChange() { processTick("ratechange"); }
function onVideoSeeking() {
  state.seeking = true;
  // Reset wall-clock anchor so seek doesn't look like a stall
  state.lastObservedCT = NaN;
  state.lastObservedCTAt = 0;
  processTick("seeking");
}
function onVideoSeeked() {
  state.seeking = false;
  state.seekGraceUntil = Date.now() + 1200;
  processTick("seeked");
}
function onVideoEnded() {
  if (!settings.enabled || state.endTriggered) return;
  triggerEndSkip("ended-fallback");
}

function attachVideo(videoEl) {
  if (refs.video === videoEl) return;

  if (refs.video) {
    refs.video.removeEventListener("timeupdate", onVideoTimeUpdate);
    refs.video.removeEventListener("play", onVideoPlay);
    refs.video.removeEventListener("pause", onVideoPause);
    refs.video.removeEventListener("loadedmetadata", onVideoLoadedMetadata);
    refs.video.removeEventListener("durationchange", onVideoDurationChange);
    refs.video.removeEventListener("ratechange", onVideoRateChange);
    refs.video.removeEventListener("seeking", onVideoSeeking);
    refs.video.removeEventListener("seeked", onVideoSeeked);
    refs.video.removeEventListener("ended", onVideoEnded);
  }

  refs.video = videoEl;
  if (!refs.video) return;

  // Seed so the first src-change detection has a baseline.
  state.activeSrc = refs.video.currentSrc || "";
  state.srcChangedAt = 0;

  refs.video.addEventListener("timeupdate", onVideoTimeUpdate);
  refs.video.addEventListener("play", onVideoPlay);
  refs.video.addEventListener("pause", onVideoPause);
  refs.video.addEventListener("loadedmetadata", onVideoLoadedMetadata);
  refs.video.addEventListener("durationchange", onVideoDurationChange);
  refs.video.addEventListener("ratechange", onVideoRateChange);
  refs.video.addEventListener("seeking", onVideoSeeking);
  refs.video.addEventListener("seeked", onVideoSeeked);
  refs.video.addEventListener("ended", onVideoEnded);

  ensureTrackBoundaries("attach-video");
  processTick("attach-video");
  log(1, "video attached");
}

function attachPlayerBar(playerBarEl) {
  if (refs.playerBar === playerBarEl) return;

  if (refs.playerBarObserver) {
    refs.playerBarObserver.disconnect();
    refs.playerBarObserver = null;
  }

  refs.playerBar = playerBarEl;
  if (!refs.playerBar) return;

  refs.playerBarObserver = new MutationObserver(() => {
    try {
      ensureTrackBoundaries("player-bar-mutation");
      processTick("player-bar-mutation");
    } catch (e) { log(1, "player-bar observer error", String(e)); }
  });

  refs.playerBarObserver.observe(refs.playerBar, {
    attributes: true,
    attributeFilter: ["video-id"],
  });

  ensureTrackBoundaries("attach-player-bar");
  log(1, "player-bar attached", refs.playerBar.getAttribute("video-id") || null);
}

function attachPlayer(playerEl) {
  if (refs.player === playerEl) return;

  if (refs.playerObserver) {
    refs.playerObserver.disconnect();
    refs.playerObserver = null;
  }

  refs.player = playerEl;
  if (!refs.player) return;

  refs.playerObserver = new MutationObserver(() => {
    try {
      ensureTrackBoundaries("player-mutation");
      processTick("player-mutation");
    } catch (e) { log(1, "player observer error", String(e)); }
  });

  refs.playerObserver.observe(refs.player, {
    attributes: true,
    attributeFilter: ["video-id"],
  });

  ensureTrackBoundaries("attach-player");
  log(1, "player attached", refs.player.getAttribute("video-id") || null);
}

function bindRefs() {
  attachPlayerBar(getPlayerBarEl());
  attachPlayer(getPlayerEl());
  attachVideo(getVideoEl());
}

function scheduleBindRefs() {
  if (refs.domDebounce) clearTimeout(refs.domDebounce);
  refs.domDebounce = setTimeout(() => {
    bindRefs();
    processTick("dom-mutation");
  }, 120);
}

function initDomObserver() {
  refs.domObserver = new MutationObserver(() => {
    scheduleBindRefs();
  });

  refs.domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function initTimers() {
  refs.watchdogTimer = setInterval(() => {
    bindRefs();
    processTick("watchdog");
  }, WATCHDOG_MS);

  refs.rebindTimer = setInterval(() => {
    bindRefs();
  }, REBIND_MS);
}

function loadSettings() {
  chrome.storage.sync.get(
    { skipEndSeconds: DEFAULT_SKIP_END_SEC, skipStartSeconds: DEFAULT_SKIP_START_SEC, enabled: true },
    (items) => {
      settings.skipEndSec = clampInt(items.skipEndSeconds, 1, 30, DEFAULT_SKIP_END_SEC);
      settings.skipStartSec = clampInt(items.skipStartSeconds, 0, 30, DEFAULT_SKIP_START_SEC);
      settings.enabled = !!items.enabled;
      log(1, "settings loaded", { ...settings });
      processTick("settings-loaded");
    }
  );
}

chrome.storage.onChanged.addListener((changes) => {
  let changed = false;

  if (changes.skipEndSeconds) {
    settings.skipEndSec = clampInt(changes.skipEndSeconds.newValue, 1, 30, DEFAULT_SKIP_END_SEC);
    state.endTriggered = false;
    changed = true;
  }

  if (changes.skipStartSeconds) {
    settings.skipStartSec = clampInt(changes.skipStartSeconds.newValue, 0, 30, DEFAULT_SKIP_START_SEC);
    state.introApplied = false;
    changed = true;
  }

  if (changes.enabled) {
    settings.enabled = !!changes.enabled.newValue;
    changed = true;
    if (!settings.enabled) {
      stopNextOperation("disabled");
    } else {
      state.endTriggered = false;
      state.introApplied = false;
    }
  }

  if (changed) {
    log(1, "settings changed", { ...settings });
    processTick("settings-change");
  }
});

function init() {
  bindRefs();
  initDomObserver();
  initTimers();
  loadSettings();
  log(1, "content script started v2.7");
}

init();