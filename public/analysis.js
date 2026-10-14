let token = localStorage.getItem('yurotdel_token') || '';
let docsCache = [];
let analysesCache = [];

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const isForm = options.body instanceof FormData;
  const requestOptions = { ...options, headers };

  if (options.body && !isForm) {
    headers['Content-Type'] = 'application/json';
    requestOptions.body = JSON.stringify(options.body);
  }

  return fetch(path, requestOptions);
}

function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ru-RU');
}

function statusTitle(status) {
  if (status === 'found') return 'найдено';
  if (status === 'partial') return 'частично';
  if (status === 'unclear') return 'неясно';
  return 'не найдено';
}

function scoreClass(score) {
  if (score >= 80) return 'score-high';
  if (score >= 60) return 'score-medium';
  return 'score-low';
}

function statusClass(status) {
  if (status === 'found') return 'status-found';
  if (status === 'partial') return 'status-partial';
  if (status === 'unclear') return 'status-unclear';
  return 'status-not-found';
}

function rowAlertClass(status) {
  if (status === 'not_found') return 'row-alert-high';
  if (status === 'partial') return 'row-alert-medium';
  if (status === 'unclear') return 'row-alert-unclear';
  return '';
}

function showAuthedSections() {
  document.getElementById('uploadCard').classList.remove('hidden');
  document.getElementById('resultCard').classList.remove('hidden');
}

function renderDocuments() {
  const node = document.getElementById('docs');
  if (!docsCache.length) {
    node.innerHTML = '<p class="hint">Документы пока не загружены</p>';
    return;
  }

  node.innerHTML = docsCache.map((d) => `
    <label class="doc-item">
      <input type="checkbox" value="${d.id}" />
      <div>
        <strong>${d.originalName}</strong>
        <small>${Math.round(d.size / 1024)} KB · ${formatDate(d.uploadedAt)}</small>
      </div>
    </label>
  `).join('');
}

function renderSummary() {
  const node = document.getElementById('analysisSummary');
  if (!analysesCache.length) {
    node.innerHTML = '';
    return;
  }

  let findingsTotal = 0;
  let violationsHigh = 0;
  let violationsMedium = 0;
  let unclearCount = 0;
  let avgScore = 0;

  for (const a of analysesCache) {
    const findings = a?.result?.findings || [];
    findingsTotal += findings.length;
    violationsHigh += findings.filter((f) => f.status === 'not_found').length;
    violationsMedium += findings.filter((f) => f.status === 'partial').length;
    unclearCount += findings.filter((f) => f.status === 'unclear').length;
    avgScore += Number(a?.result?.score || 0);
  }

  avgScore = Math.round(avgScore / analysesCache.length);

  node.innerHTML = `
    <article class="summary-card"><div class="k">Документов</div><div class="v">${analysesCache.length}</div></article>
    <article class="summary-card"><div class="k">Средний score</div><div class="v">${avgScore}</div></article>
    <article class="summary-card"><div class="k">Критичные нарушения</div><div class="v">${violationsHigh}</div></article>
    <article class="summary-card"><div class="k">Частичные риски</div><div class="v">${violationsMedium}</div></article>
    <article class="summary-card"><div class="k">Неясные пункты</div><div class="v">${unclearCount}</div></article>
    <article class="summary-card"><div class="k">Всего проверок</div><div class="v">${findingsTotal}</div></article>
  `;
}

function renderAnalyses() {
  const node = document.getElementById('analyses');
  if (!analysesCache.length) {
    node.innerHTML = '<p class="hint">Пока нет результатов анализа</p>';
    return;
  }

  node.innerHTML = analysesCache.map((analysis) => {
    const findings = analysis?.result?.findings || [];
    const score = Number(analysis?.result?.score || 0);

    const rows = findings.map((f) => `
      <tr class="${rowAlertClass(f.status)}">
        <td>${f.parameter}</td>
        <td><span class="status ${statusClass(f.status)}">${statusTitle(f.status)}</span></td>
        <td>
          ${(f.evidence || []).length ? `<ul class="evidence-list">${f.evidence.map((e) => `<li>${e}</li>`).join('')}</ul>` : '<em>нет цитат</em>'}
        </td>
      </tr>
    `).join('');

    const llmText = analysis.llm ? `${analysis.llm.provider} / ${analysis.llm.model}` : 'n/a';

    return `
      <article class="analysis-card">
        <div class="analysis-head">
          <h3>${analysis.documentName}</h3>
          <div class="score-pill ${scoreClass(score)}">Score: ${score}</div>
        </div>
        <div class="analysis-body">
          <p class="hint">Проверено: ${formatDate(analysis.analyzedAt)} · Риск: <strong>${analysis?.result?.summary?.riskLevel || '-'}</strong> · LLM: <strong>${llmText}</strong></p>
          <table class="finding-table">
            <thead>
              <tr>
                <th>Параметр</th>
                <th>Статус</th>
                <th>Доказательства</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </article>
    `;
  }).join('');
}

async function loadDocs() {
  const res = await api('/api/documents');
  if (!res.ok) throw new Error('Нет доступа к документам');
  docsCache = await res.json();
  renderDocuments();
}

async function uploadDocs() {
  const selected = document.getElementById('files').files;
  if (!selected.length) return alert('Выберите файлы');

  const fd = new FormData();
  for (const f of selected) fd.append('files', f);

  const res = await api('/api/documents/upload', { method: 'POST', body: fd });
  const out = await res.json();
  if (!res.ok) return alert(out.error || 'Ошибка загрузки');

  await loadDocs();
  alert(`Загружено: ${out.uploaded.length}, пропущено: ${out.skipped}`);
}

async function runAnalyze() {
  const selectedIds = [...document.querySelectorAll('#docs input[type="checkbox"]:checked')].map((x) => x.value);
  if (!selectedIds.length) return alert('Выберите документы для анализа');

  const res = await api('/api/analyze', {
    method: 'POST',
    body: { documentIds: selectedIds }
  });
  const out = await res.json();
  if (!res.ok) return alert(out.error || 'Ошибка анализа');

  await loadAnalyses();
  alert(`Анализ завершён. Документов в запуске: ${out.length}`);
}

async function loadAnalyses() {
  const res = await api('/api/analyses');
  if (!res.ok) throw new Error('Нет доступа к анализам');
  analysesCache = await res.json();
  renderSummary();
  renderAnalyses();
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
  showAuthedSections();
  await loadDocs();
  await loadAnalyses();
}

async function bootFromSavedToken() {
  if (!token) return;
  try {
    showAuthedSections();
    await loadDocs();
    await loadAnalyses();
  } catch {
    localStorage.removeItem('yurotdel_token');
    token = '';
  }
}

const loginInput = document.getElementById('login');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const uploadBtn = document.getElementById('uploadBtn');
const analyzeBtn = document.getElementById('analyzeBtn');
const refreshAnalysesBtn = document.getElementById('refreshAnalysesBtn');

loginBtn.onclick = login;
uploadBtn.onclick = uploadDocs;
analyzeBtn.onclick = runAnalyze;
refreshAnalysesBtn.onclick = loadAnalyses;

bootFromSavedToken();
