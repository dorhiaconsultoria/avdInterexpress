'use strict';
const path = require('path');
const express = require('express');
const multer = require('multer');
const dbm = require('../db');
const config = require('../config');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const domain = require('../lib/domain');
const mailer = require('../lib/mailer');
const { checklistAccess } = require('../lib/access');
const { nowIso, fmtTime, isValidDate, ACTION_CATEGORIES, ACTION_STATUS } = require('../lib/util');

const router = require('../lib/async-router')();

const ALLOWED_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.odt', '.ods', '.msg', '.eml'];
const upload = multer({
  // O arquivo fica na memória e é gravado no banco (funciona no Vercel, que não tem disco permanente)
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // Nomes de arquivo chegam em latin1 no multipart; converte para UTF-8.
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ok = ALLOWED_EXT.includes(path.extname(file.originalname).toLowerCase());
    if (!ok) {
      const err = new Error('Tipo de arquivo não permitido. Use PDF, imagem, Word, Excel, texto ou e-mail.');
      err.status = 400;
      err.expose = true;
      return cb(err);
    }
    return cb(null, true);
  },
});

function wantsJson(req) {
  return (req.get('accept') || '').includes('application/json') || req.xhr;
}

/** Carrega o checklist e as permissões do usuário efetivo. */
async function loadChecklist(req, res, next) {
  const bundle = await domain.loadChecklistBundle(Number(req.params.id));
  if (!bundle) return res.status(404).render('error', { title: 'Checklist não encontrado', message: 'O checklist solicitado não existe.' });
  const access = checklistAccess(req.user, bundle.cl, bundle.evals, bundle.sigs);
  if (!access.canView) {
    return auth.forbidden(res, 'Você não tem acesso a este checklist. Cada gestor vê apenas a sua equipe direta (LGPD).');
  }
  req.bundle = bundle;
  req.access = access;
  return next();
}

function kindOk(req, res, next) {
  if (!['auto', 'gestor'].includes(req.params.kind)) return res.status(404).render('error', { title: 'Página não encontrada', message: 'Tipo de avaliação inválido.' });
  return next();
}

/** Pode editar a avaliação deste tipo? */
function canEditKind(access, kind) {
  return kind === 'auto' ? access.canEditAuto : access.canEditGestor;
}

function evalTitle(cl, kind) {
  if (kind === 'auto') return 'Autoavaliação';
  return cl.self_verification ? 'Autoverificação' : 'Avaliação do gestor';
}

/* --------------------------------------------------------- visualização */

router.get('/checklists/:id', loadChecklist, async (req, res) => {
  const { bundle, access } = req;
  await audit.log(req, 'visualizou_checklist', { entity: 'checklist', entityId: bundle.cl.id, subjectUserId: bundle.cl.user_id, coalesceMinutes: 10 });
  const history = access.canSeeHistory
    ? await dbm.all(`SELECT a.*, u.name AS user_name, au.name AS acting_name FROM audit_log a
                    LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users au ON au.id = a.acting_as_user_id
                    WHERE a.entity = 'checklist' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 60`, bundle.cl.id)
    : [];
  const candidates = access.canSetValidator
    ? (await domain.listUsers({ activeOnly: true })).filter((u) => u.id !== bundle.cl.user_id) : [];
  res.render('checklist/view', {
    title: `${bundle.cl.user_name} — ${bundle.cl.cargo_code}`,
    ...bundle,
    access,
    history,
    candidates,
    ACTIONS: audit.ACTIONS,
    categories: ACTION_CATEGORIES,
    actionStatus: ACTION_STATUS,
    progressAuto: domain.evaluationProgress(bundle.comps.applicable, bundle.evals.auto),
    progressGestor: domain.evaluationProgress(bundle.comps.applicable, bundle.evals.gestor),
  });
});

/* ------------------------------------------------------------ avaliação */

async function ensureEvaluation(req, kind) {
  const cl = req.bundle.cl;
  let ev = await domain.getEvaluation(cl.id, kind);
  if (!ev) {
    const now = nowIso();
    await dbm.run(`INSERT INTO evaluations (checklist_id, kind, evaluator_user_id, status, started_at, updated_at)
                  VALUES (?, ?, ?, 'rascunho', ?, ?)`, cl.id, kind, req.user.id, now, now);
    await audit.log(req, 'iniciou_avaliacao', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { tipo: kind } });
    await domain.refreshStatus(cl.id);
    ev = await domain.getEvaluation(cl.id, kind);
  }
  return ev;
}

