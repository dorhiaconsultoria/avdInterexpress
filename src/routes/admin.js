'use strict';
const path = require('path');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const dbm = require('../db');
const config = require('../config');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const domain = require('../lib/domain');
const mailer = require('../lib/mailer');
const seed = require('../db/seed');
const { EMAIL_DOMAIN_TESTE } = require('../db/seed-data');
const { nowIso, isValidDate, randomToken, sha256, todayLocal } = require('../lib/util');

const router = require('../lib/async-router')();

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isFicticio = (email) => String(email || '').toLowerCase().endsWith(`@${EMAIL_DOMAIN_TESTE}`);

/* ------------------------------------- "Entrar como" (modo de teste) */
// Estas rotas usam o usuário REAL (a administradora), mesmo quando ela está vendo como outra pessoa.

router.post('/entrar-como', async (req, res) => {
  if (!req.realUser || !req.realUser.is_admin) return auth.forbidden(res);
  if (!await dbm.isTestMode()) return auth.forbidden(res, '"Entrar como" só funciona no modo de teste.');
  const target = await domain.getUser(Number(req.body.user_id));
  if (!target || !target.active) {
    await auth.flash(req, 'error', 'Escolha uma pessoa.');
    return res.redirect('back');
  }
  const acting = target.id === req.realUser.id ? null : target.id;
  await dbm.run('UPDATE sessions SET acting_as_user_id = ? WHERE id = ?', acting, req.sessionRow.id);
  req.user = target;
  req.impersonating = !!acting;
  if (acting) await audit.log(req, 'entrar_como', { subjectUserId: target.id });
  return res.redirect('/');
});

router.post('/sair-entrar-como', async (req, res) => {
  if (!req.realUser || !req.realUser.is_admin) return auth.forbidden(res);
  if (req.impersonating) await audit.log(req, 'sair_entrar_como', { subjectUserId: req.user.id });
  await dbm.run('UPDATE sessions SET acting_as_user_id = NULL WHERE id = ?', req.sessionRow.id);
  return res.redirect('/admin/teste');
});

router.use(auth.requireRole('admin'));

/* ------------------------------------------------------------- painel */

router.get('/', async (req, res) => {
  const cycle = await domain.currentCycle();
  const v = await domain.vigenteVersion();
  const counts = {
    pessoas: (await dbm.get('SELECT COUNT(*) AS n FROM users WHERE active = 1')).n,
    vinculos: (await domain.listVinculos()).length,
    ficticios: (await dbm.get('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND email LIKE ?', `%@${EMAIL_DOMAIN_TESTE}`)).n,
    emailsRetidos: (await dbm.get("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'retido_teste'")).n,
    emailsErro: (await dbm.get("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'erro'")).n,
  };
  res.render('admin/index', { title: 'Administração', cycle, version: v, draft: await domain.draftVersion(), counts, locked: await domain.matrixLocked(), wentLiveAt: await dbm.getSetting('went_live_at') });
});

/* -------------------------------------------------------- modo de teste */

async function goLiveChecks() {
  const cycle = await domain.currentCycle();
  const ficticios = await dbm.all('SELECT name, email FROM users WHERE active = 1 AND email LIKE ? ORDER BY name', `%@${EMAIL_DOMAIN_TESTE}`);
  const selfNoValidator = cycle
    ? await domain.listChecklists(cycle.id, 'AND cl.self_verification = 1 AND cl.validator_user_id IS NULL') : [];
  return [
    { ok: !ficticios.length, text: ficticios.length ? `${ficticios.length} pessoa(s) ainda com e-mail fictício: ${ficticios.map((f) => f.name).join(', ')}. Elas não receberão convite.` : 'Todas as pessoas têm e-mail real cadastrado.', href: '/admin/pessoas' },
    { ok: mailer.smtpConfigured(), text: mailer.smtpConfigured() ? `Servidor de e-mail configurado (${config.smtp.host}).` : 'Servidor de e-mail (SMTP) não configurado nas variáveis de ambiente: os e-mails ficarão com erro.', href: '/admin/configuracoes' },
    { ok: !selfNoValidator.length, text: selfNoValidator.length ? `Validador ainda não definido para: ${selfNoValidator.map((c) => `${c.user_name} (${c.cargo_code})`).join(', ')}. Pode ser definido depois.` : 'Validadores das autoverificações definidos.', href: cycle ? `/checklists/${selfNoValidator[0] ? selfNoValidator[0].id : ''}` : null },
    { ok: !!(cycle && cycle.start_date && cycle.self_deadline && cycle.manager_deadline && cycle.feedback_deadline && cycle.end_date), text: 'Datas do ciclo definidas (podem ser revistas depois de colocar no ar).', href: '/admin/ciclo' },
    { ok: !isFicticio((await dbm.get('SELECT email FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1')).email), text: 'O seu próprio e-mail de login é real (você vai entrar com ele depois).', href: '/admin/pessoas' },
  ];
}

router.get('/teste', async (req, res) => {
  const users = await domain.listUsers({ activeOnly: true });
  const vincs = await domain.listVinculos();
  const cycle = await domain.currentCycle();
  const mgrIds = new Set(cycle ? (await domain.managersInCycle(cycle.id)).map((m) => m.id) : []);
  const isMgr = (id) => mgrIds.has(id);
  const people = users.map((u) => {
    const perfis = [];
    if (u.is_admin) perfis.push('Administradora');
    if (u.is_rh) perfis.push('Execução do ciclo (RH)');
    if (u.is_ceo) perfis.push('CEO');
    if (isMgr(u.id)) perfis.push('Avaliador(a)');
    if (u.is_sgi) perfis.push('Consulta SGI');
    if (vincs.some((v) => v.user_id === u.id)) perfis.push('Colaborador(a)');
    return { ...u, perfis, cargos: vincs.filter((v) => v.user_id === u.id).map((v) => v.cargo_code).join(', ') };
  });
  res.render('admin/teste', {
    title: 'Modo de teste',
    people,
    checks: await goLiveChecks(),
    wentLiveAt: await dbm.getSetting('went_live_at'),
    evalCount: (await dbm.get('SELECT COUNT(*) AS n FROM evaluations')).n,
  });
});

