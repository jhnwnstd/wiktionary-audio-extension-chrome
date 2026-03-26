// popup.js — Settings for download mode (Original / Convert)

const radios = [...document.querySelectorAll('input[name="mode"]')];
const wavWarning = document.getElementById('wav-warning');
const statusEl = document.getElementById('status');
let statusTimer = null;

function getSelectedMode() {
  return radios.find(r => r.checked)?.value || 'original';
}

function updateWarningVisibility() {
  wavWarning.classList.toggle('show', getSelectedMode() === 'convert');
}

function showStatus(message, type, duration = 2000) {
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

async function saveSettings() {
  try {
    const mode = getSelectedMode();
    const { mode: current = 'original' } = await chrome.storage.sync.get({ mode: 'original' });
    if (mode !== current) {
      await chrome.storage.sync.set({ mode });
      showStatus('Settings saved!', 'success');
    }
    updateWarningVisibility();
  } catch {
    showStatus('Failed to save settings', 'error', 3000);
  }
}

radios.forEach(r => r.addEventListener('change', saveSettings));
loadSettings();