async function guardEdit(req, res, kind) {
  const { cl } = req.bundle;
  if (canEditKind(req.access, kind)) return true;
  const ev = req.bundle.evals[kind];
  let msg = 'Você não pode preencher esta avaliação.';
  if (ev && ev.status === 'enviada') msg = 'Esta avaliação já foi enviada. Somente a administradora pode reabri-la.';
  else if (cl.cycle_status !== 'em_andamento') msg = 'O ciclo não está em andamento.';
  if (wantsJson(req)) {
    res.status(403).json({ error: msg });
  } else {
    await auth.flash(req, 'warn', msg);
    res.redirect(`/checklists/${cl.id}`);
  }
  return false;
}

router.get('/checklists/:id/avaliar/:kind', loadChecklist, kindOk, async (req, res) => {
  const { kind } = req.params;
  const { cl, comps } = req.bundle;
  if (!(await guardEdit(req, res, kind))) return;
  const ev = req.bundle.evals[kind];
  const showIntro = !ev && (kind === 'auto' || cl.self_verification);
  if (showIntro) {
    return res.render('checklist/intro', { title: evalTitle(cl, kind), ...req.bundle, kind });
  }
  const evaluation = ev || await ensureEvaluation(req, kind);
  return res.render('checklist/form', {
    title: evalTitle(cl, kind),
    ...req.bundle,
    kind,
    evaluation,
    access: req.access,
    showRequired: kind === 'gestor',
    progress: domain.evaluationProgress(comps.applicable, evaluation),
    evTitle: evalTitle(cl, kind),
    attachments: req.bundle.attachments.filter((a) => a.evaluation_id === evaluation.id),
  });
});

router.post('/checklists/:id/avaliar/:kind/iniciar', loadChecklist, kindOk, async (req, res) => {
  const { kind } = req.params;
  if (!(await guardEdit(req, res, kind))) return;
  await ensureEvaluation(req, kind);
  res.redirect(`/checklists/${req.bundle.cl.id}/avaliar/${kind}`);
});

async function saveItems(req, ev, entries) {
  const codes = new Set(req.bundle.comps.applicable.map((c) => c.code));
  const now = nowIso();
  const sql = `INSERT INTO evaluation_items (evaluation_id, competency_code, rating, evidence, updated_at)
                             VALUES (?,?,?,?,?) ON CONFLICT(evaluation_id, competency_code)
                             DO UPDATE SET rating = excluded.rating, evidence = excluded.evidence, updated_at = excluded.updated_at`;
  await dbm.tx(async () => {
    for (const e of entries) {
      if (!codes.has(e.code)) continue;
      const rating = [1, 2, 3].includes(Number(e.rating)) ? Number(e.rating) : null;
      const evidence = e.evidence == null ? null : String(e.evidence).slice(0, 4000);
      await dbm.run(sql, ev.id, e.code, rating, evidence, now);
    }
    await dbm.run('UPDATE evaluations SET updated_at = ? WHERE id = ?', now, ev.id);
  });
  return now;
}

// Salvamento automático (JSON) de uma competência
router.post('/checklists/:id/avaliar/:kind/rascunho', loadChecklist, kindOk, async (req, res) => {
  const { kind } = req.params;
  if (!(await guardEdit(req, res, kind))) return;
  const ev = await ensureEvaluation(req, kind);
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  const at = await saveItems(req, ev, items.map((i) => ({ code: i.code, rating: i.rating, evidence: i.evidence })));
  await audit.log(req, 'salvou_rascunho', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { tipo: kind }, coalesceMinutes: 15 });
  const fresh = await domain.getEvaluation(req.bundle.cl.id, kind);
  res.json({ ok: true, savedAt: fmtTime(at), progress: domain.evaluationProgress(req.bundle.comps.applicable, fresh) });
});

