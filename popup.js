// popup.js

const toggleEl       = document.getElementById('toggleEnabled');
const endRangeEl     = document.getElementById('skipRange');
const endValueLabel  = document.getElementById('skipValue');
const introRangeEl   = document.getElementById('introSkipRange');
const introValueLabel= document.getElementById('introSkipValue');

chrome.storage.sync.get(
  { skipEndSeconds: 5, skipStartSeconds: 0, enabled: true },
  items => {
    toggleEl.checked    = items.enabled;
    endRangeEl.value    = items.skipEndSeconds;
    introRangeEl.value  = items.skipStartSeconds;
    setLabel(endValueLabel,   items.skipEndSeconds);
    setLabel(introValueLabel, items.skipStartSeconds);
  }
);

toggleEl.addEventListener('change', () =>
  chrome.storage.sync.set({ enabled: toggleEl.checked })
);

endRangeEl.addEventListener('input', () => {
  const val = +endRangeEl.value;
  setLabel(endValueLabel, val);
});

endRangeEl.addEventListener('change', () => {
  chrome.storage.sync.set({ skipEndSeconds: +endRangeEl.value });
});

introRangeEl.addEventListener('input', () => {
  const val = +introRangeEl.value;
  setLabel(introValueLabel, val);
});

introRangeEl.addEventListener('change', () => {
  chrome.storage.sync.set({ skipStartSeconds: +introRangeEl.value });
});

function setLabel(el, val) {
  el.innerHTML = `${val}<em>sec</em>`;
}