router.post('/teste/apagar', async (req, res) => {
  if (!await dbm.isTestMode()) return auth.forbidden(res, 'Disponível apenas no modo de teste.');
  await seed.clearEvaluations();
  await dbm.run("DELETE FROM email_outbox WHERE status = 'retido_teste'");
  await audit.log(req, 'apagou_testes');
  await auth.flash(req, 'success', 'Avaliações de teste apagadas. Cadastros, matriz e hierarquia foram mantidos; o ciclo voltou para o planejamento.');
  res.redirect('/admin/teste');
});

router.post('/teste/exemplos', async (req, res) => {
  if (!await dbm.isTestMode()) return auth.forbidden(res, 'Disponível apenas no modo de teste.');
  await seed.clearEvaluations();
  const n = await seed.loadExamples();
  await audit.log(req, 'carregou_exemplos', { details: { exemplos: n } });
  await auth.flash(req, 'success', `${n} avaliações de exemplo carregadas (Karine assinada, Felipe concluída, Lucas em andamento). O ciclo está em andamento.`);
  res.redirect('/admin/teste');
});

router.post('/colocar-no-ar', async (req, res) => {
  if (!await dbm.isTestMode()) {
    await auth.flash(req, 'info', 'O sistema já está no ar.');
    return res.redirect('/admin/teste');
  }
  if (String(req.body.confirmacao || '').trim().toUpperCase() !== 'COLOCAR NO AR') {
    await auth.flash(req, 'error', 'Digite COLOCAR NO AR para confirmar.');
    return res.redirect('/admin/teste#no-ar');
  }
  const adminId = req.realUser.id;
  await seed.clearEvaluations();
  await dbm.tx(async () => {
    await dbm.run("DELETE FROM email_outbox WHERE status = 'retido_teste'");
    await dbm.run(`UPDATE users SET password_hash = NULL, must_change_password = 0, invite_token_hash = NULL, invite_expires = NULL,
                  reset_token_hash = NULL, reset_expires = NULL WHERE id != ?`, adminId);
    await dbm.run('DELETE FROM sessions WHERE user_id != ?', adminId);
    await dbm.run('UPDATE sessions SET acting_as_user_id = NULL');
  });
  await dbm.setSetting('test_mode', '0');
  await dbm.setSetting('went_live_at', nowIso());
  await audit.log({ realUser: req.realUser, ip: req.ip }, 'colocou_no_ar');
  await auth.flash(req, 'success', 'Sistema no ar! As avaliações de teste foram apagadas. Agora revise as datas e inicie o ciclo: os convites serão enviados por e-mail.');
  return res.redirect('/admin/ciclo');
});

/* ----------------------------------------------------------------- ciclo */

router.get('/ciclo', async (req, res) => {
  const cycles = await domain.listCycles();
  const cycle = await domain.currentCycle();
  const participants = cycle ? (await domain.listChecklists(cycle.id)).length : 0;
  res.render('admin/ciclo', { title: 'Ciclo', cycles, cycle, participants, version: await domain.vigenteVersion(), draft: await domain.draftVersion() });
});

const DATE_FIELDS = ['start_date', 'self_deadline', 'manager_deadline', 'feedback_deadline', 'end_date'];

router.post('/ciclo/:id', async (req, res) => {
  const cycle = await domain.getCycle(Number(req.params.id));
  if (!cycle || cycle.status === 'encerrado') return auth.forbidden(res, 'Ciclo encerrado não pode ser alterado.');
  const vals = {};
  for (const f of DATE_FIELDS) {
    const v = String(req.body[f] || '').trim();
    if (v && !isValidDate(v)) {
      await auth.flash(req, 'error', 'Data inválida.');
      return res.redirect('/admin/ciclo');
    }
    vals[f] = v || null;
  }
  const ordered = DATE_FIELDS.map((f) => vals[f]).filter(Boolean);
  if (ordered.some((d, i) => i > 0 && d < ordered[i - 1])) {
    await auth.flash(req, 'error', 'As datas precisam seguir a ordem: início, autoavaliação, gestor, plano e assinaturas, encerramento.');
    return res.redirect('/admin/ciclo');
  }
  const name = String(req.body.name || cycle.name).trim().slice(0, 80) || cycle.name;
  await dbm.run(`UPDATE cycles SET name = ?, start_date = ?, self_deadline = ?, manager_deadline = ?, feedback_deadline = ?, end_date = ?,
                auto_release = ?, reminder_days = ? WHERE id = ?`, name, vals.start_date, vals.self_deadline, vals.manager_deadline, vals.feedback_deadline, vals.end_date,
      req.body.auto_release ? 1 : 0, Math.max(1, Math.min(15, Number(req.body.reminder_days) || 3)), cycle.id);
  await audit.log(req, 'alterou_ciclo', { entity: 'cycle', entityId: cycle.id, details: { ...vals, name } });
  await auth.flash(req, 'success', 'Ciclo atualizado.');
  return res.redirect('/admin/ciclo');
});

async function participantsOf(cycle) {
  const ids = new Set((await domain.listChecklists(cycle.id)).flatMap((cl) => [cl.user_id, cl.evaluator_user_id]));
  for (const u of await dbm.all('SELECT id FROM users WHERE active = 1 AND (is_admin = 1 OR is_rh = 1 OR is_ceo = 1 OR is_sgi = 1)')) ids.add(u.id);
  const out = [];
  for (const id of ids) {
    const u = await domain.getUser(id);
    if (u && u.active) out.push(u);
  }
  return out;
}

async function newInviteToken(user) {
  const token = randomToken();
  const exp = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await dbm.run('UPDATE users SET invite_token_hash = ?, invite_expires = ?, invited_at = ? WHERE id = ?', sha256(token), exp, nowIso(), user.id);
  return token;
}

