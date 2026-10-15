let token = localStorage.getItem('yurotdel_token') || '';
let docsCache = [];
let comparisonsCache = [];
let comparePollTimer = null;

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

function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ru-RU');
}

function formatDuration(durationMs) {
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration < 0) return '—';
  if (duration < 1000) return `${Math.round(duration)} мс`;
  return `${(duration / 1000).toFixed(1)} с`;
}

function formatUsage(usage) {
  if (!usage || !Number.isFinite(Number(usage.totalTokens))) return 'нет данных от API';
  const details = [
    usage.inputTokens === null || usage.inputTokens === undefined ? '' : `вход ${usage.inputTokens}`,
    usage.outputTokens === null || usage.outputTokens === undefined ? '' : `выход ${usage.outputTokens}`
  ].filter(Boolean);
  return `${usage.totalTokens} токенов${details.length ? ` (${details.join(', ')})` : ''}`;
}

function statusTitle(status) {
  if (status === 'found') return 'найдено';
  if (status === 'partial') return 'частично';
  if (status === 'unclear') return 'неясно';
  return 'не найдено';
}

function statusClass(status) {
  if (status === 'found') return 'status-found';
  if (status === 'partial') return 'status-partial';
  if (status === 'unclear') return 'status-unclear';
  return 'status-not-found';
}

function showAuthed() {
  loginCard.classList.add('hidden');
  compareCard.classList.remove('hidden');
  resultCard.classList.remove('hidden');
  logoutBtn.classList.remove('hidden');
}

function showGuest() {
  loginCard.classList.remove('hidden');
  compareCard.classList.add('hidden');
  resultCard.classList.add('hidden');
  logoutBtn.classList.add('hidden');
  stopComparePolling();
  renderProgress(null);
}

function renderDocsPicker() {
  if (!docsCache.length) {
    docPicker.innerHTML = '<p class="hint">Нет документов для сравнения. Сначала загрузите их на странице Анализ.</p>';
    return;
  }

  docPicker.innerHTML = docsCache.map((d) => `
    <label class="doc-item">
      <input type="checkbox" value="${d.id}" />
      <div>
        <strong>${d.originalName}</strong>
        <small>${(d.size / 1024).toFixed(1)} KB · ${formatDate(d.uploadedAt)}</small>
      </div>
    </label>
  `).join('');
}