// Salvamento do formulário inteiro (funciona sem JavaScript)
router.post('/checklists/:id/avaliar/:kind/salvar', loadChecklist, kindOk, async (req, res) => {
  const { kind } = req.params;
  if (!(await guardEdit(req, res, kind))) return;
  const ev = await ensureEvaluation(req, kind);
  const entries = req.bundle.comps.applicable.map((c) => ({
    code: c.code,
    rating: req.body[`rating_${c.code}`],
    evidence: req.body[`evidence_${c.code}`],
  }));
  await saveItems(req, ev, entries);
  await audit.log(req, 'salvou_rascunho', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { tipo: kind }, coalesceMinutes: 15 });
  if (req.body.revisar) return res.redirect(`/checklists/${req.bundle.cl.id}/avaliar/${kind}/revisar`);
  await auth.flash(req, 'success', 'Rascunho salvo.');
  return res.redirect(`/checklists/${req.bundle.cl.id}/avaliar/${kind}`);
});

router.post('/checklists/:id/avaliar/:kind/anexo', loadChecklist, kindOk, async (req, res, next) => {
  if (!canEditKind(req.access, req.params.kind)) return guardEdit(req, res, req.params.kind);
  return upload.single('arquivo')(req, res, (err) => {
    if (err) {
      if (wantsJson(req)) return res.status(err.status || 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Arquivo maior que ${config.maxUploadMb} MB.` : err.message });
      return next(err);
    }
    return next();
  });
}, async (req, res) => {
  if (!req.sessionRow || req.body._csrf !== req.sessionRow.csrf) {
    return res.status(403).json({ error: 'Sessão expirada. Recarregue a página.' });
  }
  const { kind } = req.params;
  const code = String(req.body.code || '');
  if (!req.file) return res.status(400).json({ error: 'Selecione um arquivo.' });
  if (!req.bundle.comps.applicable.some((c) => c.code === code)) {
    return res.status(400).json({ error: 'Competência inválida.' });
  }
  const ev = await ensureEvaluation(req, kind);
  const attId = await dbm.insert(`INSERT INTO attachments (checklist_id, evaluation_id, competency_code, kind, original_name, data, mime, size, uploaded_by, uploaded_at)
                          VALUES (?, ?, ?, 'evidencia', ?, ?, ?, ?, ?, ?)`, req.bundle.cl.id, ev.id, code, req.file.originalname.slice(0, 200), req.file.buffer, req.file.mimetype, req.file.size, req.user.id, nowIso());
  await audit.log(req, 'anexou_arquivo', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { competencia: code, arquivo: req.file.originalname } });
  if (wantsJson(req)) return res.json({ ok: true, id: attId, name: req.file.originalname, size: req.file.size });
  return res.redirect(`/checklists/${req.bundle.cl.id}/avaliar/${kind}#${code}`);
});

router.get('/checklists/:id/avaliar/:kind/revisar', loadChecklist, kindOk, async (req, res) => {
  const { kind } = req.params;
  if (!(await guardEdit(req, res, kind))) return;
  const ev = req.bundle.evals[kind];
  if (!ev) return res.redirect(`/checklists/${req.bundle.cl.id}/avaliar/${kind}`);
  const missing = req.bundle.comps.applicable.filter((c) => {
    const it = ev.items[c.code];
    return !it || !it.rating || !it.evidence || !it.evidence.trim();
  });
  return res.render('checklist/review', {
    title: `Revisar ${evalTitle(req.bundle.cl, kind).toLowerCase()}`,
    ...req.bundle,
    kind,
    evaluation: ev,
    missing,
    showRequired: kind === 'gestor',
    evTitle: evalTitle(req.bundle.cl, kind),
    attachments: req.bundle.attachments.filter((a) => a.evaluation_id === ev.id),
  });
});

router.post('/checklists/:id/avaliar/:kind/enviar', loadChecklist, kindOk, async (req, res, next) => {
  try {
    const { kind } = req.params;
    if (!(await guardEdit(req, res, kind))) return;
    const { cl } = req.bundle;
    const ev = req.bundle.evals[kind];
    if (!ev) return res.redirect(`/checklists/${cl.id}/avaliar/${kind}`);
    const missing = req.bundle.comps.applicable.filter((c) => {
      const it = ev.items[c.code];
      return !it || !it.rating || !it.evidence || !it.evidence.trim();
    });
    if (missing.length) {
      await auth.flash(req, 'error', `Faltam nota e evidência em ${missing.length} competência(s). Toda nota exige uma evidência.`);
      return res.redirect(`/checklists/${cl.id}/avaliar/${kind}/revisar`);
    }
    const now = nowIso();
    await dbm.run("UPDATE evaluations SET status = 'enviada', submitted_at = ?, updated_at = ? WHERE id = ?", now, now, ev.id);
    if (kind === 'gestor') await domain.syncGapActions(cl.id);
    const before = cl.results_released_at;
    await domain.refreshStatus(cl.id);
    await audit.log(req, 'enviou_avaliacao', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { tipo: kind } });
    const after = await domain.getChecklist(cl.id);
    if (!before && after.results_released_at) {
      await mailer.queue(mailer.templates.resultadoLiberado(await domain.getUser(after.user_id), after));
    }
    let msg = 'Avaliação enviada com sucesso.';
    if (kind === 'auto') msg = 'Autoavaliação enviada. Agora o seu gestor faz a avaliação dele; depois o RH libera o resultado.';
    else if (cl.self_verification) msg = 'Autoverificação enviada. Complete o plano de ação das lacunas e assine; depois o validador confirma (ou a ata da Diretoria é anexada).';
    else msg = 'Avaliação enviada. Agora você já pode ver a autoavaliação e preparar o plano de ação das lacunas.';
    await auth.flash(req, 'success', msg);
    return res.redirect(`/checklists/${cl.id}`);
  } catch (err) { return next(err); }
});

/* ---------------------------------------------------------------- anexos */

async function attachmentAccess(req, att) {
  const bundle = await domain.loadChecklistBundle(att.checklist_id);
  if (!bundle) return null;
  const access = checklistAccess(req.user, bundle.cl, bundle.evals, bundle.sigs);
  if (!access.canView) return null;
  if (att.kind === 'evidencia') {
    const ev = await dbm.get('SELECT kind FROM evaluations WHERE id = ?', att.evaluation_id);
    if (!ev) return null;
    if (ev.kind === 'auto' && !access.seeAuto) return null;
    if (ev.kind === 'gestor' && !access.seeGestor && att.uploaded_by !== req.user.id) return null;
  }
  return { bundle, access };
}

router.get('/anexos/:aid', async (req, res) => {
  const att = await dbm.get('SELECT id, checklist_id, evaluation_id, competency_code, kind, original_name, mime, size, uploaded_by, uploaded_at FROM attachments WHERE id = ?', Number(req.params.aid));
  if (!att) return res.status(404).render('error', { title: 'Arquivo não encontrado', message: 'O anexo não existe mais.' });
  const ctx = await attachmentAccess(req, att);
  if (!ctx) return auth.forbidden(res, 'Você não tem acesso a este anexo.');
  await audit.log(req, 'baixou_anexo', { entity: 'checklist', entityId: att.checklist_id, subjectUserId: ctx.bundle.cl.user_id, details: { arquivo: att.original_name } });
  const file = await dbm.get('SELECT data FROM attachments WHERE id = ?', att.id);
  res.set('Content-Type', att.mime || 'application/octet-stream');
  res.attachment(att.original_name);
  return res.send(file.data);
});

router.post('/anexos/:aid/excluir', async (req, res) => {
  const att = await dbm.get('SELECT id, checklist_id, evaluation_id, competency_code, kind, original_name, mime, size, uploaded_by, uploaded_at FROM attachments WHERE id = ?', Number(req.params.aid));
  if (!att) return res.status(404).json({ error: 'Anexo não encontrado.' });
  const bundle = await domain.loadChecklistBundle(att.checklist_id);
  const access = checklistAccess(req.user, bundle.cl, bundle.evals, bundle.sigs);
  let allowed = false;
  if (att.kind === 'evidencia') {
    const ev = await dbm.get('SELECT kind FROM evaluations WHERE id = ?', att.evaluation_id);
    allowed = att.uploaded_by === req.user.id && ev && canEditKind(access, ev.kind);
  } else if (att.kind === 'ata') {
    allowed = access.isAdmin && bundle.cl.status !== 'assinada';
  }
  if (!allowed) {
    if (wantsJson(req)) return res.status(403).json({ error: 'Você não pode remover este anexo.' });
    return auth.forbidden(res, 'Você não pode remover este anexo.');
  }
  await dbm.run('DELETE FROM attachments WHERE id = ?', att.id);
  await audit.log(req, 'removeu_anexo', { entity: 'checklist', entityId: att.checklist_id, subjectUserId: bundle.cl.user_id, details: { arquivo: att.original_name } });
  await domain.refreshStatus(att.checklist_id);
  if (wantsJson(req)) return res.json({ ok: true });
  return res.redirect(`/checklists/${att.checklist_id}`);
});

/* -------------------------------------------------------- plano de ação */

function cleanAction(body) {
  const due = String(body.due_date || '').trim();
  return {
    action: String(body.action || '').trim().slice(0, 2000) || null,
    responsible: String(body.responsible || '').trim().slice(0, 200) || null,
    due_date: isValidDate(due) ? due : null,
    category: ACTION_CATEGORIES[body.category] ? body.category : null,
    status: ACTION_STATUS[body.status] ? body.status : null,
  };
}

async function planDone(req, res, msg) {
  if (msg) await auth.flash(req, 'success', msg);
  return res.redirect(`/checklists/${req.bundle.cl.id}#plano`);
}

router.post('/checklists/:id/plano/nova', loadChecklist, async (req, res) => {
  const { access, cl } = { access: req.access, cl: req.bundle.cl };
  if (!access.canProposeFree) return auth.forbidden(res, 'Você não pode incluir ações neste plano agora.');
  const a = cleanAction(req.body);
  if (!a.action) {
    await auth.flash(req, 'error', 'Descreva a ação de desenvolvimento.');
    return res.redirect(`/checklists/${cl.id}#plano`);
  }
  const now = nowIso();
  const autoValid = access.isEvaluator || (access.isSelf && access.isOwner);
  await dbm.run(`INSERT INTO action_items (checklist_id, origin, category, action, responsible, due_date, status, proposed_by, validated_by, validated_at, created_at, updated_at)
                VALUES (?, 'livre', ?, ?, ?, ?, 'nao_iniciada', ?, ?, ?, ?, ?)`, cl.id, a.category || 'outro', a.action, a.responsible, a.due_date, req.user.id,
      autoValid ? req.user.id : null, autoValid ? now : null, now, now);
  await audit.log(req, 'incluiu_acao', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id });
  return await planDone(req, res, autoValid ? 'Ação incluída no plano.' : 'Ação sugerida. O gestor vai complementar e validar.');
});

async function getAction(req) {
  return await dbm.get('SELECT * FROM action_items WHERE id = ? AND checklist_id = ?', Number(req.params.aid), req.bundle.cl.id);
}

router.post('/checklists/:id/plano/:aid', loadChecklist, async (req, res) => {
  const item = await getAction(req);
  if (!item) return res.status(404).render('error', { title: 'Ação não encontrada', message: 'A ação não existe.' });
  const { access } = req;
  const allowed = item.origin === 'lacuna'
    ? access.canEditGapActions
    : (access.canValidateFree || (access.canProposeFree && item.proposed_by === req.user.id));
  if (!allowed) return auth.forbidden(res, 'Você não pode alterar esta ação agora.');
  const a = cleanAction(req.body);
  if (req.body.due_date && !a.due_date) {
    await auth.flash(req, 'error', 'Prazo inválido.');
    return res.redirect(`/checklists/${req.bundle.cl.id}#plano`);
  }
  const status = a.status || item.status;
  await dbm.run(`UPDATE action_items SET action = ?, responsible = ?, due_date = ?, status = ?, category = COALESCE(?, category),
                completed_at = ?, updated_at = ? WHERE id = ?`, a.action, a.responsible, a.due_date, status, item.origin === 'livre' ? a.category : null,
      status === 'concluida' ? (item.completed_at || nowIso()) : null, nowIso(), item.id);
  await audit.log(req, 'alterou_plano', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { acao: item.id, competencia: item.competency_code } });
  return await planDone(req, res, 'Plano de ação atualizado.');
});

router.post('/checklists/:id/plano/:aid/status', loadChecklist, async (req, res) => {
  const item = await getAction(req);
  if (!item) return res.status(404).render('error', { title: 'Ação não encontrada', message: 'A ação não existe.' });
  if (!req.access.canUpdateActionStatus) return auth.forbidden(res, 'Você não pode atualizar o andamento desta ação.');
  const status = ACTION_STATUS[req.body.status] ? req.body.status : item.status;
  await dbm.run('UPDATE action_items SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?', status, status === 'concluida' ? (item.completed_at || nowIso()) : null, nowIso(), item.id);
  await audit.log(req, 'alterou_plano', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { acao: item.id, status } });
  return await planDone(req, res, 'Andamento da ação atualizado.');
});

