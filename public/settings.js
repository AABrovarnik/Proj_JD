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
  loginCard.classList.add('hidden');
  settingsCard.classList.remove('hidden');
  logoutBtn.classList.remove('hidden');
}

function showLoginOnly() {
  loginCard.classList.remove('hidden');
  settingsCard.classList.add('hidden');
  logoutBtn.classList.add('hidden');
}

function readyBadge(ready) {
  return ready ? '✅ готово' : '⚠️ ключи не заданы';
}

function renderTierProfiles(profiles) {
  if (!profiles) {
    tierProfiles.innerHTML = 'Профили LLM недоступны';
    return;
  }
  tierProfiles.innerHTML = `
    Сильная: <strong>${profiles.strong.provider} / ${profiles.strong.model}</strong> (${readyBadge(profiles.strong.ready)})<br/>
    Бюджетная: <strong>${profiles.budget.provider} / ${profiles.budget.model}</strong> (${readyBadge(profiles.budget.ready)})
  `;
}

function renderSecretStatus(status) {
  if (!status) {
    secretStatus.textContent = 'Статус ключей недоступен';
    return;
  }

  const mark = (value) => (value ? '✅ задан' : '⚠️ не задан');
  secretStatus.innerHTML = [
    `OpenAI API Key: <strong>${mark(status.effective?.openaiApiKeySet)}</strong>`,
    `Alice API Key: <strong>${mark(status.effective?.aliceApiKeySet)}</strong>`,
    `Alice API URL: <strong>${mark(status.effective?.aliceApiUrlSet)}</strong>`
  ].join(' · ');
}

async function loadTierProfiles() {
  const res = await api('/api/llm/profiles');
  const out = await res.json();
  if (!res.ok) {
    tierProfiles.textContent = out.error || 'Ошибка загрузки профилей LLM';
    return;
  }
  renderTierProfiles(out);
}

async function loadSecretStatus() {
  const res = await api('/api/secrets/status');
  const out = await res.json();
  if (!res.ok) {
    secretStatus.textContent = out.error || 'Ошибка загрузки статуса ключей';
    return;
  }
  renderSecretStatus(out);
}

async function saveSecrets() {
  const body = {};
  const openaiKey = openaiApiKey.value.trim();
  const aliceKey = aliceApiKey.value.trim();
  const aliceUrl = aliceApiUrl.value.trim();

  if (openaiKey) body.openaiApiKey = openaiKey;
  if (aliceKey) body.aliceApiKey = aliceKey;
  if (aliceUrl) body.aliceApiUrl = aliceUrl;

  if (Object.keys(body).length === 0) {
    alert('Введите хотя бы один ключ или URL для сохранения');
    return;
  }

  const res = await api('/api/secrets', {
    method: 'POST',
    body
  });

  const out = await res.json();
  if (!res.ok) return alert(out.error || 'Ошибка сохранения ключей');

  openaiApiKey.value = '';
  aliceApiKey.value = '';
  aliceApiUrl.value = '';

  await loadSecretStatus();
  await loadTierProfiles();
  alert('Ключи сохранены');
}

async function applyTier(tier) {
  const res = await api('/api/settings/apply-tier', {
    method: 'POST',
    body: { tier }
  });
  const out = await res.json();
  if (!res.ok) return alert(out.error || 'Ошибка применения профиля');

  llmProvider.value = out.settings.llmProvider;
  llmModel.value = out.settings.llmModel;
  await loadTierProfiles();
  alert(`Применён профиль: ${tier} → ${out.settings.llmProvider} / ${out.settings.llmModel}`);
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
  llmTimeoutMs.value = Number(s.llmTimeoutMs ?? 120000);
  refineEnabled.value = String(Boolean(s.refineEnabled));
  maxRefineRounds.value = Number(s.maxRefineRounds ?? 4);

  await loadTierProfiles();
  await loadSecretStatus();
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
      llmModel: llmModel.value,
      llmTimeoutMs: Number(llmTimeoutMs.value),
      refineEnabled: refineEnabled.value === 'true',
      maxRefineRounds: Number(maxRefineRounds.value)
    }
  });

  const out = await res.json();
  if (!res.ok) return alert(out.error || 'Ошибка сохранения');
  alert('Настройки сохранены');
  await loadTierProfiles();
}

async function clearModelSecrets() {
  if (!token) return;
  try {
    await api('/api/secrets/clear', { method: 'POST' });
  } catch {}
}

async function logout() {
  await clearModelSecrets();
  localStorage.removeItem('yurotdel_token');
  localStorage.removeItem('yurotdel_login');
  token = '';
  showLoginOnly();
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

  const previousLogin = localStorage.getItem('yurotdel_login') || '';
  const currentLogin = String(loginInput.value || '').trim();
  if (previousLogin && previousLogin !== currentLogin) {
    await clearModelSecrets();
  }
  localStorage.setItem('yurotdel_login', currentLogin);

  showSettings();
  await loadSettings();
}

async function bootFromSavedToken() {
  if (!token) {
    showLoginOnly();
    return;
  }
  try {
    showSettings();
    await loadSettings();
  } catch {
    localStorage.removeItem('yurotdel_token');
    token = '';
    showLoginOnly();
  }
}

const loginCard = document.getElementById('loginCard');
const settingsCard = document.getElementById('settingsCard');
const logoutBtn = document.getElementById('logoutBtn');
const loginInput = document.getElementById('login');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const saveSecretsBtn = document.getElementById('saveSecretsBtn');
const tierStrongBtn = document.getElementById('tierStrongBtn');
const tierBudgetBtn = document.getElementById('tierBudgetBtn');
const tierProfiles = document.getElementById('tierProfiles');
const secretStatus = document.getElementById('secretStatus');

const side = document.getElementById('side');
const maxFileMb = document.getElementById('maxFileMb');
const maxPdfPages = document.getElementById('maxPdfPages');
const maxBatchFiles = document.getElementById('maxBatchFiles');
const additionalPrompt = document.getElementById('additionalPrompt');
const llmProvider = document.getElementById('llmProvider');
const llmModel = document.getElementById('llmModel');
const llmTimeoutMs = document.getElementById('llmTimeoutMs');
const refineEnabled = document.getElementById('refineEnabled');
const maxRefineRounds = document.getElementById('maxRefineRounds');
const openaiApiKey = document.getElementById('openaiApiKey');
const aliceApiKey = document.getElementById('aliceApiKey');
const aliceApiUrl = document.getElementById('aliceApiUrl');

loginBtn.onclick = login;
saveSettingsBtn.onclick = saveSettings;
saveSecretsBtn.onclick = saveSecrets;
tierStrongBtn.onclick = () => applyTier('strong');
tierBudgetBtn.onclick = () => applyTier('budget');
logoutBtn.onclick = logout;

bootFromSavedToken();
