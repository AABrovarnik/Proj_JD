const Ajv = require('ajv');

const findingSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['parameter', 'status', 'evidence'],
  properties: {
    parameter: { type: 'string', minLength: 1 },
    applicability: { enum: ['applicable', 'not_applicable', 'unclear'] },
    status: { enum: ['found', 'partial', 'not_found', 'unclear'] },
    extractedValues: { type: 'object' },
    missingSubfields: {
      type: 'array',
      items: { type: 'string' }
    },
    explanation: { type: 'string' },
    missingInfo: { type: 'string' },
    evidence: {
      type: 'array',
      items: { type: 'string' }
    }
  }
};

const analysisSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['findings', 'summary'],
  properties: {
    profile: { type: 'string' },
    side: { type: 'string' },
    findings: {
      type: 'array',
      minItems: 1,
      items: findingSchema
    },
    summary: {
      type: 'object',
      additionalProperties: true,
      required: ['riskLevel', 'majorRisks', 'recommendations'],
      properties: {
        riskLevel: { enum: ['low', 'medium', 'high'] },
        majorRisks: { type: 'array', items: { type: 'string' } },
        recommendations: { type: 'array', items: { type: 'string' } }
      }
    },
    warnings: {
      type: 'array',
      items: { type: 'string' }
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateAnalysisResult = ajv.compile(analysisSchema);
const validateFinding = ajv.compile(findingSchema);

function formatAjvErrors(errors = []) {
  return errors
    .slice(0, 12)
    .map((e) => `${e.instancePath || '/'} ${e.message || 'validation error'}`)
    .join('; ');
}

module.exports = {
  validateAnalysisResult,
  validateFinding,
  formatAjvErrors
};