router.post('/checklists/:id/plano/:aid/validar', loadChecklist, async (req, res) => {
  const item = await getAction(req);
  if (!item || item.origin !== 'livre') return res.status(404).render('error', { title: 'Ação não encontrada', message: 'A ação não existe.' });
  if (!req.access.canValidateFree) return auth.forbidden(res, 'Somente o gestor valida as ações sugeridas.');
  if (!domain.actionDefined(item)) {
    await auth.flash(req, 'error', 'Antes de validar, complete a ação, o responsável e o prazo.');
    return res.redirect(`/checklists/${req.bundle.cl.id}#plano`);
  }
  await dbm.run('UPDATE action_items SET validated_by = ?, validated_at = ?, updated_at = ? WHERE id = ?', req.user.id, nowIso(), nowIso(), item.id);
  await audit.log(req, 'validou_acao', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { acao: item.id } });
  return await planDone(req, res, 'Ação validada.');
});

router.post('/checklists/:id/plano/:aid/excluir', loadChecklist, async (req, res) => {
  const item = await getAction(req);
  if (!item || item.origin !== 'livre') return res.status(404).render('error', { title: 'Ação não encontrada', message: 'Somente ações livres podem ser excluídas.' });
  const allowed = req.access.canValidateFree || (req.access.canProposeFree && item.proposed_by === req.user.id);
  if (!allowed) return auth.forbidden(res, 'Você não pode excluir esta ação.');
  await dbm.run('DELETE FROM action_items WHERE id = ?', item.id);
  await audit.log(req, 'excluiu_acao', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { acao: item.id } });
  return await planDone(req, res, 'Ação excluída.');
});

