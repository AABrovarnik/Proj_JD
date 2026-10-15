require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { readDb, writeDb, nextId, defaultChecklist } = require('./storage');
const { extractText } = require('./extract');
const { runLlmAnalysis, runLlmRefineForParameter, runStrongPromptSuggestion, sanitizeAdditionalPrompt } = require('./llm');
const { validateAnalysisResult, validateFinding, formatAjvErrors } = require('./schema');
const { buildSecretStatus, mergeEnvWithSecrets, saveSecretsPatch } = require('./secrets');

const app = express();
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET || 'change-me-local';
const adminLogin = process.env.ADMIN_LOGIN || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
const compareJobs = new Map();
const MAX_COMPARE_JOBS = 30;

for (const folder of ['uploads', 'exports', 'data']) {
  if (!fs.existsSync(path.join(process.cwd(), folder))) {
    fs.mkdirSync(path.join(process.cwd(), folder), { recursive: true });
  }
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, path.join(process.cwd(), 'uploads')),
  filename: (_, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`)
});
const upload = multer({ storage });

function audit(action, details = {}) {
  const db = readDb();
  db.audit.push({ id: nextId('audit'), at: new Date().toISOString(), action, details });
  writeDb(db);
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Требуется авторизация' });
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Невалидный токен' });
  }
}

function statusWeight(status) {
  if (status === 'found') return 1;
  if (status === 'partial') return 0.5;
  if (status === 'unclear') return 0.25;
  return 0;
}

function computeScore(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return 0;
  const total = findings.reduce((acc, item) => acc + statusWeight(item.status), 0);
  return Math.round((total / findings.length) * 100);
}

function inferRiskLevel(score) {
  if (score >= 80) return 'low';
  if (score >= 60) return 'medium';
  return 'high';
}

function normalizeQuote(value) {
  return String(value || '')
    .replace(/\[[^\]]+\]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function validateEvidence(findings, text) {
  const source = String(text || '').replace(/\s+/g, ' ').toLowerCase();
  const warnings = [];

  for (const finding of findings) {
    const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
    if (!evidence.length) continue;

    const confirmed = evidence.filter((entry) => {
      const quote = normalizeQuote(entry);
      if (!quote || quote.length < 6) return false;
      return source.includes(quote);
    });

    if (confirmed.length === 0) {
      warnings.push(`Неподтверждённые цитаты: ${finding.parameter}`);
      if (finding.status === 'found') finding.status = 'unclear';
      if (!finding.missingInfo) finding.missingInfo = 'Цитаты не подтверждены исходным текстом';
    }
  }

  return warnings;
}

function pickRefineCandidate(findings, attempted = new Set()) {
  const candidates = findings.filter((f) => ['partial', 'unclear'].includes(f.status) && !attempted.has(f.parameter));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const aWeight = a.status === 'unclear' ? 0 : 1;
    const bWeight = b.status === 'unclear' ? 0 : 1;
    if (aWeight !== bWeight) return aWeight - bWeight;
    const aEvidence = (a.evidence || []).length;
    const bEvidence = (b.evidence || []).length;
    return aEvidence - bEvidence;
  });
  return candidates[0];
}

function replaceFinding(findings, updated) {
  const idx = findings.findIndex((x) => x.parameter === updated.parameter);
  if (idx >= 0) findings[idx] = updated;
}

function pruneCompareJobs() {
  if (compareJobs.size <= MAX_COMPARE_JOBS) return;
  const sorted = [...compareJobs.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  while (sorted.length > MAX_COMPARE_JOBS) {
    const oldest = sorted.shift();
    if (!oldest) break;
    compareJobs.delete(oldest.id);
  }
}

function upsertCompareJob(job) {
  compareJobs.set(job.id, job);
  pruneCompareJobs();
}

function createCompareJob({ id, user, docs, quickMode }) {
  const now = new Date().toISOString();
  const job = {
    id,
    user,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    status: 'running',
    quickMode: Boolean(quickMode),
    totalDocs: docs.length,
    completedDocs: 0,
    error: null,
    comparisonId: null,
    docs: docs.map((doc) => ({
      documentId: doc.id,
      documentName: doc.originalName,
      status: 'pending',
      stage: 'queued',
      message: 'В очереди'
    }))
  };
  upsertCompareJob(job);
  return job;
}

function updateCompareJob(runId, updater) {
  const job = compareJobs.get(runId);
  if (!job) return;
  updater(job);
  job.updatedAt = new Date().toISOString();
  compareJobs.set(runId, job);
}

function setDocJobState(runId, documentId, patch = {}) {
  updateCompareJob(runId, (job) => {
    const idx = job.docs.findIndex((d) => d.documentId === documentId);
    if (idx < 0) return;
    job.docs[idx] = {
      ...job.docs[idx],
      ...patch
    };
    job.completedDocs = job.docs.filter((x) => x.status === 'done' || x.status === 'error').length;
  });
}

async function refineOnlyDisputed({ analysis, extractedText, settings, runtimeEnv, parameters = [], onStep }) {
  const targets = [...new Set((parameters || []).map((x) => String(x || '').trim()).filter(Boolean))]
    .slice(0, Math.max(0, Number(settings.maxRefineRounds || 0)));

  if (!analysis?.findings || !targets.length || settings.llmProvider === 'local_mock') {
    return analysis;
  }

  const findings = [...analysis.findings];
  const rounds = Array.isArray(analysis.rounds) ? [...analysis.rounds] : [];
  const runtimeEnvWithTimeout = {
    ...runtimeEnv,
    LLM_TIMEOUT_MS: Number(settings.llmTimeoutMs || runtimeEnv.LLM_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || 120000)
  };

  for (let i = 0; i < targets.length; i++) {
    const parameter = targets[i];
    const current = findings.find((f) => f.parameter === parameter);
    if (!current) continue;

    try {
      onStep?.({ status: 'running', round: i + 1, parameter });
      const refined = await runLlmRefineForParameter({
        provider: settings.llmProvider,
        model: settings.llmModel,
        parameterId: parameter,
        finding: current,
        side: settings.side,
        additionalPrompt: settings.additionalPrompt,
        env: runtimeEnvWithTimeout
      });

      if (!validateFinding(refined)) {
        throw new Error('Refine-ответ не прошёл schema: ' + formatAjvErrors(validateFinding.errors));
      }

      replaceFinding(findings, refined);
      rounds.push({
        round: rounds.length + 1,
        type: 'refine',
        mode: 'disputed_only',
        status: 'ok',
        parameter,
        at: new Date().toISOString()
      });
      onStep?.({ status: 'ok', round: i + 1, parameter });
    } catch (refineError) {
      rounds.push({
        round: rounds.length + 1,
        type: 'refine',
        mode: 'disputed_only',
        status: 'failed',
        parameter,
        error: String(refineError.message || refineError),
        at: new Date().toISOString()
      });
      onStep?.({ status: 'failed', round: i + 1, parameter, error: String(refineError.message || refineError) });
    }
  }

  const evidenceWarnings = validateEvidence(findings, extractedText);
  const score = computeScore(findings);
  return {
    ...analysis,
    findings,
    rounds,
    score,
    summary: {
      ...(analysis.summary || {}),
      riskLevel: inferRiskLevel(score)
    },
    warnings: [...new Set([...(analysis.warnings || []), ...evidenceWarnings])]
  };
}

async function runAnalysisWithConfig({ extractedText, settings, runtimeEnv }) {
  const startedAt = Date.now();
  const analysisRounds = [];
  const runtimeEnvWithTimeout = {
    ...runtimeEnv,
    LLM_TIMEOUT_MS: Number(settings.llmTimeoutMs || runtimeEnv.LLM_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || 120000)
  };

  const baseOut = await runLlmAnalysis({
    provider: settings.llmProvider,
    model: settings.llmModel,
    text: extractedText,
    checklist: settings.checklist,
    side: settings.side,
    additionalPrompt: settings.additionalPrompt,
    env: runtimeEnvWithTimeout
  });
  const llmResult = baseOut.result;
  const reportedUsage = baseOut?.usage;
  const readTokenCount = (...keys) => {
    for (const key of keys) {
      if (reportedUsage?.[key] !== undefined && reportedUsage?.[key] !== null) {
        const value = Number(reportedUsage[key]);
        if (Number.isFinite(value)) return value;
      }
    }
    return null;
  };
  const inputTokens = readTokenCount('input_tokens', 'prompt_tokens', 'inputTokens');
  const outputTokens = readTokenCount('output_tokens', 'completion_tokens', 'outputTokens');
  const reportedTotalTokens = readTokenCount('total_tokens', 'totalTokens');
  const usage = [inputTokens, outputTokens, reportedTotalTokens].some(Number.isFinite)
    ? {
        inputTokens,
        outputTokens,
        totalTokens: reportedTotalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0)
      }
    : null;

  if (!validateAnalysisResult(llmResult)) {
    throw new Error('Базовый ответ LLM не прошёл JSON Schema: ' + formatAjvErrors(validateAnalysisResult.errors));
  }

  analysisRounds.push({
    round: 1,
    type: 'base',
    status: 'ok',
    at: new Date().toISOString()
  });

  const findings = Array.isArray(llmResult.findings) ? llmResult.findings : [];

  if (settings.refineEnabled && settings.llmProvider !== 'local_mock' && settings.maxRefineRounds > 0) {
    const attempted = new Set();
    for (let i = 1; i <= settings.maxRefineRounds; i++) {
      const candidate = pickRefineCandidate(findings, attempted);
      if (!candidate) {
        analysisRounds.push({
          round: i + 1,
          type: 'refine',
          status: 'stopped',
          reason: 'no_partial_or_unclear',
          at: new Date().toISOString()
        });
        break;
      }

      attempted.add(candidate.parameter);
      try {
        const refined = await runLlmRefineForParameter({
          provider: settings.llmProvider,
          model: settings.llmModel,
          parameterId: candidate.parameter,
          finding: candidate,
          side: settings.side,
          additionalPrompt: settings.additionalPrompt,
          env: runtimeEnvWithTimeout
        });

        if (!validateFinding(refined)) {
          throw new Error('Refine-ответ не прошёл schema: ' + formatAjvErrors(validateFinding.errors));
        }

        replaceFinding(findings, refined);
        analysisRounds.push({
          round: i + 1,
          type: 'refine',
          status: 'ok',
          parameter: candidate.parameter,
          at: new Date().toISOString()
        });
      } catch (refineError) {
        analysisRounds.push({
          round: i + 1,
          type: 'refine',
          status: 'failed',
          parameter: candidate.parameter,
          error: String(refineError.message || refineError),
          at: new Date().toISOString()
        });
      }
    }
  }

  const evidenceWarnings = validateEvidence(findings, extractedText);
  const score = computeScore(findings);

  return {
    ...llmResult,
    findings,
    score,
    summary: {
      ...(llmResult.summary || {}),
      riskLevel: inferRiskLevel(score)
    },
    rounds: analysisRounds,
    warnings: [...new Set([...(llmResult.warnings || []), ...evidenceWarnings])],
    usage,
    durationMs: Date.now() - startedAt
  };
}

function toFindingsMap(findings = []) {
  const map = {};
  for (const f of findings) {
    map[f.parameter] = f;
  }
  return map;
}
function getTierProfiles(runtimeEnv = process.env) {
  const profiles = {
    strong: {
      provider: runtimeEnv.LLM_STRONG_PROVIDER || process.env.LLM_STRONG_PROVIDER || 'openai',
      model: runtimeEnv.LLM_STRONG_MODEL || process.env.LLM_STRONG_MODEL || 'gpt-6.1-sol'
    },
    budget: {
      provider: runtimeEnv.LLM_BUDGET_PROVIDER || process.env.LLM_BUDGET_PROVIDER || 'openai',
      model: runtimeEnv.LLM_BUDGET_MODEL || process.env.LLM_BUDGET_MODEL || 'gpt-6-luna'
    }
  };

  const isProviderReady = (provider) => {
    if (provider === 'local_mock') return true;
    if (provider === 'openai') return Boolean(runtimeEnv.OPENAI_API_KEY);
    if (provider === 'alice') return Boolean(runtimeEnv.ALICE_API_KEY && runtimeEnv.ALICE_API_URL);
    return false;
  };

  return {
    strong: { ...profiles.strong, ready: isProviderReady(profiles.strong.provider) },
    budget: { ...profiles.budget, ready: isProviderReady(profiles.budget.provider) }
  };
}

app.post('/api/auth/login', async (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) return res.status(400).json({ error: 'Укажите логин и пароль' });

  if (login !== adminLogin) return res.status(401).json({ error: 'Неверные учетные данные' });

  const hash = bcrypt.hashSync(adminPassword, 8);
  const ok = bcrypt.compareSync(password, hash);
  if (!ok) return res.status(401).json({ error: 'Неверные учетные данные' });

  const token = jwt.sign({ sub: login, role: 'admin' }, jwtSecret, { expiresIn: '12h' });
  audit('login', { login });
  res.json({ token });
});

app.get('/api/settings', auth, (req, res) => {
  const db = readDb();
  res.json(db.settings);
});

app.put('/api/settings', auth, (req, res) => {
  const db = readDb();
  const payload = req.body || {};

  const llmProvider = ['openai', 'alice', 'local_mock'].includes(payload.llmProvider)
    ? payload.llmProvider
    : db.settings.llmProvider;

  const maxRefineRounds = Number(payload.maxRefineRounds ?? db.settings.maxRefineRounds ?? 4);
  const llmTimeoutMs = Number(payload.llmTimeoutMs ?? db.settings.llmTimeoutMs ?? 120000);

  db.settings = {
    ...db.settings,
    profile: payload.profile || db.settings.profile,
    side: payload.side || db.settings.side,
    maxFileMb: Number(payload.maxFileMb || db.settings.maxFileMb),
    maxPdfPages: Number(payload.maxPdfPages || db.settings.maxPdfPages),
    maxBatchFiles: Number(payload.maxBatchFiles || db.settings.maxBatchFiles),
    additionalPrompt: sanitizeAdditionalPrompt(payload.additionalPrompt ?? db.settings.additionalPrompt),
    checklist: Array.isArray(payload.checklist) && payload.checklist.length ? payload.checklist : defaultChecklist,
    llmProvider,
    llmModel: String(payload.llmModel ?? db.settings.llmModel),
    llmTimeoutMs: Number.isFinite(llmTimeoutMs) ? Math.max(5000, Math.min(180000, Math.round(llmTimeoutMs))) : 120000,
    refineEnabled: payload.refineEnabled === undefined ? Boolean(db.settings.refineEnabled) : Boolean(payload.refineEnabled),
    maxRefineRounds: Number.isFinite(maxRefineRounds) ? Math.max(0, Math.min(4, Math.round(maxRefineRounds))) : 4
  };

  writeDb(db);
  audit('settings_update', { by: req.user.sub, llmProvider: db.settings.llmProvider });
  res.json(db.settings);
});


app.get('/api/llm/profiles', auth, (req, res) => {
  const runtimeEnv = mergeEnvWithSecrets(process.env, jwtSecret);
  res.json(getTierProfiles(runtimeEnv));
});

app.get('/api/secrets/status', auth, (req, res) => {
  const stored = buildSecretStatus(jwtSecret);
  const env = {
    openaiApiKeySet: Boolean(process.env.OPENAI_API_KEY),
    aliceApiKeySet: Boolean(process.env.ALICE_API_KEY),
    aliceApiUrlSet: Boolean(process.env.ALICE_API_URL)
  };

  res.json({
    env,
    stored,
    effective: {
      openaiApiKeySet: env.openaiApiKeySet || stored.openaiApiKeySet,
      aliceApiKeySet: env.aliceApiKeySet || stored.aliceApiKeySet,
      aliceApiUrlSet: env.aliceApiUrlSet || stored.aliceApiUrlSet
    }
  });
});

app.post('/api/secrets', auth, (req, res) => {
  const payload = req.body || {};
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'openaiApiKey')) {
    patch.OPENAI_API_KEY = payload.openaiApiKey;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'aliceApiKey')) {
    patch.ALICE_API_KEY = payload.aliceApiKey;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'aliceApiUrl')) {
    patch.ALICE_API_URL = payload.aliceApiUrl;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Передайте хотя бы один секрет для сохранения' });
  }

  saveSecretsPatch(jwtSecret, patch);

  audit('secrets_update', {
    by: req.user.sub,
    hasOpenAiKey: Boolean(String(payload.openaiApiKey || '').trim()),
    hasAliceKey: Boolean(String(payload.aliceApiKey || '').trim()),
    hasAliceUrl: Boolean(String(payload.aliceApiUrl || '').trim())
  });

  const stored = buildSecretStatus(jwtSecret);
  res.json({ ok: true, stored });
});

app.post('/api/secrets/clear', auth, (req, res) => {
  saveSecretsPatch(jwtSecret, {
    OPENAI_API_KEY: '',
    ALICE_API_KEY: '',
    ALICE_API_URL: ''
  });

  audit('secrets_clear', { by: req.user.sub });
  res.json({ ok: true, stored: buildSecretStatus(jwtSecret) });
});

app.post('/api/settings/apply-tier', auth, (req, res) => {
  const { tier } = req.body || {};
  if (!['strong', 'budget'].includes(tier)) {
    return res.status(400).json({ error: 'tier должен быть strong или budget' });
  }

  const runtimeEnv = mergeEnvWithSecrets(process.env, jwtSecret);
  const profiles = getTierProfiles(runtimeEnv);
  const selected = profiles[tier];

  const db = readDb();
  db.settings = {
    ...db.settings,
    llmProvider: selected.provider,
    llmModel: selected.model
  };

  writeDb(db);
  audit('settings_apply_tier', {
    by: req.user.sub,
    tier,
    llmProvider: selected.provider,
    llmModel: selected.model,
    ready: selected.ready
  });

  res.json({
    tier,
    selected,
    settings: db.settings
  });
});
app.post('/api/documents/upload', auth, upload.array('files', 100), (req, res) => {
  const db = readDb();
  const settings = db.settings;
  const files = req.files || [];

  if (files.length > settings.maxBatchFiles) {
    return res.status(400).json({ error: `Слишком много файлов в пакете. Максимум: ${settings.maxBatchFiles}` });
  }

  const created = [];
  for (const file of files) {
    const mb = file.size / 1024 / 1024;
    if (mb > settings.maxFileMb) continue;

    const doc = {
      id: nextId('doc'),
      originalName: file.originalname,
      storedName: file.filename,
      mimeType: file.mimetype,
      size: file.size,
      path: file.path,
      uploadedAt: new Date().toISOString()
    };
    db.documents.push(doc);
    created.push(doc);
  }

  writeDb(db);
  audit('upload', { by: req.user.sub, count: created.length });
  res.json({ uploaded: created, skipped: files.length - created.length });
});

app.get('/api/documents', auth, (req, res) => {
  const db = readDb();
  res.json(db.documents);
});

app.post('/api/analyze', auth, async (req, res) => {
  const { documentIds } = req.body || {};
  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    return res.status(400).json({ error: 'Передайте documentIds' });
  }

  const db = readDb();
  const docs = db.documents.filter((d) => documentIds.includes(d.id));
  const results = [];

  for (const doc of docs) {
    try {
      const extracted = await extractText(doc.path, doc.mimeType);
      const runtimeEnv = mergeEnvWithSecrets(process.env, jwtSecret);

      const analysis = await runAnalysisWithConfig({
        extractedText: extracted.text,
        settings: db.settings,
        runtimeEnv
      });

      const record = {
        id: nextId('analysis'),
        documentId: doc.id,
        documentName: doc.originalName,
        analyzedAt: new Date().toISOString(),
        extractionMeta: extracted.meta,
        settingsSnapshot: {
          profile: db.settings.profile,
          side: db.settings.side,
          llmProvider: db.settings.llmProvider,
          llmModel: db.settings.llmModel,
          llmTimeoutMs: db.settings.llmTimeoutMs,
          refineEnabled: db.settings.refineEnabled,
          maxRefineRounds: db.settings.maxRefineRounds,
          additionalPrompt: db.settings.additionalPrompt,
          checklist: db.settings.checklist
        },
        llm: {
          provider: db.settings.llmProvider,
          model: db.settings.llmModel
        },
        result: analysis
      };

      db.analyses.push(record);
      results.push(record);
    } catch (e) {
      results.push({
        documentId: doc.id,
        documentName: doc.originalName,
        error: e.message
      });
    }
  }

  writeDb(db);
  audit('analyze', {
    by: req.user.sub,
    docs: docs.length,
    llmProvider: db.settings.llmProvider,
    llmModel: db.settings.llmModel
  });
  res.json(results);
});

async function executeCompareRun({ runId, user, documentIds, quickMode }) {
  const db = readDb();
  const runtimeEnv = mergeEnvWithSecrets(process.env, jwtSecret);
  const profiles = getTierProfiles(runtimeEnv);

  const docs = db.documents.filter((d) => documentIds.includes(d.id));
  if (!docs.length) {
    throw new Error('Документы не найдены');
  }

  const baseSettings = {
    side: db.settings.side,
    checklist: db.settings.checklist,
    additionalPrompt: db.settings.additionalPrompt,
    llmTimeoutMs: db.settings.llmTimeoutMs,
    refineEnabled: db.settings.refineEnabled,
    maxRefineRounds: db.settings.maxRefineRounds
  };

  const compareDocs = [];
  const diffRows = [];
  const errors = [];

  for (const doc of docs) {
    setDocJobState(runId, doc.id, { status: 'running', stage: 'extract', message: 'Извлечение текста' });
    try {
      const extracted = await extractText(doc.path, doc.mimeType);

      const strongSettings = {
        ...baseSettings,
        llmProvider: profiles.strong.provider,
        llmModel: profiles.strong.model,
        refineEnabled: false,
        maxRefineRounds: 0
      };

      const budgetSettings = {
        ...baseSettings,
        llmProvider: profiles.budget.provider,
        llmModel: profiles.budget.model,
        refineEnabled: false,
        maxRefineRounds: 0
      };

      let strongResult = null;
      let budgetResult = null;
      let strongError = null;
      let budgetError = null;
      let strongDurationMs = null;
      let budgetDurationMs = null;

      const strongStartedAt = Date.now();
      try {
        setDocJobState(runId, doc.id, { stage: 'strong_base', message: 'Сильная модель: базовый проход' });
        strongResult = await runAnalysisWithConfig({
          extractedText: extracted.text,
          settings: strongSettings,
          runtimeEnv
        });
      } catch (e) {
        strongError = String(e.message || e);
        errors.push({ documentName: doc.originalName, model: 'strong', error: strongError });
      } finally {
        strongDurationMs = Date.now() - strongStartedAt;
      }

      const budgetStartedAt = Date.now();
      try {
        setDocJobState(runId, doc.id, { stage: 'budget_base', message: 'Бюджетная модель: базовый проход' });
        budgetResult = await runAnalysisWithConfig({
          extractedText: extracted.text,
          settings: budgetSettings,
          runtimeEnv
        });
      } catch (e) {
        budgetError = String(e.message || e);
        errors.push({ documentName: doc.originalName, model: 'budget', error: budgetError });
      } finally {
        budgetDurationMs = Date.now() - budgetStartedAt;
      }

      const strongMapBase = toFindingsMap(strongResult?.findings || []);
      const budgetMapBase = toFindingsMap(budgetResult?.findings || []);
      const disputedParameters = [];
      for (const parameter of db.settings.checklist) {
        const strongStatus = (strongMapBase[parameter] || {}).status || 'unclear';
        const budgetStatus = (budgetMapBase[parameter] || {}).status || 'unclear';
        if (strongResult && budgetResult && strongStatus !== budgetStatus) disputedParameters.push(parameter);
      }

      const canRefine = !quickMode && baseSettings.refineEnabled && baseSettings.maxRefineRounds > 0;
      if (canRefine && disputedParameters.length) {
        if (strongResult) {
          setDocJobState(runId, doc.id, { stage: 'strong_refine', message: 'Сильная модель: refine спорных параметров' });
          strongResult = await refineOnlyDisputed({
            analysis: strongResult,
            extractedText: extracted.text,
            settings: strongSettings,
            runtimeEnv,
            parameters: disputedParameters
          });
        }
        if (budgetResult) {
          setDocJobState(runId, doc.id, { stage: 'budget_refine', message: 'Бюджетная модель: refine спорных параметров' });
          budgetResult = await refineOnlyDisputed({
            analysis: budgetResult,
            extractedText: extracted.text,
            settings: budgetSettings,
            runtimeEnv,
            parameters: disputedParameters
          });
        }
      }

      const strongMap = toFindingsMap(strongResult?.findings || []);
      const budgetMap = toFindingsMap(budgetResult?.findings || []);
      const rows = [];

      for (const parameter of db.settings.checklist) {
        const strongFinding = strongMap[parameter] || { status: 'unclear', evidence: [] };
        const budgetFinding = budgetMap[parameter] || { status: 'unclear', evidence: [] };
        const mismatch = strongResult && budgetResult ? strongFinding.status !== budgetFinding.status : false;

        rows.push({
          parameter,
          strongStatus: strongFinding.status,
          budgetStatus: budgetFinding.status,
          mismatch,
          strongEvidence: (strongFinding.evidence || []).slice(0, 2),
          budgetEvidence: (budgetFinding.evidence || []).slice(0, 2)
        });

        if (mismatch) {
          diffRows.push({
            documentName: doc.originalName,
            parameter,
            strongStatus: strongFinding.status,
            budgetStatus: budgetFinding.status
          });
        }
      }

      compareDocs.push({
        documentId: doc.id,
        documentName: doc.originalName,
        strong: {
          provider: profiles.strong.provider,
          model: profiles.strong.model,
          score: strongResult?.score ?? null,
          riskLevel: strongResult?.summary?.riskLevel || null,
          durationMs: strongDurationMs,
          usage: strongResult?.usage ?? null,
          error: strongError
        },
        budget: {
          provider: profiles.budget.provider,
          model: profiles.budget.model,
          score: budgetResult?.score ?? null,
          riskLevel: budgetResult?.summary?.riskLevel || null,
          durationMs: budgetDurationMs,
          usage: budgetResult?.usage ?? null,
          error: budgetError
        },
        rows
      });

      setDocJobState(runId, doc.id, { status: 'done', stage: 'done', message: 'Готово' });
    } catch (docError) {
      const errorText = String(docError.message || docError);
      errors.push({
        documentName: doc.originalName,
        model: 'document',
        error: errorText
      });
      setDocJobState(runId, doc.id, { status: 'error', stage: 'error', message: errorText });
    }
  }

  let promptSuggestion = {
    improvedPrompt: sanitizeAdditionalPrompt(db.settings.additionalPrompt),
    rationale: ['Сильная модель недоступна для генерации рекомендации по промпту.']
  };

  if (diffRows.length > 0) {
    try {
      promptSuggestion = await runStrongPromptSuggestion({
        provider: profiles.strong.provider,
        model: profiles.strong.model,
        side: db.settings.side,
        checklist: db.settings.checklist,
        additionalPrompt: db.settings.additionalPrompt,
        comparisonRows: diffRows,
        env: runtimeEnv
      });
    } catch (e) {
      promptSuggestion = {
        improvedPrompt: sanitizeAdditionalPrompt(db.settings.additionalPrompt),
        rationale: ['Не удалось получить предложение сильной модели: ' + String(e.message || e)]
      };
      errors.push({ model: 'strong_prompt_suggestion', error: String(e.message || e) });
    }
  }

  const comparison = {
    id: nextId('cmp'),
    createdAt: new Date().toISOString(),
    side: db.settings.side,
    additionalPrompt: db.settings.additionalPrompt,
    quickMode: Boolean(quickMode),
    strongProfile: profiles.strong,
    budgetProfile: profiles.budget,
    documents: compareDocs,
    mismatches: diffRows,
    errors,
    promptSuggestion
  };

  db.comparisons.push(comparison);
  writeDb(db);

  audit('compare_run', {
    by: user,
    docs: docs.length,
    mismatches: diffRows.length,
    errors: errors.length,
    quickMode: Boolean(quickMode),
    strongModel: profiles.strong.model,
    budgetModel: profiles.budget.model
  });

  return comparison;
}

app.post('/api/compare/run', auth, async (req, res) => {
  try {
    const { documentIds, quickMode } = req.body || {};
    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      return res.status(400).json({ error: 'Передайте documentIds для сравнения' });
    }

    const db = readDb();
    const runtimeEnv = mergeEnvWithSecrets(process.env, jwtSecret);
    const profiles = getTierProfiles(runtimeEnv);

    if (!profiles.strong.ready || !profiles.budget.ready) {
      return res.status(400).json({ error: 'Для сравнения необходимо задать ключи для сильной и бюджетной модели в Настройках.' });
    }

    const docs = db.documents.filter((d) => documentIds.includes(d.id));
    if (!docs.length) {
      return res.status(404).json({ error: 'Документы не найдены' });
    }

    const runId = nextId('cmpjob');
    createCompareJob({ id: runId, user: req.user.sub, docs, quickMode: Boolean(quickMode) });

    setImmediate(async () => {
      try {
        const comparison = await executeCompareRun({ runId, user: req.user.sub, documentIds, quickMode: Boolean(quickMode) });
        updateCompareJob(runId, (job) => {
          job.status = 'done';
          job.finishedAt = new Date().toISOString();
          job.comparisonId = comparison.id;
          job.result = comparison;
        });
      } catch (e) {
        updateCompareJob(runId, (job) => {
          job.status = 'failed';
          job.finishedAt = new Date().toISOString();
          job.error = String(e.message || e);
        });
      }
    });

    res.status(202).json({ runId, status: 'running' });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка запуска сравнения: ' + String(e.message || e) });
  }
});

app.get('/api/compare/progress/:runId', auth, (req, res) => {
  const runId = req.params.runId;
  const job = compareJobs.get(runId);
  if (!job) return res.status(404).json({ error: 'Прогресс по запуску не найден' });
  if (job.user !== req.user.sub) return res.status(403).json({ error: 'Нет доступа к запуску' });
  res.json(job);
});

app.get('/api/comparisons', auth, (req, res) => {
  const db = readDb();
  const sorted = [...db.comparisons].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json(sorted);
});
app.get('/api/analyses', auth, (req, res) => {
  const db = readDb();
  res.json(db.analyses);
});

app.get('/api/export/json', auth, (req, res) => {
  const db = readDb();
  res.json({
    exportedAt: new Date().toISOString(),
    settings: db.settings,
    analyses: db.analyses
  });
});

app.get('/api/export/csv', auth, (req, res) => {
  const db = readDb();
  const rows = ['analysis_id,document,llm_provider,llm_model,parameter,status,evidence_count,score,risk'];

  for (const analysis of db.analyses) {
    const score = analysis.result?.score ?? '';
    const risk = analysis.result?.summary?.riskLevel ?? '';
    const provider = analysis.llm?.provider ?? '';
    const model = analysis.llm?.model ?? '';

    for (const f of analysis.result?.findings || []) {
      const safe = (val) => String(val ?? '').replace(/[",\n\r]/g, ' ').replace(/^([=+\-@])/, "'$1");
      rows.push([
        analysis.id,
        safe(analysis.documentName),
        safe(provider),
        safe(model),
        safe(f.parameter),
        f.status,
        (f.evidence || []).length,
        score,
        risk
      ].join(','));
    }
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="yurotdel_report.csv"');
  res.send('\uFEFF' + rows.join('\n'));
});

app.delete('/api/analyses', auth, (req, res) => {
  const db = readDb();
  db.analyses = [];
  writeDb(db);
  audit('analyses_clear', { by: req.user.sub });
  res.json({ ok: true });
});

app.get('/settings', (_, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'settings.html'));
});

app.get('/compare', (_, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'compare.html'));
});

app.get('*', (_, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`ЮрОтдел MVP запущен: http://localhost:${port}`);
});