router.post('/ciclo/:id/iniciar', async (req, res, next) => {
  try {
    const cycle = await domain.getCycle(Number(req.params.id));
    if (!cycle || cycle.status !== 'planejamento') return auth.forbidden(res, 'Somente um ciclo em planejamento pode ser iniciado.');
    if (DATE_FIELDS.some((f) => !cycle[f])) {
      await auth.flash(req, 'error', 'Defina todas as datas do ciclo antes de iniciar.');
      return res.redirect('/admin/ciclo');
    }
    const v = await domain.vigenteVersion();
    if (!v) {
      await auth.flash(req, 'error', 'Não há matriz vigente.');
      return res.redirect('/admin/ciclo');
    }
    await dbm.run("UPDATE cycles SET status = 'em_andamento', started_at = ?, matrix_version_id = ? WHERE id = ?", nowIso(), v.id, cycle.id);
    await domain.syncChecklists(cycle.id);
    const started = await domain.getCycle(cycle.id);
    let sent = 0;
    for (const u of await participantsOf(started)) {
      if (isFicticio(u.email) && !await dbm.isTestMode()) continue;
      const inviteToken = u.password_hash ? null : await newInviteToken(u);
      await mailer.queue(mailer.templates.abertura(u, started, { inviteToken }));
      sent += 1;
    }
    await audit.log(req, 'iniciou_ciclo', { entity: 'cycle', entityId: cycle.id, details: { matriz: v.number, avisos: sent } });
    await auth.flash(req, 'success', await dbm.isTestMode()
      ? `${cycle.name} iniciado. Modo de teste: ${sent} aviso(s) de abertura ficaram retidos na caixa de saída. A matriz está travada.`
      : `${cycle.name} iniciado. ${sent} aviso(s) de abertura enviados (com o convite para quem ainda não criou senha). A matriz está travada.`);
    return res.redirect('/admin/ciclo');
  } catch (err) { return next(err); }
});

router.post('/ciclo/:id/encerrar', async (req, res) => {
  const cycle = await domain.getCycle(Number(req.params.id));
  if (!cycle || cycle.status !== 'em_andamento') return auth.forbidden(res, 'Somente um ciclo em andamento pode ser encerrado.');
  if (String(req.body.confirmacao || '').trim().toUpperCase() !== 'ENCERRAR') {
    await auth.flash(req, 'error', 'Digite ENCERRAR para confirmar.');
    return res.redirect('/admin/ciclo');
  }
  await dbm.run("UPDATE cycles SET status = 'encerrado', closed_at = ? WHERE id = ?", nowIso(), cycle.id);
  await audit.log(req, 'encerrou_ciclo', { entity: 'cycle', entityId: cycle.id });
  await auth.flash(req, 'success', `${cycle.name} encerrado. Os registros ficam disponíveis para consulta e a matriz foi destravada.`);
  return res.redirect('/admin/ciclo');
});

router.post('/ciclo/novo', async (req, res) => {
  if (await dbm.get("SELECT 1 FROM cycles WHERE status != 'encerrado'")) {
    await auth.flash(req, 'error', 'Encerre o ciclo atual antes de criar um novo.');
    return res.redirect('/admin/ciclo');
  }
  const last = await dbm.get('SELECT * FROM cycles ORDER BY year DESC, id DESC LIMIT 1');
  const year = last ? last.year + 1 : Number(todayLocal().slice(0, 4));
  const shift = (d) => (d ? `${Number(d.slice(0, 4)) + 1}${d.slice(4)}` : null);
  const newCycleId = await dbm.insert(`INSERT INTO cycles (name, year, status, start_date, self_deadline, manager_deadline, feedback_deadline, end_date,
                           auto_release, reminder_days, created_at) VALUES (?, ?, 'planejamento', ?,?,?,?,?,?,?,?)`, `Ciclo ${year}`, year, shift(last && last.start_date), shift(last && last.self_deadline), shift(last && last.manager_deadline),
      shift(last && last.feedback_deadline), shift(last && last.end_date), last ? last.auto_release : 0, last ? last.reminder_days : 3, nowIso());
  await domain.syncChecklists(newCycleId);
  await audit.log(req, 'criou_ciclo', { entity: 'cycle', entityId: newCycleId });
  await auth.flash(req, 'success', `Ciclo ${year} criado em planejamento. Revise as datas.`);
  return res.redirect('/admin/ciclo');
});

/* ---------------------------------------------------------------- pessoas */

async function peopleView() {
  const users = await domain.listUsers();
  const vincs = await domain.listVinculos({ activeOnly: false });
  return users.map((u) => ({
    ...u,
    ficticio: isFicticio(u.email),
    vincs: vincs.filter((v) => v.user_id === u.id && v.active),
    acesso: u.password_hash ? 'Senha criada' : (u.invite_expires && u.invite_expires > nowIso() ? 'Convite enviado' : 'Sem acesso ainda'),
  }));
}

router.get('/pessoas', async (req, res) => {
  const resultado = req.query.importacao ? JSON.parse(await dbm.getSetting(`import_${req.realUser.id}`) || 'null') : null;
  res.render('admin/pessoas', {
    title: 'Pessoas e hierarquia', people: await peopleView(), cargos: await domain.listCargos(), vincs: await domain.listVinculos(),
    resultado, smtp: mailer.smtpConfigured(),
  });
});

function readRoles(body) {
  return { is_admin: body.is_admin ? 1 : 0, is_rh: body.is_rh ? 1 : 0, is_ceo: body.is_ceo ? 1 : 0, is_sgi: body.is_sgi ? 1 : 0 };
}

router.post('/pessoas/nova', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!name || !EMAIL_RE.test(email)) {
    await auth.flash(req, 'error', 'Informe nome e um e-mail válido.');
    return res.redirect('/admin/pessoas#nova');
  }
  if (await dbm.get('SELECT 1 FROM users WHERE email = ?', email)) {
    await auth.flash(req, 'error', 'Já existe uma pessoa com este e-mail.');
    return res.redirect('/admin/pessoas#nova');
  }
  const r = readRoles(req.body);
  const newId = await dbm.insert('INSERT INTO users (name, email, is_admin, is_rh, is_ceo, is_sgi, created_at) VALUES (?,?,?,?,?,?,?)', name.slice(0, 120), email, r.is_admin, r.is_rh, r.is_ceo, r.is_sgi, nowIso());
  const cargoId = Number(req.body.cargo_id) || null;
  if (cargoId) {
    await dbm.run('INSERT INTO vinculos (user_id, cargo_id, manager_vinculo_id) VALUES (?,?,?)', newId, cargoId, Number(req.body.manager_vinculo_id) || null);
  }
  const cycle = await domain.currentCycle();
  if (cycle) await domain.syncChecklists(cycle.id);
  await audit.log(req, 'incluiu_pessoa', { entity: 'user', entityId: newId, subjectUserId: newId, details: { name, email } });
  await auth.flash(req, 'success', `${name} incluído(a).`);
  return res.redirect(`/admin/pessoas/${newId}`);
});

