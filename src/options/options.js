const DEFAULTS = {
  showAbilities: true,
  showSaves: true,
  showSkills: true,
  skillMode: 'proficient',
  showLanguages: true,
  showSenses: true,
  showSpellcasting: true,
  showOtherProficiencies: false,
  startExpanded: true,
  cacheTtlSeconds: 300
};

const status = document.getElementById('status');
let statusTimer = null;

function note(text) {
  status.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = '';
  }, 1800);
}

function inputsFor(setting) {
  return Array.from(document.querySelectorAll(`[data-setting="${setting}"]`));
}

async function load() {
  const values = await chrome.storage.sync.get(DEFAULTS);
  for (const [setting, value] of Object.entries({ ...DEFAULTS, ...values })) {
    for (const input of inputsFor(setting)) {
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else if (input.type === 'radio') input.checked = input.value === value;
      else input.value = value;
    }
  }
}

function readValue(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'radio') return input.value;
  if (input.type === 'number') {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULTS[input.dataset.setting];
    return Math.min(3600, Math.round(parsed));
  }
  return input.value;
}

document.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-setting]');
  if (!input) return;
  const setting = input.dataset.setting;
  if (input.type === 'radio' && !input.checked) return;
  const value = readValue(input);
  if (input.type === 'number') input.value = value;
  await chrome.storage.sync.set({ [setting]: value });
  note('Saved');
});

load();
