const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(process.cwd(), 'data', 'db.json');

const defaultChecklist = [
  'Стороны договора',
  'Предмет аренды (адрес, площадь, кадастровый номер)',
  'Срок аренды',
  'Арендная плата и порядок оплаты',
  'Индексация',
  'Обеспечительный платёж',
  'Ответственность и штрафы',
  'Расторжение',
  'Капитальный/текущий ремонт',
  'Неотделимые улучшения'
];

function withDefaults(db) {
  if (!db.settings) db.settings = {};

  db.settings = {
    profile: db.settings.profile || 'rf_non_residential',
    side: db.settings.side || 'neutral',
    maxFileMb: Number(db.settings.maxFileMb || 50),
    maxPdfPages: Number(db.settings.maxPdfPages || 200),
    maxBatchFiles: Number(db.settings.maxBatchFiles || 100),
    additionalPrompt: String(db.settings.additionalPrompt || ''),
    checklist: Array.isArray(db.settings.checklist) && db.settings.checklist.length ? db.settings.checklist : defaultChecklist,
    llmProvider: db.settings.llmProvider || 'local_mock',
    llmModel: db.settings.llmModel || 'local-heuristic-v1'
  };

  db.documents = Array.isArray(db.documents) ? db.documents : [];
  db.analyses = Array.isArray(db.analyses) ? db.analyses : [];
  db.audit = Array.isArray(db.audit) ? db.audit : [];

  return db;
}

function ensureDb() {
  if (!fs.existsSync(DATA_PATH)) {
    const seed = withDefaults({ settings: {}, documents: [], analyses: [], audit: [] });
    fs.writeFileSync(DATA_PATH, JSON.stringify(seed, null, 2), 'utf-8');
    return;
  }

  const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const normalized = withDefaults(parsed);
  fs.writeFileSync(DATA_PATH, JSON.stringify(normalized, null, 2), 'utf-8');
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
}

function writeDb(db) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(withDefaults(db), null, 2), 'utf-8');
}

function nextId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { readDb, writeDb, nextId, defaultChecklist };
