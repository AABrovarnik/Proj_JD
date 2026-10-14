let token = localStorage.getItem('yurotdel_token') || '';

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const requestOptions = { ...options, headers };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
    requestOptions.body = JSON.stringify(options.body);
  }

  return fetch(path, requestOptions);
}

function showSettings() {
  document.getElementById('settingsCard').classList.remove('hidden');
}

async function loadSettings() {
  const res = await api('/api/settings');
  const s = await res.json();
  if (!res.ok) throw new Error(s.error || 'Ошибка загрузки настроек');

  side.value = s.side;
  maxFileMb.value = s.maxFileMb;
  maxPdfPages.value = s.maxPdfPages;
  maxBatchFiles.value = s.maxBatchFiles;
  additionalPrompt.value = s.additionalPrompt || '';
  llmProvider.value = s.llmProvider || 'local_mock';
  llmModel.value = s.llmModel || '';
}

async function saveSettings() {
  const res = await api('/api/settings', {
    method: 'PUT',
    body: {
      side: side.value,
      maxFileMb: Number(maxFileMb.value),
      maxPdfPages: Number(maxPdfPages.value),
      maxBatchFiles: Number(maxBatchFiles.value),
      additionalPrompt: additionalPrompt.value,
      llmProvider: llmProvider.value,
      llmModel: llmModel.value
    }
  });

  const out = await res.json();
  if (!res.ok) return alert(out.error || 'Ошибка сохранения');
  alert('Настройки сохранены');
}

async function login() {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: { login: loginInput.value, password: passwordInput.value }
  });
  const out = await res.json();
  if (!res.ok) return alert(out.error || 'Ошибка входа');

  token = out.token;
  localStorage.setItem('yurotdel_token', token);
  showSettings();
  await loadSettings();
}

async function bootFromSavedToken() {
  if (!token) return;
  try {
    showSettings();
    await loadSettings();
  } catch {
    localStorage.removeItem('yurotdel_token');
    token = '';
  }
}

const loginInput = document.getElementById('login');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');

const side = document.getElementById('side');
const maxFileMb = document.getElementById('maxFileMb');
const maxPdfPages = document.getElementById('maxPdfPages');
const maxBatchFiles = document.getElementById('maxBatchFiles');
const additionalPrompt = document.getElementById('additionalPrompt');
const llmProvider = document.getElementById('llmProvider');
const llmModel = document.getElementById('llmModel');

loginBtn.onclick = login;
saveSettingsBtn.onclick = saveSettings;

bootFromSavedToken();
