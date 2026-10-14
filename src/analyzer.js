function getKeywords(param) {
  const map = {
    'Стороны договора': ['арендатор', 'арендодатель', 'стороны'],
    'Предмет аренды (адрес, площадь, кадастровый номер)': ['предмет', 'адрес', 'площад', 'кадастров'],
    'Срок аренды': ['срок аренды', 'дата начала', 'дата окончания', 'действует до'],
    'Арендная плата и порядок оплаты': ['арендная плата', 'оплата', 'ежемесячно', 'руб'],
    'Индексация': ['индексац', 'изменение платы', 'увеличение платы'],
    'Обеспечительный платёж': ['обеспечительный', 'депозит', 'гарантийный платеж'],
    'Ответственность и штрафы': ['ответственност', 'штраф', 'неустойк', 'пени'],
    'Расторжение': ['расторжен', 'односторонний отказ', 'прекращение договора'],
    'Капитальный/текущий ремонт': ['капитальн', 'текущ', 'ремонт'],
    'Неотделимые улучшения': ['неотделим', 'улучшени', 'возмещен']
  };
  return map[param] || [];
}

function findSnippets(text, keyword, limit = 2) {
  const chunks = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  const keywordLc = keyword.toLowerCase();
  for (const chunk of chunks) {
    if (chunk.toLowerCase().includes(keywordLc)) {
      out.push(chunk.slice(0, 220));
      if (out.length >= limit) break;
    }
  }
  return out;
}

function scoreStatus(status) {
  if (status === 'found') return 1;
  if (status === 'partial') return 0.5;
  return 0;
}

function analyzeText(text, checklist, side) {
  const findings = [];
  const lc = text.toLowerCase();

  for (const param of checklist) {
    const keys = getKeywords(param);
    const matched = keys.filter((k) => lc.includes(k.toLowerCase()));

    let status = 'not_found';
    if (matched.length >= 2) status = 'found';
    else if (matched.length === 1) status = 'partial';

    const evidence = matched.flatMap((key) => findSnippets(text, key, 1)).slice(0, 2);

    findings.push({
      parameter: param,
      status,
      evidence,
      missingInfo: status === 'found' ? '' : `Уточнить формулировки по параметру: ${param}`
    });
  }

  const score = Math.round(
    (findings.reduce((acc, item) => acc + scoreStatus(item.status), 0) / Math.max(findings.length, 1)) * 100
  );

  const majorRisks = findings
    .filter((x) => x.status !== 'found')
    .slice(0, 5)
    .map((x) => `${x.parameter}: ${x.status === 'partial' ? 'частично' : 'не найдено'}`);

  const recommendations = findings
    .filter((x) => x.status !== 'found')
    .slice(0, 5)
    .map((x) => `Добавить/уточнить раздел «${x.parameter}».`);

  return {
    profile: 'rf_non_residential',
    side,
    score,
    findings,
    summary: {
      riskLevel: score >= 80 ? 'low' : score >= 60 ? 'medium' : 'high',
      majorRisks,
      recommendations
    },
    warnings: [
      'MVP-режим: эвристический анализ без внешней LLM-модели.',
      'Результат требует юридической проверки перед принятием решения.'
    ]
  };
}

module.exports = { analyzeText };