router.post('/checklists/:id/observacoes', loadChecklist, async (req, res) => {
  if (!req.access.canEditNotes) return auth.forbidden(res, 'Somente o gestor registra observações, antes das assinaturas.');
  await dbm.run('UPDATE checklists SET manager_notes = ? WHERE id = ?', String(req.body.manager_notes || '').trim().slice(0, 4000) || null, req.bundle.cl.id);
  await audit.log(req, 'alterou_observacoes', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id });
  return await planDone(req, res, 'Observações salvas.');
});

/* ------------------------------------------------------------ assinaturas */

router.post('/checklists/:id/assinar', loadChecklist, async (req, res) => {
  const { cl, evals, actions, sigs } = req.bundle;
  const { access } = req;
  const role = String(req.body.role || '');
  const allowedRole = (role === 'colaborador' && access.canSignAsEmployee)
    || (role === 'gestor' && access.canSignAsManager)
    || (role === 'validador' && access.canValidate);
  if (!allowedRole) return auth.forbidden(res, 'Você não pode assinar neste papel.');
  if (sigs[role]) {
    await auth.flash(req, 'info', 'Esta assinatura já foi registrada.');
    return res.redirect(`/checklists/${cl.id}#assinaturas`);
  }
  if (role === 'validador') {
    if (!domain.isSubmitted(evals.gestor)) {
      await auth.flash(req, 'error', 'A autoverificação ainda não foi enviada.');
      return res.redirect(`/checklists/${cl.id}#validacao`);
    }
  } else if (!await domain.canSignNow(cl, evals, actions)) {
    await auth.flash(req, 'error', 'Ainda há requisitos pendentes para assinar. Veja a lista na seção Assinaturas.');
    return res.redirect(`/checklists/${cl.id}#assinaturas`);
  }
  if (!req.body.ciente) {
    await auth.flash(req, 'error', 'Marque a confirmação de leitura para assinar.');
    return res.redirect(`/checklists/${cl.id}#assinaturas`);
  }
  // Confirmação com a senha (dispensada quando a administradora testa como outra pessoa)
  if (!req.impersonating && !auth.verifyPassword(String(req.body.senha || ''), req.realUser.password_hash)) {
    await auth.flash(req, 'error', 'Senha incorreta. A assinatura eletrônica exige a sua senha.');
    return res.redirect(`/checklists/${cl.id}#assinaturas`);
  }
  const comment = String(req.body.comentario || '').trim().slice(0, 2000) || null;
  await dbm.run(`INSERT INTO signatures (checklist_id, role, user_id, signer_name, signed_at, comment, ip, impersonated_by)
                VALUES (?,?,?,?,?,?,?,?)`, cl.id, role, req.user.id, req.user.name, nowIso(), comment, req.ip, req.impersonating ? req.realUser.id : null);
  if (role === 'colaborador' && comment) await dbm.run('UPDATE checklists SET employee_comment = ? WHERE id = ?', comment, cl.id);
  const status = await domain.refreshStatus(cl.id);
  await audit.log(req, role === 'validador' ? 'validou_autoverificacao' : 'assinou', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { papel: role } });
  await auth.flash(req, 'success', status === 'assinada' ? 'Assinatura registrada. O checklist está fechado.' : 'Assinatura registrada.');
  return res.redirect(`/checklists/${cl.id}#assinaturas`);
});