function renderComparisonRun(run) {
  const docsHtml = (run.documents || []).map((doc) => {
    const rows = (doc.rows || []).map((r) => `
      <tr class="${r.mismatch ? 'row-alert-medium' : ''}">
        <td>${r.parameter}</td>
        <td><span class="status ${statusClass(r.strongStatus)}">${statusTitle(r.strongStatus)}</span></td>
        <td><span class="status ${statusClass(r.budgetStatus)}">${statusTitle(r.budgetStatus)}</span></td>
      </tr>
    `).join('');

    return `
      <div class="analysis-card" style="margin-top:10px;">
        <div class="analysis-head">
          <h3>${doc.documentName}</h3>
          <div class="round-right">
            <span class="score-pill ${(doc.strong.score ?? -1) >= (doc.budget.score ?? -1) ? 'score-high' : 'score-medium'}">Strong: ${doc.strong.score ?? '—'}%</span>
            <span class="score-pill ${(doc.budget.score ?? -1) >= (doc.strong.score ?? -1) ? 'score-high' : 'score-low'}">Budget: ${doc.budget.score ?? '—'}%</span>
          </div>
        </div>
        <div class="analysis-body">
          ${(doc.strong?.error || doc.budget?.error) ? `<p class="hint" style="color:#8a5a00;">Strong: ${doc.strong?.error || 'ok'} · Budget: ${doc.budget?.error || 'ok'}</p>` : ''}
          <p class="hint">Базовый проход — время: сильная ${formatDuration(doc.strong?.durationMs)}, бюджетная ${formatDuration(doc.budget?.durationMs)} · токены: сильная ${formatUsage(doc.strong?.usage)}, бюджетная ${formatUsage(doc.budget?.usage)}. Refine и рекомендация промпта не включены.</p>
          <table class="finding-table">
            <thead>
              <tr>
                <th>Параметр</th>
                <th>Сильная модель (${doc.strong.provider}/${doc.strong.model})</th>
                <th>Бюджетная модель (${doc.budget.provider}/${doc.budget.model})</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  const rationale = (run.promptSuggestion?.rationale || []).map((x) => `<li>${x}</li>`).join('') || '<li>Нет пояснений</li>';
  const errorBlock = (run.errors || []).length
    ? `<div class="hint" style="margin:8px 0 12px; color:#8a5a00;"><strong>Технические ошибки запуска:</strong><ul class="evidence-list">${run.errors.map((e) => `<li>${e.documentName || e.model}: ${e.error}</li>`).join('')}</ul></div>`
    : '';

  return `
    <div class="analysis-card">
      <div class="analysis-head">
        <h3>Сравнение от ${formatDate(run.createdAt)}</h3>
        <span class="badge badge-info">Расхождения: ${(run.mismatches || []).length}</span>
      </div>
      <div class="analysis-body">
        <p><strong>Текущий доп. промпт:</strong></p>
        <pre class="prompt-box">${run.additionalPrompt || 'нет'}</pre>
        <p><strong>Предложение сильной модели для следующего прогона бюджетной:</strong></p>
        <pre class="prompt-box prompt-strong">${run.promptSuggestion?.improvedPrompt || 'нет предложения'}</pre>
        <ul class="evidence-list">${rationale}</ul>
        ${errorBlock}
        ${docsHtml}
      </div>
    </div>
  `;
}

function renderComparisons() {
  if (!comparisonsCache.length) {
    compareRuns.innerHTML = '<p class="hint">Сравнения пока не запускались.</p>';
    return;
  }
  compareRuns.innerHTML = comparisonsCache.map(renderComparisonRun).join('');
}

function renderProgress(job) {
  if (!job) {
    progressBox.classList.add('hidden');
    progressDocs.innerHTML = '';
    progressSummary.textContent = '0 / 0';
    return;
  }

  progressBox.classList.remove('hidden');
  progressSummary.textContent = `${job.completedDocs || 0} / ${job.totalDocs || 0}`;
  progressDocs.innerHTML = (job.docs || []).map((d) => {
    const isDone = d.status === 'done';
    const isError = d.status === 'error';
    const badgeClass = isDone ? 'status-found' : (isError ? 'status-not-found' : 'status-unclear');
    const badgeText = isDone ? 'готово' : (isError ? 'ошибка' : 'в работе');
    return `
      <div class="round-item ${isError ? 'round-failed' : (isDone ? 'round-ok' : '')}">
        <div>
          <span class="status ${badgeClass}">${badgeText}</span>
          <strong>${d.documentName}</strong>
        </div>
        <div class="round-meta">${d.message || d.stage || '-'}</div>
      </div>
    `;
  }).join('');
}

function stopComparePolling() {
  if (comparePollTimer) {
    clearTimeout(comparePollTimer);
    comparePollTimer = null;
  }
}

async function pollCompare(runId) {
  stopComparePolling();

  const step = async () => {
    const res = await api(`/api/compare/progress/${runId}`);
    const out = await res.json();
    if (!res.ok) {
      compareStatus.textContent = out.error || 'Ошибка чтения прогресса';
      stopComparePolling();
      return;
    }

    renderProgress(out);

    if (out.status === 'running') {
      compareStatus.textContent = `Сравнение выполняется: ${out.completedDocs || 0}/${out.totalDocs || 0}`;
      comparePollTimer = setTimeout(step, 1200);
      return;
    }

    stopComparePolling();
    if (out.status === 'failed') {
      compareStatus.textContent = `Ошибка запуска сравнения: ${out.error || 'неизвестно'}`;
      return;
    }

    const result = out.result || null;
    if (result) {
      const warn = (result.errors || []).length ? `, тех. ошибок: ${result.errors.length}` : '';
      compareStatus.textContent = `Сравнение готово: ${result.documents?.length || 0} договор(ов), расхождений: ${result.mismatches?.length || 0}${warn}`;
    } else {
      compareStatus.textContent = 'Сравнение завершено';
    }
    await loadComparisons();
  };

  await step();
}

async function loadSettings() {
  const res = await api('/api/settings');
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || 'Ошибка загрузки настроек');
  currentPrompt.textContent = out.additionalPrompt || 'нет';
}

async function loadDocs() {
  const res = await api('/api/documents');
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || 'Ошибка загрузки документов');
  docsCache = out;
  renderDocsPicker();
}

async function loadComparisons() {
  const res = await api('/api/comparisons');
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || 'Ошибка загрузки сравнений');
  comparisonsCache = out;
  renderComparisons();
}

async function runCompare() {
  const selected = [...document.querySelectorAll('#docPicker input[type="checkbox"]:checked')].map((x) => x.value);
  if (!selected.length) return alert('Выберите хотя бы один договор');

  compareStatus.textContent = 'Сравнение запускается…';
  const res = await api('/api/compare/run', {
    method: 'POST',
    body: {
      documentIds: selected,
      quickMode: Boolean(quickMode.checked)
    }
  });
  const out = await res.json();

  if (!res.ok) {
    compareStatus.textContent = out.error || 'Ошибка сравнения';
    return alert(out.error || 'Ошибка сравнения');
  }

  if (!out.runId) {
    compareStatus.textContent = 'Ошибка: не получен идентификатор запуска';
    return;
  }

  await pollCompare(out.runId);
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
  showGuest();
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

  showAuthed();
  await loadSettings();
  await loadDocs();
  await loadComparisons();
}

async function boot() {
  if (!token) {
    showGuest();
    return;
  }
  try {
    showAuthed();
    renderProgress(null);
    await loadSettings();
    await loadDocs();
    await loadComparisons();
  } catch {
    localStorage.removeItem('yurotdel_token');
    token = '';
    showGuest();
  }
}

const loginCard = document.getElementById('loginCard');
const logoutBtn = document.getElementById('logoutBtn');
const loginInput = document.getElementById('login');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const compareCard = document.getElementById('compareCard');
const resultCard = document.getElementById('resultCard');
const docPicker = document.getElementById('docPicker');
const runCompareBtn = document.getElementById('runCompareBtn');
const refreshCompareBtn = document.getElementById('refreshCompareBtn');
const compareRuns = document.getElementById('compareRuns');
const currentPrompt = document.getElementById('currentPrompt');
const compareStatus = document.getElementById('compareStatus');
const quickMode = document.getElementById('quickMode');
const progressBox = document.getElementById('progressBox');
const progressSummary = document.getElementById('progressSummary');
const progressDocs = document.getElementById('progressDocs');

loginBtn.onclick = login;
runCompareBtn.onclick = runCompare;
refreshCompareBtn.onclick = loadComparisons;
logoutBtn.onclick = logout;

boot();
