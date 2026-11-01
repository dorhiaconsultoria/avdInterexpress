'use strict';
// Sessões, senha, CSRF, mensagens rápidas (flash) e controle de perfis.
const bcrypt = require('bcryptjs');
const dbm = require('../db');
const config = require('../config');
const { randomToken, sha256, nowIso } = require('./util');

const COOKIE = 'ie_sid';
const db = () => dbm.get();

function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10);
}

function verifyPassword(pw, hash) {
  if (!hash || !pw) return false;
  try { return bcrypt.compareSync(pw, hash); } catch { return false; }
}

function passwordProblems(pw) {
  const problems = [];
  if (!pw || pw.length < 8) problems.push('ter pelo menos 8 caracteres');
  if (!/[A-Za-zÀ-ÿ]/.test(pw || '')) problems.push('conter letras');
  if (!/\d/.test(pw || '')) problems.push('conter números');
  return problems;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieOptions(maxAgeMs) {
  return { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: maxAgeMs };
}

function createSession(res, userId) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionHours * 3600 * 1000);
  db().prepare('INSERT INTO sessions (id, user_id, csrf, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(sha256(token), userId, randomToken(24), now.toISOString(), expires.toISOString());
  res.cookie(COOKIE, token, cookieOptions(config.sessionHours * 3600 * 1000));
}

function destroySession(req, res) {
  if (req.sessionRow) db().prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionRow.id);
  res.clearCookie(COOKIE, { path: '/' });
}

function destroyUserSessions(userId, exceptSessionId = null) {
  db().prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, exceptSessionId);
}

/** Carrega a sessão, o usuário real e o usuário efetivo ("entrar como", só no modo de teste). */
function loadSession(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.sessionRow = null;
  req.realUser = null;
  req.user = null;
  if (token) {
    const row = db().prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(token));
    if (row && row.expires_at > nowIso()) {
      const real = db().prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(row.user_id);
      if (real) {
        req.sessionRow = row;
        req.realUser = real;
        req.user = real;
        if (row.acting_as_user_id && real.is_admin && dbm.isTestMode()) {
          const acting = db().prepare('SELECT * FROM users WHERE id = ?').get(row.acting_as_user_id);
          if (acting) req.user = acting;
        } else if (row.acting_as_user_id) {
          db().prepare('UPDATE sessions SET acting_as_user_id = NULL WHERE id = ?').run(row.id);
        }
        // Renovação deslizante da sessão
        const newExp = new Date(Date.now() + config.sessionHours * 3600 * 1000).toISOString();
        db().prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(newExp, row.id);
      }
    } else if (row) {
      db().prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    }
  }
  req.impersonating = !!(req.user && req.realUser && req.user.id !== req.realUser.id);
  next();
}

function flash(req, type, message) {
  if (!req.sessionRow) return;
  const list = req.sessionRow.flash ? JSON.parse(req.sessionRow.flash) : [];
  list.push({ type, message });
  req.sessionRow.flash = JSON.stringify(list);
  db().prepare('UPDATE sessions SET flash = ? WHERE id = ?').run(req.sessionRow.flash, req.sessionRow.id);
}

function takeFlash(req) {
  if (!req.sessionRow || !req.sessionRow.flash) return [];
  const list = JSON.parse(req.sessionRow.flash);
  db().prepare('UPDATE sessions SET flash = NULL WHERE id = ?').run(req.sessionRow.id);
  req.sessionRow.flash = null;
  return list;
}

function isMultipart(req) {
  return (req.headers['content-type'] || '').startsWith('multipart/form-data');
}

/** Verificação de CSRF para requisições que alteram dados (formulários e fetch). */
function csrfToken(req) {
  return req.body && req.body._csrf ? req.body._csrf : (req.get('x-csrf-token') || req.query._csrf);
}

function csrfValid(req) {
  return !!(req.sessionRow && csrfToken(req) && csrfToken(req) === req.sessionRow.csrf);
}

function csrfProtect(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || !req.sessionRow) return next();
  if (isMultipart(req)) return next(); // conferido na própria rota, depois do upload
  if (!csrfValid(req)) return res.status(403).render('error', { title: 'Sessão expirada', message: 'O formulário expirou. Volte, recarregue a página e tente novamente.' });
  return next();
}

function csrfAfterUpload(req, res, next) {
  if (!csrfValid(req)) return res.status(403).render('error', { title: 'Sessão expirada', message: 'O formulário expirou. Volte, recarregue a página e tente novamente.' });
  return next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.accepts('html')) return res.redirect(`/login?voltar=${encodeURIComponent(req.originalUrl)}`);
    return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  }
  if (req.realUser.must_change_password && !req.path.startsWith('/conta') && req.path !== '/logout') {
    return res.redirect('/conta?primeiro=1');
  }
  return next();
}

function forbidden(res, message = 'Você não tem permissão para acessar esta página.') {
  return res.status(403).render('error', { title: 'Acesso restrito', message });
}

/** Perfis: admin, rh, ceo, sgi (flags do usuário efetivo). */
function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.user;
    const ok = roles.some((r) => (r === 'admin' && u.is_admin) || (r === 'rh' && u.is_rh)
      || (r === 'ceo' && u.is_ceo) || (r === 'sgi' && u.is_sgi));
    if (!ok) return forbidden(res);
    return next();
  };
}

/* Limite simples de tentativas de login (memória do processo). */
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > 15 * 60 * 1000) return false;
  return rec.count >= 8;
}
function registerFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > 15 * 60 * 1000) attempts.set(key, { first: now, count: 1 });
  else rec.count += 1;
}
function clearFailures(key) {
  attempts.delete(key);
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, passwordProblems, createSession, destroySession, destroyUserSessions,
  loadSession, flash, takeFlash, csrfProtect, csrfAfterUpload, requireLogin, requireRole, forbidden,
  tooManyAttempts, registerFailure, clearFailures,
};