router.post('/checklists/:id/retirar-assinatura', loadChecklist, async (req, res) => {
  const { cl, sigs } = req.bundle;
  const role = String(req.body.role || '');
  const sig = sigs[role];
  if (!sig || sig.user_id !== req.user.id) return auth.forbidden(res, 'Você só pode retirar a sua própria assinatura.');
  if (cl.status === 'assinada') {
    await auth.flash(req, 'error', 'O checklist já está fechado. Para alterar, peça à administradora que reabra.');
    return res.redirect(`/checklists/${cl.id}#assinaturas`);
  }
  await dbm.run('DELETE FROM signatures WHERE id = ?', sig.id);
  await domain.refreshStatus(cl.id);
  await audit.log(req, 'retirou_assinatura', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { papel: role } });
  await auth.flash(req, 'success', 'Assinatura retirada. O plano de ação pode ser alterado novamente.');
  return res.redirect(`/checklists/${cl.id}#assinaturas`);
});

/* -------------------------------------------------------- administração */

router.post('/checklists/:id/liberar', loadChecklist, async (req, res, next) => {
  try {
    const { cl } = req.bundle;
    if (!req.access.canRelease) return auth.forbidden(res, 'O resultado só pode ser liberado pela administradora, depois das duas avaliações.');
    await dbm.run('UPDATE checklists SET results_released_at = ?, results_released_by = ? WHERE id = ?', nowIso(), req.user.id, cl.id);
    await audit.log(req, 'liberou_resultado', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id });
    await mailer.queue(mailer.templates.resultadoLiberado(await domain.getUser(cl.user_id), cl));
    await auth.flash(req, 'success', `Resultado liberado para ${cl.user_name}.`);
    return res.redirect(req.body.voltar === 'acompanhamento' ? '/acompanhamento' : `/checklists/${cl.id}`);
  } catch (err) { return next(err); }
});

