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
const { runLlmAnalysis, sanitizeAdditionalPrompt } = require('./llm');

const app = express();
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET || 'change-me-local';
const adminLogin = process.env.ADMIN_LOGIN || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

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
      if (!finding.missingInfo) {
        finding.missingInfo = 'Цитаты не подтверждены исходным текстом';
      }
    }
  }

  return warnings;
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
    llmModel: String(payload.llmModel ?? db.settings.llmModel)
  };

  writeDb(db);
  audit('settings_update', { by: req.user.sub, llmProvider: db.settings.llmProvider });
  res.json(db.settings);
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

      const llmResult = await runLlmAnalysis({
        provider: db.settings.llmProvider,
        model: db.settings.llmModel,
        text: extracted.text,
        checklist: db.settings.checklist,
        side: db.settings.side,
        additionalPrompt: db.settings.additionalPrompt,
        env: process.env
      });

      const findings = Array.isArray(llmResult.findings) ? llmResult.findings : [];
      const evidenceWarnings = validateEvidence(findings, extracted.text);

      const score = computeScore(findings);
      const analysis = {
        ...llmResult,
        findings,
        score,
        summary: {
          ...(llmResult.summary || {}),
          riskLevel: inferRiskLevel(score)
        },
        warnings: [...new Set([...(llmResult.warnings || []), ...evidenceWarnings])]
      };

      const record = {
        id: nextId('analysis'),
        documentId: doc.id,
        documentName: doc.originalName,
        analyzedAt: new Date().toISOString(),
        extractionMeta: extracted.meta,
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

app.get('*', (_, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`ЮрОтдел MVP запущен: http://localhost:${port}`);
});
