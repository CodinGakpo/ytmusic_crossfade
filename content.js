/**
 * YT Music Crossfade - content.js
 * More robust state handling for:
 * 1) skip last N seconds (trigger next)
 * 2) skip first M seconds of the next/new track
 */

const POLL_INTERVAL_MS = 800;
const DEFAULT_SKIP_SEC = 5;
const DEFAULT_INTRO_SEC = 0;
const MIN_TRACK_SEC = 15;

let skipBuffer = DEFAULT_SKIP_SEC;
let introSkipSec = DEFAULT_INTRO_SEC;
let enabled = true;
let currentVideo = null;
let hasSkipped = false;
let pendingIntroSkip = false;
let introSkippedThisTrack = false;
let lastPlaybackTime = 0;
let pollTimer = null;
let mutationTimeout = null;

function loadSettings() {
  chrome.storage.sync.get(
    { skipSeconds: DEFAULT_SKIP_SEC, introSkipSeconds: DEFAULT_INTRO_SEC, enabled: true },
    (items) => {
      skipBuffer = Number(items.skipSeconds) || DEFAULT_SKIP_SEC;
      introSkipSec = Number(items.introSkipSeconds) || DEFAULT_INTRO_SEC;
      enabled = !!items.enabled;
    }
  );
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.skipSeconds) skipBuffer = Number(changes.skipSeconds.newValue) || DEFAULT_SKIP_SEC;
  if (changes.introSkipSeconds) introSkipSec = Number(changes.introSkipSeconds.newValue) || DEFAULT_INTRO_SEC;
  if (changes.enabled) enabled = !!changes.enabled.newValue;
});

function clickNext() {
  const selectors = [
    'ytmusic-player-bar tp-yt-paper-icon-button.next-button',
    'ytmusic-player-bar button.next-button',
    'tp-yt-paper-icon-button.next-button',
    'button.next-button',
    'ytmusic-player-bar button[aria-label*="Next"]',
    'ytmusic-player-bar button[title*="Next"]',
    'button[aria-label*="Next"]',
    'button[title*="Next"]',
  ];

  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
  }

  const playPause =
    document.querySelector('ytmusic-player-bar tp-yt-paper-icon-button.play-pause-button') ||
    document.querySelector('tp-yt-paper-icon-button.play-pause-button');

  if (playPause) {
    let sib = playPause.nextElementSibling;
    while (sib) {
      if (sib.matches && sib.matches('button, tp-yt-paper-icon-button') && !sib.disabled) {
        sib.click();
        return true;
      }
      sib = sib.nextElementSibling;
    }
  }

  return false;
}

function triggerNextWithRetry(attempt = 0) {
  if (clickNext()) return true;
  if (attempt >= 4) return false;
  setTimeout(() => triggerNextWithRetry(attempt + 1), 180);
  return false;
}

function handleLikelyNewTrack() {
  hasSkipped = false;
  introSkippedThisTrack = false;
  pendingIntroSkip = introSkipSec > 0;
  lastPlaybackTime = 0;
}

function maybeApplyIntroSkip(video) {
  if (!enabled || introSkipSec <= 0 || !pendingIntroSkip || introSkippedThisTrack) return;
  if (!isFinite(video.duration) || video.duration < MIN_TRACK_SEC) return;

  if (video.currentTime < introSkipSec && introSkipSec < video.duration - 1) {
    video.currentTime = introSkipSec;
  }

  introSkippedThisTrack = true;
  pendingIntroSkip = false;
}

function onTimeUpdate() {
  const video = currentVideo;
  if (!video || !isFinite(video.duration) || video.duration < MIN_TRACK_SEC) return;

  // Detect track rollover in same <video> (time jumps backward a lot)
  if (video.currentTime + 1.2 < lastPlaybackTime) {
    handleLikelyNewTrack();
  }

  maybeApplyIntroSkip(video);

  if (!enabled || hasSkipped) {
    lastPlaybackTime = video.currentTime;
    return;
  }

  const remaining = video.duration - video.currentTime;
  if (remaining <= skipBuffer + 0.35 && remaining > -0.25) {
    hasSkipped = true;
    pendingIntroSkip = introSkipSec > 0;
    const success = triggerNextWithRetry();
    if (!success) {
      hasSkipped = false;
      pendingIntroSkip = false;
    }
  }

  lastPlaybackTime = video.currentTime;
}

function attachToVideo(video) {
  if (currentVideo === video) return;

  if (currentVideo) {
    currentVideo.removeEventListener('timeupdate', onTimeUpdate);
  }

  currentVideo = video;
  handleLikelyNewTrack();
  pendingIntroSkip = false;

  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('emptied', handleLikelyNewTrack);
  video.addEventListener('loadedmetadata', () => {
    handleLikelyNewTrack();
    maybeApplyIntroSkip(video);
  });
  video.addEventListener('ended', () => {
    pendingIntroSkip = introSkipSec > 0;
    introSkippedThisTrack = false;
  });
}

function findAndAttach() {
  const video = document.querySelector('video');
  if (video) attachToVideo(video);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(findAndAttach, POLL_INTERVAL_MS);
}

const observer = new MutationObserver(() => {
  clearTimeout(mutationTimeout);
  mutationTimeout = setTimeout(findAndAttach, 300);
});

observer.observe(document.documentElement, { childList: true, subtree: true });

loadSettings();
startPolling();