router.get('/pessoas/modelo.xlsx', async (req, res, next) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('E-mails');
    ws.columns = [
      { header: 'Código', key: 'code', width: 9 },
      { header: 'Colaborador', key: 'name', width: 22 },
      { header: 'Cargo', key: 'cargo', width: 44 },
      { header: 'E-mail', key: 'email', width: 36 },
    ];
    for (const v of await domain.listVinculos()) {
      ws.addRow({ code: v.cargo_code, name: v.user_name, cargo: v.cargo_title, email: isFicticio(v.user_email) ? '' : v.user_email });
    }
    for (const u of await domain.listUsers({ activeOnly: true })) {
      if (!(await domain.listVinculos()).some((v) => v.user_id === u.id)) ws.addRow({ code: '', name: u.name, cargo: '', email: isFicticio(u.email) ? '' : u.email });
    }
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3E9E' } };
    const buf = await wb.xlsx.writeBuffer();
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="modelo-emails-interexpress.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

async function readSheet(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.csv' || ext === '.txt') return parseCsv(file.buffer.toString('utf8').replace(/^﻿/, ''));
  if (ext !== '.xlsx') throw Object.assign(new Error('Use um arquivo .xlsx ou .csv.'), { status: 400, expose: true });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow((r) => {
    rows.push(r.values.slice(1).map((v) => {
      if (v && typeof v === 'object') return v.text || (v.hyperlink ? String(v.hyperlink).replace(/^mailto:/, '') : '') || (v.result != null ? String(v.result) : '');
      return v == null ? '' : String(v);
    }));
  });
  return rows;
}

router.post('/pessoas/importar', memUpload.single('arquivo'), auth.csrfAfterUpload, async (req, res, next) => {
  try {
    if (!req.file) {
      await auth.flash(req, 'error', 'Selecione a planilha.');
      return res.redirect('/admin/pessoas#importar');
    }
    const rows = await readSheet(req.file);
    if (rows.length < 2) {
      await auth.flash(req, 'error', 'A planilha está vazia.');
      return res.redirect('/admin/pessoas#importar');
    }
    const header = rows[0].map(norm);
    const col = (names) => header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
    const iCode = col(['codigo', 'cod', 'cod.']);
    const iName = col(['colaborador', 'nome']);
    const iEmail = col(['e-mail', 'email']);
    if (iEmail < 0 || (iCode < 0 && iName < 0)) {
      await auth.flash(req, 'error', 'A planilha precisa das colunas "E-mail" e "Código" (ou "Colaborador").');
      return res.redirect('/admin/pessoas#importar');
    }
    const vincs = await domain.listVinculos();
    const users = await domain.listUsers({ activeOnly: true });
    const planned = new Map();
    const result = { atualizados: [], ignorados: [], erros: [] };
    rows.slice(1).forEach((r, idx) => {
      const line = idx + 2;
      const email = String(r[iEmail] || '').trim().toLowerCase();
      const code = iCode >= 0 ? String(r[iCode] || '').trim().toUpperCase() : '';
      const name = iName >= 0 ? String(r[iName] || '').trim() : '';
      if (!email) { result.ignorados.push(`Linha ${line}: sem e-mail`); return; }
      if (!EMAIL_RE.test(email)) { result.erros.push(`Linha ${line}: e-mail inválido (${email})`); return; }
      let user = null;
      if (code) {
        const v = vincs.find((x) => x.cargo_code === code);
        if (v) user = users.find((u) => u.id === v.user_id);
      }
      if (!user && name) {
        const matches = users.filter((u) => norm(u.name) === norm(name));
        if (matches.length === 1) [user] = matches;
      }
      if (!user) { result.erros.push(`Linha ${line}: pessoa não encontrada (${code || name})`); return; }
      if (planned.has(user.id) && planned.get(user.id) !== email) {
        result.erros.push(`Linha ${line}: ${user.name} aparece com dois e-mails diferentes`);
        return;
      }
      planned.set(user.id, email);
    });
    for (const [userId, email] of planned) {
      const other = await dbm.get('SELECT id, name FROM users WHERE email = ? AND id != ?', email, userId);
      if (other && !planned.has(other.id)) {
        result.erros.push(`${email} já pertence a ${other.name}`);
        planned.delete(userId);
      }
    }
    const nameOf = (id) => (users.find((u) => u.id === id) || {}).name;
    const before = Object.fromEntries([...planned.keys()].map((id) => [id, (users.find((u) => u.id === id) || {}).email]));
    await dbm.tx(async () => {
      // Evita conflito de UNIQUE durante trocas: grava temporários primeiro
      for (const [userId] of planned) await dbm.run('UPDATE users SET email = ? WHERE id = ?', `tmp-${userId}-${randomToken(6)}@tmp.invalid`, userId);
      for (const [userId, email] of planned) {
        await dbm.run('UPDATE users SET email = ? WHERE id = ?', email, userId);
        result.atualizados.push(`${nameOf(userId)}: ${email}`);
      }
    });
    for (const [userId, email] of planned) {
      if (before[userId] !== email) await audit.log(req, 'alterou_pessoa', { entity: 'user', entityId: userId, subjectUserId: userId, details: { email_de: before[userId], email_para: email } });
    }
    await audit.log(req, 'importou_emails', { details: { atualizados: result.atualizados.length, erros: result.erros.length } });
    await dbm.setSetting(`import_${req.realUser.id}`, JSON.stringify(result));
    return res.redirect('/admin/pessoas?importacao=1#importar');
  } catch (err) { return next(err); }
});

router.get('/pessoas/:id', async (req, res) => {
  const person = await domain.getUser(Number(req.params.id));
  if (!person) return res.status(404).render('error', { title: 'Pessoa não encontrada', message: 'Cadastro inexistente.' });
  const all = await domain.listVinculos({ activeOnly: false });
  res.render('admin/pessoa', {
    title: person.name,
    person: { ...person, ficticio: isFicticio(person.email) },
    vincs: all.filter((v) => v.user_id === person.id),
    managers: await domain.listVinculos(),
    cargos: await domain.listCargos(),
    inviteLink: null,
  });
});

router.post('/pessoas/:id', async (req, res) => {
  const person = await domain.getUser(Number(req.params.id));
  if (!person) return res.status(404).render('error', { title: 'Pessoa não encontrada', message: 'Cadastro inexistente.' });
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!name || !EMAIL_RE.test(email)) {
    await auth.flash(req, 'error', 'Informe nome e um e-mail válido.');
    return res.redirect(`/admin/pessoas/${person.id}`);
  }
  if (await dbm.get('SELECT 1 FROM users WHERE email = ? AND id != ?', email, person.id)) {
    await auth.flash(req, 'error', 'Já existe outra pessoa com este e-mail.');
    return res.redirect(`/admin/pessoas/${person.id}`);
  }
  const r = readRoles(req.body);
  const active = req.body.active ? 1 : 0;
  if (person.id === req.realUser.id && (!r.is_admin || !active)) {
    await auth.flash(req, 'error', 'Você não pode remover o seu próprio perfil de administradora nem se desativar.');
    return res.redirect(`/admin/pessoas/${person.id}`);
  }
  await dbm.run('UPDATE users SET name = ?, email = ?, is_admin = ?, is_rh = ?, is_ceo = ?, is_sgi = ?, active = ? WHERE id = ?', name, email, r.is_admin, r.is_rh, r.is_ceo, r.is_sgi, active, person.id);
  if (!active) await dbm.run('DELETE FROM sessions WHERE user_id = ?', person.id);
  const cycle = await domain.currentCycle();
  if (cycle) await domain.syncChecklists(cycle.id);
  await audit.log(req, 'alterou_pessoa', { entity: 'user', entityId: person.id, subjectUserId: person.id,
    details: { name, email, perfis: r, ativo: active, email_anterior: person.email !== email ? person.email : undefined } });
  await auth.flash(req, 'success', 'Cadastro atualizado.');
  return res.redirect(`/admin/pessoas/${person.id}`);
});

