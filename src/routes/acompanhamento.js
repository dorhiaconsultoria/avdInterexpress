'use strict';
const express = require('express');
const dbm = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const domain = require('../lib/domain');
const tasks = require('../lib/tasks');
const reports = require('../lib/reports');
const reminders = require('../lib/reminders');
const mailer = require('../lib/mailer');
const { nowIso } = require('../lib/util');

const router = require('../lib/async-router')();
const only = auth.requireRole('admin', 'rh');

router.get('/acompanhamento', only, async (req, res) => {
  const cycle = await domain.currentCycle();
  const rows = cycle ? await reports.detailRows(await domain.listChecklists(cycle.id), cycle, null) : [];
  const pend = cycle && cycle.status === 'em_andamento' ? await tasks.cyclePendencias(cycle) : [];
  const groups = tasks.groupByUser(pend);
  const lastReminders = await dbm.all(`SELECT to_user_id, MAX(created_at) AS at FROM email_outbox WHERE type = 'lembrete' GROUP BY to_user_id`);
  const lastMap = Object.fromEntries(lastReminders.map((r) => [r.to_user_id, r.at]));
  res.render('acompanhamento', {
    title: 'Acompanhamento',
    cycle,
    rows,
    coverage: reports.coverageOf(rows),
    groups,
    adminPend: pend.filter((p) => !p.userId),
    lastMap,
    readyToRelease: rows.filter((r) => !r.cl.self_verification && r.autoSent && r.gestorSent && !r.cl.results_released_at).length,
  });
});

router.post('/acompanhamento/lembretes', only, async (req, res, next) => {
  try {
    const cycle = await domain.currentCycle();
    if (!cycle || cycle.status !== 'em_andamento') {
      await auth.flash(req, 'error', 'O ciclo não está em andamento.');
      return res.redirect('/acompanhamento');
    }
    let ids = null;
    if (!req.body.todos) {
      ids = [].concat(req.body.user_ids || []).map(Number).filter(Boolean);
      if (!ids.length) {
        await auth.flash(req, 'error', 'Selecione ao menos uma pessoa.');
        return res.redirect('/acompanhamento');
      }
    }
    const results = await reminders.sendManualReminders(cycle, ids);
    await audit.log(req, 'enviou_lembrete', { details: { pessoas: results.map((r) => r.userName) } });
    const retained = results.filter((r) => r.status === 'retido_teste').length;
    const errors = results.filter((r) => r.status === 'erro').length;
    let msg = `${results.length} lembrete(s) gerado(s).`;
    if (retained) msg += ' Modo de teste: as mensagens ficaram retidas na caixa de saída e não foram enviadas.';
    if (errors) msg += ` ${errors} falharam; veja Administração › E-mails.`;
    await auth.flash(req, errors ? 'warn' : 'success', msg);
    return res.redirect('/acompanhamento');
  } catch (err) { return next(err); }
});

router.post('/acompanhamento/liberar-todos', auth.requireRole('admin'), async (req, res, next) => {
  try {
    const cycle = await domain.currentCycle();
    const list = await domain.listChecklists(cycle.id, "AND cl.self_verification = 0 AND cl.results_released_at IS NULL AND cl.status IN ('concluida')");
    for (const cl of list) {
      await dbm.run('UPDATE checklists SET results_released_at = ?, results_released_by = ? WHERE id = ?', nowIso(), req.user.id, cl.id);
      await audit.log(req, 'liberou_resultado', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id });
      await mailer.queue(mailer.templates.resultadoLiberado(await domain.getUser(cl.user_id), cl));
    }
    await auth.flash(req, 'success', list.length ? `${list.length} resultado(s) liberado(s).` : 'Nenhum resultado pronto para liberar.');
    return res.redirect('/acompanhamento');
  } catch (err) { return next(err); }
});

module.exports = router;
