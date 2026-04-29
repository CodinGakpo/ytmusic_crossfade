// popup.js — reads and writes chrome.storage.sync

const toggleEl   = document.getElementById('toggleEnabled');
const rangeEl    = document.getElementById('skipRange');
const valueLabel = document.getElementById('skipValue');
const introRangeEl = document.getElementById('introSkipRange');
const introValueLabel = document.getElementById('introSkipValue');

// Load saved settings
chrome.storage.sync.get({ skipSeconds: 5, introSkipSeconds: 0, enabled: true }, (items) => {
  toggleEl.checked = items.enabled;
  rangeEl.value    = items.skipSeconds;
  introRangeEl.value = items.introSkipSeconds;
  updateLabel(items.skipSeconds);
  updateIntroLabel(items.introSkipSeconds);
});

// Enable/disable toggle
toggleEl.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: toggleEl.checked });
});

// Skip seconds slider
rangeEl.addEventListener('input', () => {
  const val = parseInt(rangeEl.value, 10);
  updateLabel(val);
  chrome.storage.sync.set({ skipSeconds: val });
});

// Intro skip slider
introRangeEl.addEventListener('input', () => {
  const val = parseInt(introRangeEl.value, 10);
  updateIntroLabel(val);
  chrome.storage.sync.set({ introSkipSeconds: val });
});

function updateLabel(val) {
  valueLabel.innerHTML = `${val}<em>sec</em>`;
}

function updateIntroLabel(val) {
  introValueLabel.innerHTML = `${val}<em>sec</em>`;
}
