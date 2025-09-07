// Popup script for settings management

const radios = [...document.querySelectorAll('input[name="mode"]')];
const wavWarning = document.getElementById('wav-warning');
const status = document.getElementById('status');

let statusTimerId = null;

// Load settings on popup open
async function loadSettings() {
  try {
    const { mode = 'original' } = await chrome.storage.sync.get({ mode: 'original' });
    const radio = radios.find(r => r.value === mode);
    if (radio) radio.checked = true;
    updateWarningVisibility();
  } catch (error) {
    console.error('Failed to load settings:', error);
    showStatus('Could not load settings', 'error', 3000);
  }
}

// Save settings when radio changes
async function saveSettings() {
  try {
    const selectedRadio = radios.find(r => r.checked);
    const mode = selectedRadio ? selectedRadio.value : 'original';

    // Only write if changed
    const { mode: current = 'original' } = await chrome.storage.sync.get({ mode: 'original' });
    if (mode !== current) {
      await chrome.storage.sync.set({ mode });
      showStatus('Settings saved!', 'success');
    }

    updateWarningVisibility();
  } catch (error) {
    console.error('Failed to save settings:', error);
    showStatus('Failed to save settings', 'error', 3000);
  }
}

// Show/hide warning based on selected mode
function updateWarningVisibility() {
  const selectedRadio = radios.find(r => r.checked);
  const mode = selectedRadio ? selectedRadio.value : 'original';
  wavWarning.classList.toggle('show', mode === 'convert');
}

// Show status message
function showStatus(message, type, duration = 2000) {
  status.textContent = message;
  status.classList.remove('success', 'error');
  status.classList.add(type);
  status.style.display = 'block';

  // Reset any existing timer so messages don't overlap
  if (statusTimerId) clearTimeout(statusTimerId);
  statusTimerId = setTimeout(() => {
    status.style.display = 'none';
    statusTimerId = null;
  }, duration);
}

// Event listeners
radios.forEach(r => r.addEventListener('change', saveSettings));

// Initialize
loadSettings();