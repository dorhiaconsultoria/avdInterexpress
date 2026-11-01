'use strict';
const path = require('path');

const fs = require('fs');

const root = path.resolve(__dirname, '..');

// Carrega o arquivo .env (se existir) sem sobrescrever variáveis já definidas no servidor.
(function loadDotEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}());
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');

module.exports = {
  root,
  dataDir,
  port: Number(process.env.PORT || 3000),
  // Endereço usado nos links dos e-mails. No Vercel, usa o domínio de produção do projeto.
  appUrl: (process.env.APP_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
    || (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`)
    || 'http://localhost:3000').replace(/\/$/, ''),
  // Senha inicial da administradora (troca obrigatória no primeiro acesso)
  adminInitialPassword: process.env.ADMIN_SENHA_INICIAL || 'Teste@2026',
  timezone: 'America/Sao_Paulo',
  sessionHours: 12,
  // No Vercel o corpo da requisição é limitado a 4,5 MB
  maxUploadMb: process.env.VERCEL ? 4 : 10,
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'InterExpress — Verificação de Competências <nao-responda@interexpress.com.br>',
  },
  secureCookies: String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true' ||
    (process.env.APP_URL || '').startsWith('https://') || !!process.env.VERCEL,
};
