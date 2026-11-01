'use strict';
const express = require('express');
const dbm = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const mailer = require('../lib/mailer');
const { randomToken, sha256, nowIso } = require('../lib/util');

const router = express.Router();
const db = () => dbm.get();

function safeReturn(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Entrar', email: '', voltar: req.query.voltar || '/', error: null });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');
  const voltar = safeReturn(req.body.voltar);
  const key = `${req.ip}|${email}`;
  const fail = (error) => res.status(401).render('auth/login', { title: 'Entrar', email, voltar, error });
  if (auth.tooManyAttempts(key)) return fail('Muitas tentativas seguidas. Aguarde 15 minutos e tente novamente.');
  const user = db().prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (user && !user.password_hash) {
    return fail('Você ainda não criou a sua senha. Use o link do convite enviado por e-mail ou peça um novo convite ao RH.');
  }
  if (!user || !auth.verifyPassword(senha, user.password_hash)) {
    auth.registerFailure(key);
    audit.log({ ip: req.ip }, 'login_falhou', { details: { email } });
    return fail('E-mail ou senha incorretos.');
  }
  auth.clearFailures(key);
  auth.createSession(res, user.id);
  db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  audit.log({ realUser: user, ip: req.ip }, 'login');
  return res.redirect(user.must_change_password ? '/conta?primeiro=1' : voltar);
});

router.post('/logout', (req, res) => {
  if (req.realUser) audit.log(req, 'logout');
  auth.destroySession(req, res);
  res.redirect('/login');
});

/* --------------------------------------------------- esqueci minha senha */

router.get('/esqueci-senha', (req, res) => {
  res.render('auth/esqueci', { title: 'Esqueci minha senha', sent: false, email: '' });
});

router.post('/esqueci-senha', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const key = `reset|${req.ip}`;
    if (!auth.tooManyAttempts(key)) {
      auth.registerFailure(key);
      const user = db().prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
      if (user) {
        const token = randomToken();
        const exp = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
        db().prepare('UPDATE users SET reset_token_hash = ?, reset_expires = ? WHERE id = ?').run(sha256(token), exp, user.id);
        await mailer.queue(mailer.templates.redefinirSenha(user, token));
      }
    }
    res.render('auth/esqueci', { title: 'Esqueci minha senha', sent: true, email });
  } catch (err) { next(err); }
});

function findByToken(column, expiresColumn, token) {
  const user = db().prepare(`SELECT * FROM users WHERE ${column} = ? AND active = 1`).get(sha256(token));
  if (!user || !user[expiresColumn] || user[expiresColumn] < nowIso()) return null;
  return user;
}

function renderPasswordForm(res, mode, user, token, error = null, status = 200) {
  res.status(status).render('auth/senha', {
    title: mode === 'convite' ? 'Criar senha' : 'Redefinir senha', mode, person: user, token, error,
  });
}

router.get('/redefinir-senha/:token', (req, res) => {
  const user = findByToken('reset_token_hash', 'reset_expires', req.params.token);
  if (!user) return res.status(400).render('error', { title: 'Link inválido', message: 'Este link de redefinição expirou ou já foi usado. Peça um novo em "Esqueci minha senha".' });
  return renderPasswordForm(res, 'reset', user, req.params.token);
});

router.post('/redefinir-senha/:token', (req, res) => {
  const user = findByToken('reset_token_hash', 'reset_expires', req.params.token);
  if (!user) return res.status(400).render('error', { title: 'Link inválido', message: 'Este link de redefinição expirou ou já foi usado.' });
  const { senha, confirmacao } = req.body;
  const problems = auth.passwordProblems(senha);
  if (problems.length) return renderPasswordForm(res, 'reset', user, req.params.token, `A senha precisa ${problems.join(', ')}.`, 400);
  if (senha !== confirmacao) return renderPasswordForm(res, 'reset', user, req.params.token, 'A confirmação não confere com a senha.', 400);
  db().prepare('UPDATE users SET password_hash = ?, must_change_password = 0, reset_token_hash = NULL, reset_expires = NULL WHERE id = ?')
    .run(auth.hashPassword(senha), user.id);
  auth.destroyUserSessions(user.id);
  audit.log({ realUser: user, ip: req.ip }, 'senha_redefinida');
  auth.createSession(res, user.id);
  return res.redirect('/');
});

/* ------------------------------------------------------------- convite */

router.get('/convite/:token', (req, res) => {
  const user = findByToken('invite_token_hash', 'invite_expires', req.params.token);
  if (!user) return res.status(400).render('error', { title: 'Convite inválido', message: 'Este convite expirou ou já foi usado. Peça um novo convite ao RH ou use "Esqueci minha senha".' });
  return renderPasswordForm(res, 'convite', user, req.params.token);
});

router.post('/convite/:token', (req, res) => {
  const user = findByToken('invite_token_hash', 'invite_expires', req.params.token);
  if (!user) return res.status(400).render('error', { title: 'Convite inválido', message: 'Este convite expirou ou já foi usado.' });
  const { senha, confirmacao } = req.body;
  const problems = auth.passwordProblems(senha);
  if (problems.length) return renderPasswordForm(res, 'convite', user, req.params.token, `A senha precisa ${problems.join(', ')}.`, 400);
  if (senha !== confirmacao) return renderPasswordForm(res, 'convite', user, req.params.token, 'A confirmação não confere com a senha.', 400);
  db().prepare('UPDATE users SET password_hash = ?, must_change_password = 0, invite_token_hash = NULL, invite_expires = NULL WHERE id = ?')
    .run(auth.hashPassword(senha), user.id);
  audit.log({ realUser: user, ip: req.ip }, 'convite_aceito');
  auth.createSession(res, user.id);
  return res.redirect('/');
});

module.exports = router;
