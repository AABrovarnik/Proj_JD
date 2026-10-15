const fs = require('fs');
const vm = require('vm');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const LOGIN = process.env.ADMIN_LOGIN || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

let failed = false;

function ok(label, details = '') {
  console.log(`✅ ${label}${details ? ` — ${details}` : ''}`);
}

function warn(label, details = '') {
  console.log(`⚠️ ${label}${details ? ` — ${details}` : ''}`);
}

function err(label, details = '') {
  failed = true;
  console.error(`❌ ${label}${details ? ` — ${details}` : ''}`);
}

function checkSyntax(file) {
  try {
    const code = fs.readFileSync(file, 'utf8');
    new vm.Script(code, { filename: file });
    ok(`Синтаксис ${file}`);
  } catch (e) {
    err(`Синтаксис ${file}`, String(e.message || e).slice(0, 400));
  }
}

async function expectJsonResponse(path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 200)}`);
  }

  if (!contentType.includes('application/json')) {
    throw new Error(`Ожидался JSON на ${path}, получено: ${contentType || 'unknown'}. Вероятно, поднята старая версия сервера.`);
  }

  return JSON.parse(text);
}

async function checkApiFlow() {
  try {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: LOGIN, password: PASSWORD })
    });

    const loginType = String(loginRes.headers.get('content-type') || '').toLowerCase();
    const loginRaw = await loginRes.text();

    if (!loginRes.ok) {
      throw new Error(`Логин неуспешен: HTTP ${loginRes.status} ${loginRaw.slice(0, 200)}`);
    }

    if (!loginType.includes('application/json')) {
      throw new Error('Логин вернул не JSON. Вероятно, на порту запущен неактуальный сервер.');
    }

    const login = JSON.parse(loginRaw);
    if (!login.token) {
      throw new Error('В ответе логина отсутствует token');
    }

    ok('API login');

    const status = await expectJsonResponse('/api/secrets/status', login.token);
    const profiles = await expectJsonResponse('/api/llm/profiles', login.token);
    await expectJsonResponse('/api/comparisons', login.token);

    if (!status.effective || typeof status.effective.openaiApiKeySet !== 'boolean') {
      err('/api/secrets/status структура', 'нет блока effective/openaiApiKeySet');
    } else {
      ok('/api/secrets/status структура');
    }

    if (!profiles.strong || typeof profiles.strong.ready !== 'boolean') {
      err('/api/llm/profiles структура', 'нет блока strong.ready');
    } else {
      ok('/api/llm/profiles структура');
    }

    ok('/api/comparisons JSON');
  } catch (e) {
    err('Проверка API', e.message || String(e));
  }
}

function checkEnvHints() {
  if (!process.env.OPENAI_API_KEY && !process.env.ALICE_API_KEY) {
    warn('Ключи LLM в env пусты', 'допустимо при сохранении через /settings');
  } else {
    ok('Обнаружены ключи LLM в env');
  }
}

(async () => {
  console.log('--- ЮрОтдел preflight ---');
  console.log(`BASE_URL=${BASE_URL}`);

  checkSyntax('src/server.js');
  checkSyntax('public/settings.js');
  checkEnvHints();
  await checkApiFlow();

  console.log('-------------------------');
  if (failed) {
    console.error('Итог: preflight НЕ пройден');
    process.exitCode = 1;
    return;
  }
  console.log('Итог: preflight пройден');
})();
