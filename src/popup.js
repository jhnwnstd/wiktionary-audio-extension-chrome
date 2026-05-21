// popup.js — Settings for download mode (Original / Convert / Both)

const radios = [...document.querySelectorAll('input[name="mode"]')];
const wavWarning = document.getElementById('wav-warning');
const statusEl = document.getElementById('status');
let statusTimer = null;

function getSelectedMode() {
  return radios.find(r => r.checked)?.value || 'original';
}

function updateWarningVisibility() {
  const mode = getSelectedMode();
  wavWarning.classList.toggle('show', mode === 'convert' || mode === 'both');
}

function showStatus(message, type, duration = 1500) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.style.display = 'block';
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.style.display = 'none';
    statusTimer = null;
  }, duration);
}

async function loadSettings() {
  try {
    const { mode = 'original' } = await chrome.storage.sync.get({ mode: 'original' });
    const radio = radios.find(r => r.value === mode);
    if (radio) radio.checked = true;
    updateWarningVisibility();
  } catch {
    showStatus('Could not load settings', 'error', 3000);
  }
}

// Apply UI changes synchronously for snappy click feedback, then persist
// asynchronously. Skipping the previous storage.get round-trip removes a
// source of perceived input lag.
async function saveSettings() {
  const mode = getSelectedMode();
  updateWarningVisibility();
  try {
    await chrome.storage.sync.set({ mode });
    showStatus('Saved', 'success');
  } catch {
    showStatus('Failed to save', 'error', 3000);
  }
}

radios.forEach(r => r.addEventListener('change', saveSettings));
loadSettings();
