'use strict';
const express = require('express');
const dbm = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const mailer = require('../lib/mailer');
const { randomToken, sha256, nowIso } = require('../lib/util');

const router = require('../lib/async-router')();

function safeReturn(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

router.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Entrar', email: '', voltar: req.query.voltar || '/', error: null });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');
  const voltar = safeReturn(req.body.voltar);
  const key = `${req.ip}|${email}`;
  const fail = (error) => res.status(401).render('auth/login', { title: 'Entrar', email, voltar, error });
  if (auth.tooManyAttempts(key)) return fail('Muitas tentativas seguidas. Aguarde 15 minutos e tente novamente.');
  const user = await dbm.get('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1', email);
  if (user && !user.password_hash) {
    return fail('Você ainda não criou a sua senha. Use o link do convite enviado por e-mail ou peça um novo convite ao RH.');
  }
  if (!user || !auth.verifyPassword(senha, user.password_hash)) {
    auth.registerFailure(key);
    await audit.log({ ip: req.ip }, 'login_falhou', { details: { email } });
    return fail('E-mail ou senha incorretos.');
  }
  auth.clearFailures(key);
  await auth.createSession(res, user.id);
  await dbm.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
  await audit.log({ realUser: user, ip: req.ip }, 'login');
  return res.redirect(user.must_change_password ? '/conta?primeiro=1' : voltar);
});

router.post('/logout', async (req, res) => {
  if (req.realUser) await audit.log(req, 'logout');
  await auth.destroySession(req, res);
  res.redirect('/login');
});

/* --------------------------------------------------- esqueci minha senha */

router.get('/esqueci-senha', async (req, res) => {
  res.render('auth/esqueci', { title: 'Esqueci minha senha', sent: false, email: '' });
});

router.post('/esqueci-senha', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const key = `reset|${req.ip}`;
    if (!auth.tooManyAttempts(key)) {
      auth.registerFailure(key);
      const user = await dbm.get('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1', email);
      if (user) {
        const token = randomToken();
        const exp = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
        await dbm.run('UPDATE users SET reset_token_hash = ?, reset_expires = ? WHERE id = ?', sha256(token), exp, user.id);
        await mailer.queue(mailer.templates.redefinirSenha(user, token));
      }
    }
    res.render('auth/esqueci', { title: 'Esqueci minha senha', sent: true, email });
  } catch (err) { next(err); }
});

async function findByToken(column, expiresColumn, token) {
  const user = await dbm.get(`SELECT * FROM users WHERE ${column} = ? AND active = 1`, sha256(token));
  if (!user || !user[expiresColumn] || user[expiresColumn] < nowIso()) return null;
  return user;
}

function renderPasswordForm(res, mode, user, token, error = null, status = 200) {
  res.status(status).render('auth/senha', {
    title: mode === 'convite' ? 'Criar senha' : 'Redefinir senha', mode, person: user, token, error,
  });
}

router.get('/redefinir-senha/:token', async (req, res) => {
  const user = await findByToken('reset_token_hash', 'reset_expires', req.params.token);
  if (!user) return res.status(400).render('error', { title: 'Link inválido', message: 'Este link de redefinição expirou ou já foi usado. Peça um novo em "Esqueci minha senha".' });
  return renderPasswordForm(res, 'reset', user, req.params.token);
});

router.post('/redefinir-senha/:token', async (req, res) => {
  const user = await findByToken('reset_token_hash', 'reset_expires', req.params.token);
  if (!user) return res.status(400).render('error', { title: 'Link inválido', message: 'Este link de redefinição expirou ou já foi usado.' });
  const { senha, confirmacao } = req.body;
  const problems = auth.passwordProblems(senha);
  if (problems.length) return renderPasswordForm(res, 'reset', user, req.params.token, `A senha precisa ${problems.join(', ')}.`, 400);
  if (senha !== confirmacao) return renderPasswordForm(res, 'reset', user, req.params.token, 'A confirmação não confere com a senha.', 400);
  await dbm.run('UPDATE users SET password_hash = ?, must_change_password = 0, reset_token_hash = NULL, reset_expires = NULL WHERE id = ?', auth.hashPassword(senha), user.id);
  await auth.destroyUserSessions(user.id);
  await audit.log({ realUser: user, ip: req.ip }, 'senha_redefinida');
  await auth.createSession(res, user.id);
  return res.redirect('/');
});

/* ------------------------------------------------------------- convite */

router.get('/convite/:token', async (req, res) => {
  const user = await findByToken('invite_token_hash', 'invite_expires', req.params.token);
  if (!user) return res.status(400).render('error', { title: 'Convite inválido', message: 'Este convite expirou ou já foi usado. Peça um novo convite ao RH ou use "Esqueci minha senha".' });
  return renderPasswordForm(res, 'convite', user, req.params.token);
});

router.post('/convite/:token', async (req, res) => {
  const user = await findByToken('invite_token_hash', 'invite_expires', req.params.token);
  if (!user) return res.status(400).render('error', { title: 'Convite inválido', message: 'Este convite expirou ou já foi usado.' });
  const { senha, confirmacao } = req.body;
  const problems = auth.passwordProblems(senha);
  if (problems.length) return renderPasswordForm(res, 'convite', user, req.params.token, `A senha precisa ${problems.join(', ')}.`, 400);
  if (senha !== confirmacao) return renderPasswordForm(res, 'convite', user, req.params.token, 'A confirmação não confere com a senha.', 400);
  await dbm.run('UPDATE users SET password_hash = ?, must_change_password = 0, invite_token_hash = NULL, invite_expires = NULL WHERE id = ?', auth.hashPassword(senha), user.id);
  await audit.log({ realUser: user, ip: req.ip }, 'convite_aceito');
  await auth.createSession(res, user.id);
  return res.redirect('/');
});

module.exports = router;