router.post('/pessoas/:id/vinculos', async (req, res) => {
  const person = await domain.getUser(Number(req.params.id));
  const cargoId = Number(req.body.cargo_id);
  if (!person || !cargoId) {
    await auth.flash(req, 'error', 'Escolha o cargo.');
    return res.redirect(`/admin/pessoas/${req.params.id}`);
  }
  const existing = await dbm.get('SELECT * FROM vinculos WHERE user_id = ? AND cargo_id = ?', person.id, cargoId);
  if (existing) {
    await dbm.run('UPDATE vinculos SET active = 1, manager_vinculo_id = ? WHERE id = ?', Number(req.body.manager_vinculo_id) || null, existing.id);
  } else {
    await dbm.run('INSERT INTO vinculos (user_id, cargo_id, manager_vinculo_id) VALUES (?,?,?)', person.id, cargoId, Number(req.body.manager_vinculo_id) || null);
  }
  const cycle = await domain.currentCycle();
  if (cycle) await domain.syncChecklists(cycle.id);
  await audit.log(req, 'alterou_hierarquia', { entity: 'user', entityId: person.id, subjectUserId: person.id, details: { incluiu_cargo: cargoId } });
  await auth.flash(req, 'success', 'Cargo incluído.');
  return res.redirect(`/admin/pessoas/${person.id}`);
});

router.post('/vinculos/:id', async (req, res) => {
  const v = await dbm.get('SELECT * FROM vinculos WHERE id = ?', Number(req.params.id));
  if (!v) return res.status(404).render('error', { title: 'Vínculo não encontrado', message: 'Cargo/hierarquia inexistente.' });
  const managerId = Number(req.body.manager_vinculo_id) || null;
  if (managerId === v.id) {
    await auth.flash(req, 'error', 'Um cargo não pode reportar a ele mesmo.');
    return res.redirect(`/admin/pessoas/${v.user_id}`);
  }
  // Impede ciclos na hierarquia
  let cur = managerId;
  const seen = new Set();
  while (cur) {
    if (cur === v.id || seen.has(cur)) {
      await auth.flash(req, 'error', 'Essa alteração criaria um ciclo na hierarquia.');
      return res.redirect(`/admin/pessoas/${v.user_id}`);
    }
    seen.add(cur);
    const m = await dbm.get('SELECT manager_vinculo_id FROM vinculos WHERE id = ?', cur);
    cur = m ? m.manager_vinculo_id : null;
  }
  const active = req.body.active === undefined ? v.active : (req.body.active ? 1 : 0);
  await dbm.run('UPDATE vinculos SET manager_vinculo_id = ?, active = ? WHERE id = ?', managerId, active, v.id);
  const cycle = await domain.currentCycle();
  if (cycle) await domain.syncChecklists(cycle.id);
  await audit.log(req, 'alterou_hierarquia', { entity: 'user', entityId: v.user_id, subjectUserId: v.user_id, details: { vinculo: v.id, gestor_vinculo: managerId, ativo: active } });
  await auth.flash(req, 'success', 'Hierarquia atualizada. Checklists com avaliação do gestor já iniciada mantêm o avaliador original.');
  return res.redirect(`/admin/pessoas/${v.user_id}`);
});

router.post('/pessoas/:id/convite', async (req, res, next) => {
  try {
    const person = await domain.getUser(Number(req.params.id));
    if (!person || !person.active) return res.status(404).render('error', { title: 'Pessoa não encontrada', message: 'Cadastro inexistente.' });
    if (isFicticio(person.email) && !await dbm.isTestMode()) {
      await auth.flash(req, 'error', 'Cadastre o e-mail real antes de enviar o convite.');
      return res.redirect(`/admin/pessoas/${person.id}`);
    }
    const token = await newInviteToken(person);
    const r = await mailer.queue(mailer.templates.convite(person, token));
    await audit.log(req, 'enviou_convite', { entity: 'user', entityId: person.id, subjectUserId: person.id });
    if (await dbm.isTestMode()) {
      const all = await domain.listVinculos({ activeOnly: false });
      return res.render('admin/pessoa', {
        title: person.name, person: { ...person, ficticio: isFicticio(person.email) },
        vincs: all.filter((v) => v.user_id === person.id), managers: await domain.listVinculos(), cargos: await domain.listCargos(),
        inviteLink: `${config.appUrl}/convite/${token}`,
      });
    }
    await auth.flash(req, r.status === 'enviado' ? 'success' : 'error', r.status === 'enviado' ? `Convite enviado para ${person.email}.` : 'Falha ao enviar o convite. Veja Administração › E-mails.');
    return res.redirect(`/admin/pessoas/${person.id}`);
  } catch (err) { return next(err); }
});

