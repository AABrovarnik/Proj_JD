const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const fs = require('fs');

async function extractText(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();

  if (mimeType === 'application/pdf' || ext === '.pdf') {
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return {
      text: data.text || '',
      meta: { pages: data.numpages || null, parser: 'pdf-parse' }
    };
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    const result = await mammoth.extractRawText({ path: filePath });
    return {
      text: result.value || '',
      meta: { pages: null, parser: 'mammoth' }
    };
  }

  throw new Error('Неподдерживаемый формат. Разрешены только PDF и DOCX.');
}

module.exports = { extractText };
