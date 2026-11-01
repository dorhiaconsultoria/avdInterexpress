'use strict';
const express = require('express');
const dbm = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const domain = require('../lib/domain');
const tasks = require('../lib/tasks');
const reports = require('../lib/reports');
const mailer = require('../lib/mailer');
const { EMAIL_DOMAIN_TESTE } = require('../db/seed-data');

const router = require('../lib/async-router')();

function evalStatus(ev) {
  if (!ev) return 'pendente';
  return ev.status;
}

async function myChecklistCards(userId, cycle) {
  if (!cycle) return [];
  return Promise.all((await domain.listChecklists(cycle.id, 'AND cl.user_id = ?', [userId])).map(async (cl) => {
    const b = await domain.loadChecklistBundle(cl.id);
    return {
      cl,
      stage: b.stage,
      auto: evalStatus(b.evals.auto),
      gestor: evalStatus(b.evals.gestor),
      released: !!cl.results_released_at || !!cl.self_verification,
      plan: b.plan,
      sigs: b.sigs,
      evaluatorLabel: domain.evaluatorLabel(cl),
      progressAuto: domain.evaluationProgress(b.comps.applicable, b.evals.auto),
      progressGestor: domain.evaluationProgress(b.comps.applicable, b.evals.gestor),
    };
  }));
}

async function teamRows(userId, cycle) {
  if (!cycle) return [];
  return Promise.all((await domain.listChecklists(cycle.id, 'AND cl.evaluator_user_id = ? AND cl.self_verification = 0', [userId])).map(async (cl) => {
    const b = await domain.loadChecklistBundle(cl.id);
    return {
      cl,
      stage: b.stage,
      auto: evalStatus(b.evals.auto),
      gestor: evalStatus(b.evals.gestor),
      released: !!cl.results_released_at,
      plan: b.plan,
      sigs: b.sigs,
      gaps: b.gaps.length,
      progressGestor: domain.evaluationProgress(b.comps.applicable, b.evals.gestor),
    };
  }));
}

async function adminAlerts(cycle) {
  const alerts = [];
  if (await dbm.isTestMode()) {
    alerts.push({ type: 'warn', text: 'O sistema está em modo de teste: nenhum e-mail é enviado. Quando terminar os ajustes, use "Colocar no ar".', href: '/admin/teste', cta: 'Modo de teste' });
  }
  const fict = (await dbm.get('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND email LIKE ?', `%@${EMAIL_DOMAIN_TESTE}`)).n;
  if (fict) alerts.push({ type: 'info', text: `${fict} pessoa(s) ainda com e-mail fictício. Cadastre os e-mails reais (manualmente ou por planilha).`, href: '/admin/pessoas', cta: 'Pessoas' });
  if (cycle) {
    const semValidador = await domain.listChecklists(cycle.id, 'AND cl.self_verification = 1 AND cl.validator_user_id IS NULL');
    for (const cl of semValidador) {
      if (await domain.hasAta(cl.id)) continue;
      alerts.push({ type: 'info', text: `Defina o validador da autoverificação de ${cl.user_name} (${cl.cargo_code} — ${cl.cargo_short}) ou anexe a ata da Diretoria.`, href: `/checklists/${cl.id}#validacao`, cta: 'Definir' });
    }
    if (cycle.status === 'planejamento') alerts.push({ type: 'info', text: `${cycle.name} em planejamento. Revise as datas e inicie o ciclo.`, href: '/admin/ciclo', cta: 'Ciclo' });
  }
  if (!await dbm.isTestMode() && !mailer.smtpConfigured()) alerts.push({ type: 'error', text: 'Servidor de e-mail (SMTP) não configurado: convites e lembretes não serão entregues.', href: '/admin/emails', cta: 'E-mails' });
  return alerts;
}

router.get('/', async (req, res) => {
  const user = req.user;
  const cycle = await domain.currentCycle();
  const myTasks = await tasks.tasksForUser(user.id, cycle);
  const myCards = await myChecklistCards(user.id, cycle);
  const isManager = cycle ? await domain.isManager(user.id, cycle.id) : false;
  const team = isManager ? await teamRows(user.id, cycle) : [];
  const validations = cycle ? await domain.listChecklists(cycle.id, 'AND cl.validator_user_id = ?', [user.id]) : [];
  const general = user.is_admin || user.is_ceo || user.is_rh || user.is_sgi;
  const coverage = general && cycle ? reports.coverageOf(await reports.detailRows(await domain.listChecklists(cycle.id), cycle, null)) : null;
  const adminTasks = user.is_admin && cycle && cycle.status === 'em_andamento'
    ? (await tasks.cyclePendencias(cycle)).filter((p) => !p.userId) : [];
  const pendCount = (user.is_admin || user.is_rh) && cycle && cycle.status === 'em_andamento'
    ? (await tasks.cyclePendencias(cycle)).filter((p) => p.userId).length : 0;
  res.render('home', {
    title: 'Início',
    cycle,
    myTasks,
    myCards,
    isManager,
    team,
    validations,
    coverage,
    adminTasks,
    pendCount,
    alerts: user.is_admin ? await adminAlerts(cycle) : [],
  });
});

router.get('/equipe', async (req, res) => {
  const cycle = await domain.currentCycle();
  if (!cycle || !await domain.isManager(req.user.id, cycle.id)) return auth.forbidden(res, 'Esta página é dos gestores que avaliam uma equipe.');
  const rows = await teamRows(req.user.id, cycle);
  res.render('equipe', { title: 'Minha equipe', cycle, rows });
});

async function buildTree() {
  const vincs = await domain.listVinculos();
  const byParent = new Map();
  for (const v of vincs) {
    const parent = v.manager_vinculo_id && vincs.some((x) => x.id === v.manager_vinculo_id) ? v.manager_vinculo_id : 0;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(v);
  }
  const make = (v) => ({ ...v, children: (byParent.get(v.id) || []).map(make) });
  return (byParent.get(0) || []).map(make);
}

router.get('/organograma', auth.requireRole('admin', 'rh', 'ceo', 'sgi'), async (req, res) => {
  res.render('organograma', { title: 'Organograma', tree: await buildTree(), total: (await domain.listVinculos()).length, people: (await domain.listUsers({ activeOnly: true })).length });
});

/* --------------------------------------------------------------- conta */

router.get('/conta', async (req, res) => {
  const vincs = (await domain.listVinculos()).filter((v) => v.user_id === req.user.id);
  res.render('conta', { title: 'Minha conta', vincs, first: !!req.query.primeiro && req.realUser.must_change_password, error: null });
});

router.post('/conta/senha', async (req, res) => {
  const u = req.realUser;
  const { atual, senha, confirmacao } = req.body;
  const vincs = (await domain.listVinculos()).filter((v) => v.user_id === req.user.id);
  const fail = (error) => res.status(400).render('conta', { title: 'Minha conta', vincs, first: !!u.must_change_password, error });
  if (!auth.verifyPassword(atual, u.password_hash)) return fail('A senha atual está incorreta.');
  const problems = auth.passwordProblems(senha);
  if (problems.length) return fail(`A nova senha precisa ${problems.join(', ')}.`);
  if (senha !== confirmacao) return fail('A confirmação não confere com a nova senha.');
  if (senha === atual) return fail('A nova senha precisa ser diferente da atual.');
  await dbm.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', auth.hashPassword(senha), u.id);
  await auth.destroyUserSessions(u.id, req.sessionRow.id);
  await audit.log(req, 'senha_alterada');
  await auth.flash(req, 'success', 'Senha alterada com sucesso.');
  res.redirect('/');
});

module.exports = router;