router.post('/convites', async (req, res, next) => {
  try {
    if (await dbm.isTestMode()) {
      await auth.flash(req, 'error', 'Os convites por e-mail só podem ser enviados depois de "Colocar no ar".');
      return res.redirect('/admin/pessoas');
    }
    const pend = (await dbm.all('SELECT * FROM users WHERE active = 1 AND password_hash IS NULL')).filter((u) => !isFicticio(u.email));
    let ok = 0;
    for (const u of pend) {
      const r = await mailer.queue(mailer.templates.convite(u, await newInviteToken(u)));
      if (r.status === 'enviado') ok += 1;
      await audit.log(req, 'enviou_convite', { entity: 'user', entityId: u.id, subjectUserId: u.id });
    }
    await auth.flash(req, ok === pend.length ? 'success' : 'warn', `${ok} de ${pend.length} convite(s) enviados.`);
    return res.redirect('/admin/pessoas');
  } catch (err) { return next(err); }
});

/* ------------------------------------------------------------------ cargos */

router.get('/cargos', async (req, res) => {
  res.render('admin/cargos', { title: 'Cargos', cargos: await domain.listCargos(), vincs: await domain.listVinculos() });
});

router.post('/cargos/novo', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const title = String(req.body.title || '').trim();
  if (!/^[A-Z]\d{2,3}$/.test(code) || !title) {
    await auth.flash(req, 'error', 'Informe um código no formato F17 e o nome do cargo.');
    return res.redirect('/admin/cargos');
  }
  if (await dbm.get('SELECT 1 FROM cargos WHERE code = ?', code)) {
    await auth.flash(req, 'error', 'Já existe um cargo com esse código.');
    return res.redirect('/admin/cargos');
  }
  const sort = ((await dbm.get('SELECT MAX(sort) AS m FROM cargos')).m || 0) + 1;
  await dbm.run('INSERT INTO cargos (code, title, short_title, area, is_leadership, sort) VALUES (?,?,?,?,?,?)', code, title.slice(0, 120), String(req.body.short_title || title).trim().slice(0, 60), String(req.body.area || '').trim().slice(0, 80) || 'Sem área', req.body.is_leadership ? 1 : 0, sort);
  await audit.log(req, 'alterou_cargo', { details: { novo: code, title } });
  await auth.flash(req, 'success', `Cargo ${code} criado. Defina os níveis exigidos dele em uma nova versão da matriz.`);
  return res.redirect('/admin/cargos');
});

router.post('/cargos/:id', async (req, res) => {
  const c = await dbm.get('SELECT * FROM cargos WHERE id = ?', Number(req.params.id));
  if (!c) return res.status(404).render('error', { title: 'Cargo não encontrado', message: 'Cargo inexistente.' });
  const title = String(req.body.title || '').trim();
  if (!title) {
    await auth.flash(req, 'error', 'Informe o nome do cargo.');
    return res.redirect('/admin/cargos');
  }
  await dbm.run('UPDATE cargos SET title = ?, short_title = ?, area = ?, is_leadership = ? WHERE id = ?', title.slice(0, 120), String(req.body.short_title || title).trim().slice(0, 60), String(req.body.area || '').trim().slice(0, 80) || c.area, req.body.is_leadership ? 1 : 0, c.id);
  await audit.log(req, 'alterou_cargo', { details: { code: c.code, title } });
  await auth.flash(req, 'success', `Cargo ${c.code} atualizado.`);
  return res.redirect('/admin/cargos');
});

/* ------------------------------------------------------------------ matriz */

async function versionDiff(oldId, newId) {
  if (!oldId) return [];
  const changes = [];
  const oc = Object.fromEntries((await domain.competenciesOf(oldId)).map((c) => [c.code, c]));
  const nc = await domain.competenciesOf(newId);
  for (const c of nc) {
    const o = oc[c.code];
    if (!o) { changes.push(`${c.code} ${c.name}: competência incluída`); continue; }
    for (const [f, label] of [['name', 'nome'], ['definition', 'definição'], ['n1', 'critério nível 1'], ['n2', 'critério nível 2'], ['n3', 'critério nível 3']]) {
      if (o[f] !== c[f]) changes.push(`${c.code}: ${label} alterado`);
    }
  }
  const ol = await domain.levelsOf(oldId);
  const nl = await domain.levelsOf(newId);
  for (const cargo of await domain.listCargos()) {
    for (const c of nc) {
      const a = (ol[cargo.id] || {})[c.code];
      const b = (nl[cargo.id] || {})[c.code];
      if ((a == null ? null : a) !== (b == null ? null : b)) changes.push(`${cargo.code} × ${c.code}: ${a == null ? '—' : a} → ${b == null ? '—' : b}`);
    }
  }
  return changes;
}

router.get('/matriz', async (req, res) => {
  const v = await domain.vigenteVersion();
  res.render('admin/matriz', {
    title: 'Matriz de competências',
    version: v,
    comps: v ? await domain.competenciesOf(v.id) : [],
    levels: v ? await domain.levelsOf(v.id) : {},
    cargos: await domain.listCargos(),
    versions: await domain.listVersions(),
    draft: await domain.draftVersion(),
    locked: await domain.matrixLocked(),
  });
});

router.get('/matriz/versao/:id', async (req, res) => {
  const v = await domain.getVersion(Number(req.params.id));
  if (!v || v.status === 'rascunho') return res.redirect('/admin/matriz');
  const prev = await dbm.get("SELECT * FROM matrix_versions WHERE number < ? AND status != 'rascunho' ORDER BY number DESC LIMIT 1", v.number);
  res.render('admin/matriz-versao', {
    title: `Matriz — Versão ${v.number}`, version: v, prev, comps: await domain.competenciesOf(v.id), levels: await domain.levelsOf(v.id),
    cargos: await domain.listCargos(), changes: prev ? await versionDiff(prev.id, v.id) : [],
  });
});