router.post('/checklists/:id/reabrir', loadChecklist, async (req, res) => {
  const { cl } = req.bundle;
  if (!req.access.canReopen) return auth.forbidden(res, 'Somente a administradora reabre avaliações.');
  const kind = req.body.kind === 'auto' ? 'auto' : 'gestor';
  const reason = String(req.body.motivo || '').trim();
  const ev = req.bundle.evals[kind];
  if (!ev || ev.status !== 'enviada') {
    await auth.flash(req, 'error', 'Esta avaliação não está enviada.');
    return res.redirect(`/checklists/${cl.id}`);
  }
  if (!reason) {
    await auth.flash(req, 'error', 'Informe o motivo da reabertura.');
    return res.redirect(`/checklists/${cl.id}#admin`);
  }
  await dbm.tx(async () => {
    await dbm.run(`UPDATE evaluations SET status = 'rascunho', submitted_at = NULL, reopened_at = ?, reopened_by = ?, reopen_reason = ?
                  WHERE id = ?`, nowIso(), req.realUser.id, reason.slice(0, 1000), ev.id);
    await dbm.run('DELETE FROM signatures WHERE checklist_id = ?', cl.id);
    await dbm.run('UPDATE checklists SET results_released_at = NULL, results_released_by = NULL, closed_at = NULL WHERE id = ?', cl.id);
  });
  await domain.refreshStatus(cl.id);
  await audit.log(req, 'reabriu_avaliacao', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { tipo: kind, motivo: reason } });
  await auth.flash(req, 'success', `${evalTitle(cl, kind)} reaberta. As assinaturas foram removidas e o resultado voltou a ficar oculto até nova liberação.`);
  return res.redirect(`/checklists/${cl.id}`);
});

