const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRETS_PATH = path.join(process.cwd(), 'data', 'secrets.enc.json');

function deriveKey(master) {
  return crypto.createHash('sha256').update(String(master || 'change-me-local')).digest();
}

function encryptText(plain, master) {
  const iv = crypto.randomBytes(12);
  const key = deriveKey(master);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64')
  };
}

function decryptText(payload, master) {
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const key = deriveKey(master);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

function readSecrets(master) {
  if (!fs.existsSync(SECRETS_PATH)) return {};
  const raw = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    try {
      out[key] = decryptText(value, master);
    } catch {
      out[key] = '';
    }
  }
  return out;
}

function writeSecrets(secrets, master) {
  const enc = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (value) enc[key] = encryptText(value, master);
  }
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(enc, null, 2), 'utf-8');
}

function saveSecretsPatch(master, patch) {
  const current = readSecrets(master);
  for (const [key, value] of Object.entries(patch || {})) {
    const normalized = String(value || '').trim();
    if (normalized) current[key] = normalized;
    else delete current[key];
  }
  writeSecrets(current, master);
  return current;
}

function buildSecretStatus(master) {
  const s = readSecrets(master);
  return {
    openaiApiKeySet: Boolean(s.OPENAI_API_KEY),
    aliceApiKeySet: Boolean(s.ALICE_API_KEY),
    aliceApiUrlSet: Boolean(s.ALICE_API_URL)
  };
}

function mergeEnvWithSecrets(env, master) {
  const s = readSecrets(master);
  return {
    ...env,
    OPENAI_API_KEY: env.OPENAI_API_KEY || s.OPENAI_API_KEY || '',
    ALICE_API_KEY: env.ALICE_API_KEY || s.ALICE_API_KEY || '',
    ALICE_API_URL: env.ALICE_API_URL || s.ALICE_API_URL || ''
  };
}

module.exports = {
  buildSecretStatus,
  mergeEnvWithSecrets,
  saveSecretsPatch
};