async function guardMatrix(req, res) {
  if (await domain.matrixLocked()) {
    await auth.flash(req, 'error', await dbm.isTestMode()
      ? 'A matriz está travada porque o ciclo já começou. No modo de teste, use "Apagar avaliações de teste" para voltar o ciclo ao planejamento.'
      : 'A matriz está travada porque o ciclo já começou. Ela será destravada quando o ciclo for encerrado.');
    res.redirect('/admin/matriz');
    return false;
  }
  return true;
}

router.post('/matriz/nova-versao', async (req, res) => {
  if (!(await guardMatrix(req, res))) return;
  if (await domain.draftVersion()) return res.redirect('/admin/matriz/rascunho');
  const v = await domain.vigenteVersion();
  await dbm.tx(async () => {
    const id = await dbm.insert("INSERT INTO matrix_versions (status, created_by, created_at) VALUES ('rascunho', ?, ?)", req.realUser.id, nowIso());
    if (v) {
      await dbm.run(`INSERT INTO competencies (version_id, code, name, definition, n1, n2, n3, leadership_only, sort)
                    SELECT ?::int, code, name, definition, n1, n2, n3, leadership_only, sort FROM competencies WHERE version_id = ?`, id, v.id);
      await dbm.run(`INSERT INTO matrix_levels (version_id, cargo_id, competency_code, required_level)
                    SELECT ?::int, cargo_id, competency_code, required_level FROM matrix_levels WHERE version_id = ?`, id, v.id);
    }
  });
  await audit.log(req, 'alterou_matriz', { details: { acao: 'criou rascunho' } });
  res.redirect('/admin/matriz/rascunho');
});

router.get('/matriz/rascunho', async (req, res) => {
  const d = await domain.draftVersion();
  if (!d) return res.redirect('/admin/matriz');
  const v = await domain.vigenteVersion();
  res.render('admin/matriz-editar', {
    title: 'Editar matriz (rascunho)', draft: d, comps: await domain.competenciesOf(d.id), levels: await domain.levelsOf(d.id),
    cargos: await domain.listCargos(), vigente: v, nextNumber: ((await dbm.get('SELECT MAX(number) AS m FROM matrix_versions')).m || 0) + 1,
    changes: v ? await versionDiff(v.id, d.id) : [], locked: await domain.matrixLocked(), today: todayLocal(),
  });
});

router.post('/matriz/rascunho', async (req, res) => {
  if (!(await guardMatrix(req, res))) return;
  const d = await domain.draftVersion();
  if (!d) return res.redirect('/admin/matriz');
  const comps = await domain.competenciesOf(d.id);
  await dbm.tx(async () => {
    for (const c of comps) {
      const f = (k) => String(req.body[`${k}_${c.code}`] == null ? c[k] : req.body[`${k}_${c.code}`]).trim().slice(0, 1000);
      const name = f('name') || c.name;
      await dbm.run('UPDATE competencies SET name = ?, definition = ?, n1 = ?, n2 = ?, n3 = ? WHERE id = ?', name, f('definition') || c.definition, f('n1') || c.n1, f('n2') || c.n2, f('n3') || c.n3, c.id);
    }
    for (const cargo of await domain.listCargos()) {
      for (const c of comps) {
        const raw = req.body[`lvl_${cargo.id}_${c.code}`];
        if (raw === undefined) continue;
        const lvl = ['1', '2', '3'].includes(String(raw)) ? Number(raw) : null;
        await dbm.run(`INSERT INTO matrix_levels (version_id, cargo_id, competency_code, required_level) VALUES (?,?,?,?)
                      ON CONFLICT(version_id, cargo_id, competency_code) DO UPDATE SET required_level = excluded.required_level`, d.id, cargo.id, c.code, lvl);
      }
    }
    if (req.body.nova_competencia && String(req.body.nova_nome || '').trim()) {
      const max = comps.reduce((m, c) => Math.max(m, Number(c.code.slice(1)) || 0), 0);
      const code = `C${String(max + 1).padStart(2, '0')}`;
      await dbm.run(`INSERT INTO competencies (version_id, code, name, definition, n1, n2, n3, leadership_only, sort)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`, d.id, code, String(req.body.nova_nome).trim().slice(0, 200), String(req.body.nova_definicao || '').trim() || 'Definição a preencher.',
          'Não domina a competência. Depende de outra pessoa para executar.', 'Critério do nível 2 a preencher.', 'Critério do nível 3 a preencher.', comps.length + 1);
    }
  });
  await audit.log(req, 'alterou_matriz', { details: { acao: 'salvou rascunho' }, coalesceMinutes: 10 });
  await auth.flash(req, 'success', 'Rascunho salvo. Ele só passa a valer depois de publicado.');
  res.redirect('/admin/matriz/rascunho');
});

router.post('/matriz/rascunho/publicar', async (req, res) => {
  if (!(await guardMatrix(req, res))) return;
  const d = await domain.draftVersion();
  if (!d) return res.redirect('/admin/matriz');
  const notes = String(req.body.notes || '').trim();
  const date = String(req.body.version_date || '').trim();
  if (!notes || !isValidDate(date)) {
    await auth.flash(req, 'error', 'Informe a data da versão e descreva o que mudou.');
    return res.redirect('/admin/matriz/rascunho#publicar');
  }
  const number = ((await dbm.get('SELECT MAX(number) AS m FROM matrix_versions')).m || 0) + 1;
  await dbm.tx(async () => {
    await dbm.run("UPDATE matrix_versions SET status = 'substituida' WHERE status = 'vigente'");
    await dbm.run("UPDATE matrix_versions SET status = 'vigente', number = ?, version_date = ?, notes = ?, published_at = ? WHERE id = ?", number, date, notes.slice(0, 2000), nowIso(), d.id);
  });
  await audit.log(req, 'publicou_matriz', { details: { versao: number, data: date, notas: notes } });
  await auth.flash(req, 'success', `Versão ${number} publicada e vigente. Ela será usada no próximo início de ciclo.`);
  res.redirect('/admin/matriz');
});

router.post('/matriz/rascunho/descartar', async (req, res) => {
  const d = await domain.draftVersion();
  if (d) {
    await dbm.run('DELETE FROM matrix_versions WHERE id = ?', d.id);
    await audit.log(req, 'alterou_matriz', { details: { acao: 'descartou rascunho' } });
  }
  await auth.flash(req, 'success', 'Rascunho descartado.');
  res.redirect('/admin/matriz');
});