router.post('/checklists/:id/validador', loadChecklist, async (req, res, next) => {
  try {
    const { cl } = req.bundle;
    if (!req.access.canSetValidator) return auth.forbidden(res, 'Somente a administradora escolhe o validador.');
    const vid = Number(req.body.validator_user_id) || null;
    const validator = vid ? await domain.getUser(vid) : null;
    if (vid && (!validator || !validator.active || validator.id === cl.user_id)) {
      await auth.flash(req, 'error', 'Escolha uma pessoa diferente do titular do checklist.');
      return res.redirect(`/checklists/${cl.id}#validacao`);
    }
    if (req.bundle.sigs.validador) {
      await auth.flash(req, 'error', 'A validação já foi registrada. Para trocar o validador, reabra a autoverificação.');
      return res.redirect(`/checklists/${cl.id}#validacao`);
    }
    await dbm.run('UPDATE checklists SET validator_user_id = ? WHERE id = ?', vid, cl.id);
    await audit.log(req, 'definiu_validador', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { validador: validator ? validator.name : null } });
    if (validator) await mailer.queue(mailer.templates.validador(validator, cl));
    await auth.flash(req, 'success', validator ? `${validator.name} foi definido(a) como validador(a).` : 'Validador removido.');
    return res.redirect(`/checklists/${cl.id}#validacao`);
  } catch (err) { return next(err); }
});

router.post('/checklists/:id/ata', loadChecklist, async (req, res, next) => {
  if (!req.access.canUploadAta || !req.bundle.cl.self_verification) return auth.forbidden(res, 'Você não pode anexar a ata neste checklist.');
  return upload.single('arquivo')(req, res, next);
}, async (req, res) => {
  if (!req.sessionRow || req.body._csrf !== req.sessionRow.csrf) {
    return auth.forbidden(res, 'Sessão expirada. Recarregue a página.');
  }
  if (!req.file) {
    await auth.flash(req, 'error', 'Selecione o arquivo da ata.');
    return res.redirect(`/checklists/${req.bundle.cl.id}#validacao`);
  }
  const { cl } = req.bundle;
  await dbm.run(`INSERT INTO attachments (checklist_id, kind, original_name, data, mime, size, uploaded_by, uploaded_at)
                VALUES (?, 'ata', ?, ?, ?, ?, ?, ?)`, cl.id, req.file.originalname.slice(0, 200), req.file.buffer, req.file.mimetype, req.file.size, req.user.id, nowIso());
  await domain.refreshStatus(cl.id);
  await audit.log(req, 'anexou_ata', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { arquivo: req.file.originalname } });
  await auth.flash(req, 'success', 'Ata da Diretoria anexada ao registro.');
  return res.redirect(`/checklists/${cl.id}#validacao`);
});

/* -------------------------------------------------------------------- PDF */

router.get('/checklists/:id/pdf', loadChecklist, async (req, res, next) => {
  try {
    const pdf = require('../lib/pdf');
    const buf = await pdf.checklistPdf(req.bundle, req.access);
    await audit.log(req, 'baixou_pdf_checklist', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id });
    const name = `checklist-${req.bundle.cycle.year}-${req.bundle.cl.cargo_code}-${req.bundle.cl.user_name}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9-]+/g, '-');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${name}.pdf"`);
    res.send(buf);
  } catch (err) { next(err); }
});

module.exports = router;