/* ------------------------------------------------------------------ e-mails */

const EMAIL_STATUS = { retido_teste: 'Retido (modo de teste)', enviado: 'Enviado', erro: 'Erro', pendente: 'Enviando' };

router.get('/emails', async (req, res) => {
  const emails = await dbm.all('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 300');
  res.render('admin/emails', { title: 'E-mails', emails, EMAIL_STATUS, smtp: mailer.smtpConfigured(), smtpHost: config.smtp.host });
});

router.get('/emails/:id', async (req, res) => {
  const email = await dbm.get('SELECT * FROM email_outbox WHERE id = ?', Number(req.params.id));
  if (!email) return res.status(404).render('error', { title: 'E-mail não encontrado', message: 'Mensagem inexistente.' });
  res.render('admin/email', { title: email.subject, email, EMAIL_STATUS });
});

router.get('/emails/:id/html', async (req, res) => {
  const email = await dbm.get('SELECT * FROM email_outbox WHERE id = ?', Number(req.params.id));
  if (!email) return res.status(404).send('Não encontrado');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.set('X-Frame-Options', 'SAMEORIGIN');
  return res.type('html').send(email.html);
});

/* ---------------------------------------------------------------------- log */

async function logQuery(q) {
  const where = [];
  const params = [];
  if (q.pessoa) { where.push('(a.user_id = ? OR a.acting_as_user_id = ?)'); params.push(Number(q.pessoa), Number(q.pessoa)); }
  if (q.titular) { where.push('a.subject_user_id = ?'); params.push(Number(q.titular)); }
  if (q.acao) { where.push('a.action = ?'); params.push(q.acao); }
  if (q.de && isValidDate(q.de)) { where.push('a.at >= ?'); params.push(`${q.de}T00:00:00`); }
  if (q.ate && isValidDate(q.ate)) { where.push('a.at <= ?'); params.push(`${q.ate}T23:59:59.999Z`); }
  return await dbm.all(`SELECT a.*, u.name AS user_name, au.name AS acting_name, su.name AS subject_name
                         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                         LEFT JOIN users au ON au.id = a.acting_as_user_id LEFT JOIN users su ON su.id = a.subject_user_id
                        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT 2000`, ...params);
}

router.get('/log', async (req, res) => {
  const rows = await logQuery(req.query);
  res.render('admin/log', { title: 'Log de acesso (LGPD)', rows: rows.slice(0, 500), total: rows.length, q: req.query, users: await domain.listUsers(), ACTIONS: audit.ACTIONS });
});

router.get('/log/exportar.xlsx', async (req, res, next) => {
  try {
    const rows = await logQuery(req.query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Log de acesso');
    ws.columns = [
      { header: 'Data e hora (UTC)', key: 'at', width: 24 }, { header: 'Usuário', key: 'user', width: 18 },
      { header: 'Como (modo de teste)', key: 'acting', width: 18 }, { header: 'Ação', key: 'action', width: 36 },
      { header: 'Titular dos dados', key: 'subject', width: 18 }, { header: 'Registro', key: 'entity', width: 16 },
      { header: 'Detalhes', key: 'details', width: 60 }, { header: 'IP', key: 'ip', width: 16 },
    ];
    for (const r of rows) {
      ws.addRow({ at: r.at, user: r.user_name || 'Sistema', acting: r.acting_name || '', action: audit.ACTIONS[r.action] || r.action,
        subject: r.subject_name || '', entity: r.entity ? `${r.entity} ${r.entity_id || ''}` : '', details: r.details || '', ip: r.ip || '' });
    }
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3E9E' } };
    await audit.log(req, 'exportou_log');
    const buf = await wb.xlsx.writeBuffer();
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="log-acesso-lgpd.xlsx"');
    return res.send(Buffer.from(buf));
  } catch (err) { return next(err); }
});

/* ------------------------------------------------------------ configurações */

router.get('/configuracoes', async (req, res) => {
  res.render('admin/config', {
    title: 'Configurações', smtp: mailer.smtpConfigured(), smtpHost: config.smtp.host, smtpFrom: config.smtp.from,
    appUrl: config.appUrl, hasLogo: !!await dbm.getSetting('logo_file'), wentLiveAt: await dbm.getSetting('went_live_at'),
  });
});

const LOGO_EXT = ['.png', '.jpg', '.jpeg', '.svg', '.webp'];
router.post('/configuracoes/logo', memUpload.single('logo'), auth.csrfAfterUpload, async (req, res) => {
  if (req.body.remover) {
    await dbm.run("DELETE FROM app_files WHERE key = 'logo'");
    await dbm.run("DELETE FROM settings WHERE key = 'logo_file'");
    await audit.log(req, 'alterou_configuracoes', { details: { logo: 'removido' } });
    await auth.flash(req, 'success', 'Logo removido. O sistema voltou a usar o logo padrão.');
    return res.redirect('/admin/configuracoes');
  }
  if (!req.file) {
    await auth.flash(req, 'error', 'Selecione o arquivo do logo.');
    return res.redirect('/admin/configuracoes');
  }
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!LOGO_EXT.includes(ext)) {
    await auth.flash(req, 'error', 'Use PNG, JPG, SVG ou WEBP.');
    return res.redirect('/admin/configuracoes');
  }
  const name = `logo${ext}`;
  if (ext === '.svg' && !(await require('../lib/pdf').svgLogoWorks(req.file.buffer.toString('utf8')))) {
    await auth.flash(req, 'error', 'Este SVG não pôde ser usado nos PDFs. Envie o logo em PNG ou JPG.');
    return res.redirect('/admin/configuracoes');
  }
  const mimes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
  await dbm.run(`INSERT INTO app_files (key, name, mime, data, updated_at) VALUES ('logo', ?, ?, ?, ?)
                 ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
  name, mimes[ext], req.file.buffer, nowIso());
  await dbm.setSetting('logo_file', name);
  await dbm.setSetting('logo_version', String(Date.now()));
  await audit.log(req, 'alterou_configuracoes', { details: { logo: req.file.originalname } });
  await auth.flash(req, 'success', 'Logo atualizado.');
  return res.redirect('/admin/configuracoes');
});

module.exports = router;
