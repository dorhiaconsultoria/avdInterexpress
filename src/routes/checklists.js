'use strict';
const fs = require('fs');
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
const { nowIso, fmtTime, isValidDate, randomToken, ACTION_CATEGORIES, ACTION_STATUS } = require('../lib/util');

const router = express.Router();
const db = () => dbm.get();

const ALLOWED_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.odt', '.ods', '.msg', '.eml'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${randomToken(9)}${path.extname(file.originalname).toLowerCase()}`),
  }),
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

function removeUploaded(req) {
  if (req.file) fs.unlink(req.file.path, () => {});
}

function wantsJson(req) {
  return (req.get('accept') || '').includes('application/json') || req.xhr;
}

/** Carrega o checklist e as permissões do usuário efetivo. */
function loadChecklist(req, res, next) {
  const bundle = domain.loadChecklistBundle(Number(req.params.id));
  if (!bundle) return res.status(404).render('error', { title: 'Checklist não encontrado', message: 'O checklist solicitado não existe.' });
  const access = checklistAccess(req.user, bundle.cl, bundle.evals);
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

router.get('/checklists/:id', loadChecklist, (req, res) => {
  const { bundle, access } = req;
  audit.log(req, 'visualizou_checklist', { entity: 'checklist', entityId: bundle.cl.id, subjectUserId: bundle.cl.user_id, coalesceMinutes: 10 });
  const history = access.canSeeHistory
    ? db().prepare(`SELECT a.*, u.name AS user_name, au.name AS acting_name FROM audit_log a
                    LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users au ON au.id = a.acting_as_user_id
                    WHERE a.entity = 'checklist' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 60`).all(bundle.cl.id)
    : [];
  const candidates = access.canSetValidator
    ? domain.listUsers({ activeOnly: true }).filter((u) => u.id !== bundle.cl.user_id) : [];
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

function ensureEvaluation(req, kind) {
  const cl = req.bundle.cl;
  let ev = domain.getEvaluation(cl.id, kind);
  if (!ev) {
    const now = nowIso();
    db().prepare(`INSERT INTO evaluations (checklist_id, kind, evaluator_user_id, status, started_at, updated_at)
                  VALUES (?, ?, ?, 'rascunho', ?, ?)`).run(cl.id, kind, req.user.id, now, now);
    audit.log(req, 'iniciou_avaliacao', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { tipo: kind } });
    domain.refreshStatus(cl.id);
    ev = domain.getEvaluation(cl.id, kind);
  }
  return ev;
}

function guardEdit(req, res, kind) {
  const { cl } = req.bundle;
  if (canEditKind(req.access, kind)) return true;
  const ev = req.bundle.evals[kind];
  let msg = 'Você não pode preencher esta avaliação.';
  if (ev && ev.status === 'enviada') msg = 'Esta avaliação já foi enviada. Somente a administradora pode reabri-la.';
  else if (cl.cycle_status !== 'em_andamento') msg = 'O ciclo não está em andamento.';
  if (wantsJson(req)) {
    res.status(403).json({ error: msg });
  } else {
    auth.flash(req, 'warn', msg);
    res.redirect(`/checklists/${cl.id}`);
  }
  return false;
}

router.get('/checklists/:id/avaliar/:kind', loadChecklist, kindOk, (req, res) => {
  const { kind } = req.params;
  const { cl, comps } = req.bundle;
  if (!guardEdit(req, res, kind)) return;
  const ev = req.bundle.evals[kind];
  const showIntro = !ev && (kind === 'auto' || cl.self_verification);
  if (showIntro) {
    return res.render('checklist/intro', { title: evalTitle(cl, kind), ...req.bundle, kind });
  }
  const evaluation = ev || ensureEvaluation(req, kind);
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

router.post('/checklists/:id/avaliar/:kind/iniciar', loadChecklist, kindOk, (req, res) => {
  const { kind } = req.params;
  if (!guardEdit(req, res, kind)) return;
  ensureEvaluation(req, kind);
  res.redirect(`/checklists/${req.bundle.cl.id}/avaliar/${kind}`);
});

function saveItems(req, ev, entries) {
  const codes = new Set(req.bundle.comps.applicable.map((c) => c.code));
  const now = nowIso();
  const stmt = db().prepare(`INSERT INTO evaluation_items (evaluation_id, competency_code, rating, evidence, updated_at)
                             VALUES (?,?,?,?,?) ON CONFLICT(evaluation_id, competency_code)
                             DO UPDATE SET rating = excluded.rating, evidence = excluded.evidence, updated_at = excluded.updated_at`);
  const tx = db().transaction(() => {
    for (const e of entries) {
      if (!codes.has(e.code)) continue;
      const rating = [1, 2, 3].includes(Number(e.rating)) ? Number(e.rating) : null;
      const evidence = e.evidence == null ? null : String(e.evidence).slice(0, 4000);
      stmt.run(ev.id, e.code, rating, evidence, now);
    }
    db().prepare('UPDATE evaluations SET updated_at = ? WHERE id = ?').run(now, ev.id);
  });
  tx();
  return now;
}

// Salvamento automático (JSON) de uma competência
router.post('/checklists/:id/avaliar/:kind/rascunho', loadChecklist, kindOk, (req, res) => {
  const { kind } = req.params;
  if (!guardEdit(req, res, kind)) return;
  const ev = ensureEvaluation(req, kind);
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  const at = saveItems(req, ev, items.map((i) => ({ code: i.code, rating: i.rating, evidence: i.evidence })));
  audit.log(req, 'salvou_rascunho', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { tipo: kind }, coalesceMinutes: 15 });
  const fresh = domain.getEvaluation(req.bundle.cl.id, kind);
  res.json({ ok: true, savedAt: fmtTime(at), progress: domain.evaluationProgress(req.bundle.comps.applicable, fresh) });
});

// Salvamento do formulário inteiro (funciona sem JavaScript)
router.post('/checklists/:id/avaliar/:kind/salvar', loadChecklist, kindOk, (req, res) => {
  const { kind } = req.params;
  if (!guardEdit(req, res, kind)) return;
  const ev = ensureEvaluation(req, kind);
  const entries = req.bundle.comps.applicable.map((c) => ({
    code: c.code,
    rating: req.body[`rating_${c.code}`],
    evidence: req.body[`evidence_${c.code}`],
  }));
  saveItems(req, ev, entries);
  audit.log(req, 'salvou_rascunho', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { tipo: kind }, coalesceMinutes: 15 });
  if (req.body.revisar) return res.redirect(`/checklists/${req.bundle.cl.id}/avaliar/${kind}/revisar`);
  auth.flash(req, 'success', 'Rascunho salvo.');
  return res.redirect(`/checklists/${req.bundle.cl.id}/avaliar/${kind}`);
});

router.post('/checklists/:id/avaliar/:kind/anexo', loadChecklist, kindOk, (req, res, next) => {
  if (!canEditKind(req.access, req.params.kind)) return guardEdit(req, res, req.params.kind);
  return upload.single('arquivo')(req, res, (err) => {
    if (err) {
      if (wantsJson(req)) return res.status(err.status || 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Arquivo maior que ${config.maxUploadMb} MB.` : err.message });
      return next(err);
    }
    return next();
  });
}, (req, res) => {
  if (!req.sessionRow || req.body._csrf !== req.sessionRow.csrf) {
    removeUploaded(req);
    return res.status(403).json({ error: 'Sessão expirada. Recarregue a página.' });
  }
  const { kind } = req.params;
  const code = String(req.body.code || '');
  if (!req.file) return res.status(400).json({ error: 'Selecione um arquivo.' });
  if (!req.bundle.comps.applicable.some((c) => c.code === code)) {
    removeUploaded(req);
    return res.status(400).json({ error: 'Competência inválida.' });
  }
  const ev = ensureEvaluation(req, kind);
  const r = db().prepare(`INSERT INTO attachments (checklist_id, evaluation_id, competency_code, kind, original_name, stored_name, mime, size, uploaded_by, uploaded_at)
                          VALUES (?, ?, ?, 'evidencia', ?, ?, ?, ?, ?, ?)`)
    .run(req.bundle.cl.id, ev.id, code, req.file.originalname.slice(0, 200), req.file.filename, req.file.mimetype, req.file.size, req.user.id, nowIso());
  audit.log(req, 'anexou_arquivo', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { competencia: code, arquivo: req.file.originalname } });
  if (wantsJson(req)) return res.json({ ok: true, id: r.lastInsertRowid, name: req.file.originalname, size: req.file.size });
  return res.redirect(`/checklists/${req.bundle.cl.id}/avaliar/${kind}#${code}`);
});

router.get('/checklists/:id/avaliar/:kind/revisar', loadChecklist, kindOk, (req, res) => {
  const { kind } = req.params;
  if (!guardEdit(req, res, kind)) return;
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
    if (!guardEdit(req, res, kind)) return;
    const { cl } = req.bundle;
    const ev = req.bundle.evals[kind];
    if (!ev) return res.redirect(`/checklists/${cl.id}/avaliar/${kind}`);
    const missing = req.bundle.comps.applicable.filter((c) => {
      const it = ev.items[c.code];
      return !it || !it.rating || !it.evidence || !it.evidence.trim();
    });
    if (missing.length) {
      auth.flash(req, 'error', `Faltam nota e evidência em ${missing.length} competência(s). Toda nota exige uma evidência.`);
      return res.redirect(`/checklists/${cl.id}/avaliar/${kind}/revisar`);
    }
    const now = nowIso();
    db().prepare("UPDATE evaluations SET status = 'enviada', submitted_at = ?, updated_at = ? WHERE id = ?").run(now, now, ev.id);
    if (kind === 'gestor') domain.syncGapActions(cl.id);
    const before = cl.results_released_at;
    domain.refreshStatus(cl.id);
    audit.log(req, 'enviou_avaliacao', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { tipo: kind } });
    const after = domain.getChecklist(cl.id);
    if (!before && after.results_released_at) {
      await mailer.queue(mailer.templates.resultadoLiberado(domain.getUser(after.user_id), after));
    }
    let msg = 'Avaliação enviada com sucesso.';
    if (kind === 'auto') msg = 'Autoavaliação enviada. Agora o seu gestor faz a avaliação dele; depois o RH libera o resultado.';
    else if (cl.self_verification) msg = 'Autoverificação enviada. Complete o plano de ação das lacunas e assine; depois o validador confirma (ou a ata da Diretoria é anexada).';
    else msg = 'Avaliação enviada. Agora você já pode ver a autoavaliação e preparar o plano de ação das lacunas.';
    auth.flash(req, 'success', msg);
    return res.redirect(`/checklists/${cl.id}`);
  } catch (err) { return next(err); }
});

/* ---------------------------------------------------------------- anexos */

function attachmentAccess(req, att) {
  const bundle = domain.loadChecklistBundle(att.checklist_id);
  if (!bundle) return null;
  const access = checklistAccess(req.user, bundle.cl, bundle.evals);
  if (!access.canView) return null;
  if (att.kind === 'evidencia') {
    const ev = db().prepare('SELECT kind FROM evaluations WHERE id = ?').get(att.evaluation_id);
    if (!ev) return null;
    if (ev.kind === 'auto' && !access.seeAuto) return null;
    if (ev.kind === 'gestor' && !access.seeGestor && att.uploaded_by !== req.user.id) return null;
  }
  return { bundle, access };
}

router.get('/anexos/:aid', (req, res) => {
  const att = db().prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.aid));
  if (!att) return res.status(404).render('error', { title: 'Arquivo não encontrado', message: 'O anexo não existe mais.' });
  const ctx = attachmentAccess(req, att);
  if (!ctx) return auth.forbidden(res, 'Você não tem acesso a este anexo.');
  const p = path.join(config.uploadsDir, att.stored_name);
  if (!fs.existsSync(p)) return res.status(404).render('error', { title: 'Arquivo não encontrado', message: 'O arquivo não está mais disponível.' });
  audit.log(req, 'baixou_anexo', { entity: 'checklist', entityId: att.checklist_id, subjectUserId: ctx.bundle.cl.user_id, details: { arquivo: att.original_name } });
  return res.download(p, att.original_name);
});

router.post('/anexos/:aid/excluir', (req, res) => {
  const att = db().prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.aid));
  if (!att) return res.status(404).json({ error: 'Anexo não encontrado.' });
  const bundle = domain.loadChecklistBundle(att.checklist_id);
  const access = checklistAccess(req.user, bundle.cl, bundle.evals);
  let allowed = false;
  if (att.kind === 'evidencia') {
    const ev = db().prepare('SELECT kind FROM evaluations WHERE id = ?').get(att.evaluation_id);
    allowed = att.uploaded_by === req.user.id && ev && canEditKind(access, ev.kind);
  } else if (att.kind === 'ata') {
    allowed = access.isAdmin && bundle.cl.status !== 'assinada';
  }
  if (!allowed) {
    if (wantsJson(req)) return res.status(403).json({ error: 'Você não pode remover este anexo.' });
    return auth.forbidden(res, 'Você não pode remover este anexo.');
  }
  db().prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
  fs.unlink(path.join(config.uploadsDir, att.stored_name), () => {});
  audit.log(req, 'removeu_anexo', { entity: 'checklist', entityId: att.checklist_id, subjectUserId: bundle.cl.user_id, details: { arquivo: att.original_name } });
  domain.refreshStatus(att.checklist_id);
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

function planDone(req, res, msg) {
  if (msg) auth.flash(req, 'success', msg);
  return res.redirect(`/checklists/${req.bundle.cl.id}#plano`);
}

router.post('/checklists/:id/plano/nova', loadChecklist, (req, res) => {
  const { access, cl } = { access: req.access, cl: req.bundle.cl };
  if (!access.canProposeFree) return auth.forbidden(res, 'Você não pode incluir ações neste plano agora.');
  const a = cleanAction(req.body);
  if (!a.action) {
    auth.flash(req, 'error', 'Descreva a ação de desenvolvimento.');
    return res.redirect(`/checklists/${cl.id}#plano`);
  }
  const now = nowIso();
  const autoValid = access.isEvaluator || (access.isSelf && access.isOwner);
  db().prepare(`INSERT INTO action_items (checklist_id, origin, category, action, responsible, due_date, status, proposed_by, validated_by, validated_at, created_at, updated_at)
                VALUES (?, 'livre', ?, ?, ?, ?, 'nao_iniciada', ?, ?, ?, ?, ?)`)
    .run(cl.id, a.category || 'outro', a.action, a.responsible, a.due_date, req.user.id,
      autoValid ? req.user.id : null, autoValid ? now : null, now, now);
  audit.log(req, 'incluiu_acao', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id });
  return planDone(req, res, autoValid ? 'Ação incluída no plano.' : 'Ação sugerida. O gestor vai complementar e validar.');
});

function getAction(req) {
  return db().prepare('SELECT * FROM action_items WHERE id = ? AND checklist_id = ?').get(Number(req.params.aid), req.bundle.cl.id);
}

router.post('/checklists/:id/plano/:aid', loadChecklist, (req, res) => {
  const item = getAction(req);
  if (!item) return res.status(404).render('error', { title: 'Ação não encontrada', message: 'A ação não existe.' });
  const { access } = req;
  const allowed = item.origin === 'lacuna'
    ? access.canEditGapActions
    : (access.canValidateFree || (access.canProposeFree && item.proposed_by === req.user.id));
  if (!allowed) return auth.forbidden(res, 'Você não pode alterar esta ação agora.');
  const a = cleanAction(req.body);
  if (req.body.due_date && !a.due_date) {
    auth.flash(req, 'error', 'Prazo inválido.');
    return res.redirect(`/checklists/${req.bundle.cl.id}#plano`);
  }
  const status = a.status || item.status;
  db().prepare(`UPDATE action_items SET action = ?, responsible = ?, due_date = ?, status = ?, category = COALESCE(?, category),
                completed_at = ?, updated_at = ? WHERE id = ?`)
    .run(a.action, a.responsible, a.due_date, status, item.origin === 'livre' ? a.category : null,
      status === 'concluida' ? (item.completed_at || nowIso()) : null, nowIso(), item.id);
  audit.log(req, 'alterou_plano', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { acao: item.id, competencia: item.competency_code } });
  return planDone(req, res, 'Plano de ação atualizado.');
});

router.post('/checklists/:id/plano/:aid/status', loadChecklist, (req, res) => {
  const item = getAction(req);
  if (!item) return res.status(404).render('error', { title: 'Ação não encontrada', message: 'A ação não existe.' });
  if (!req.access.canUpdateActionStatus) return auth.forbidden(res, 'Você não pode atualizar o andamento desta ação.');
  const status = ACTION_STATUS[req.body.status] ? req.body.status : item.status;
  db().prepare('UPDATE action_items SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
    .run(status, status === 'concluida' ? (item.completed_at || nowIso()) : null, nowIso(), item.id);
  audit.log(req, 'alterou_plano', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { acao: item.id, status } });
  return planDone(req, res, 'Andamento da ação atualizado.');
});

router.post('/checklists/:id/plano/:aid/validar', loadChecklist, (req, res) => {
  const item = getAction(req);
  if (!item || item.origin !== 'livre') return res.status(404).render('error', { title: 'Ação não encontrada', message: 'A ação não existe.' });
  if (!req.access.canValidateFree) return auth.forbidden(res, 'Somente o gestor valida as ações sugeridas.');
  if (!domain.actionDefined(item)) {
    auth.flash(req, 'error', 'Antes de validar, complete a ação, o responsável e o prazo.');
    return res.redirect(`/checklists/${req.bundle.cl.id}#plano`);
  }
  db().prepare('UPDATE action_items SET validated_by = ?, validated_at = ?, updated_at = ? WHERE id = ?').run(req.user.id, nowIso(), nowIso(), item.id);
  audit.log(req, 'validou_acao', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { acao: item.id } });
  return planDone(req, res, 'Ação validada.');
});

router.post('/checklists/:id/plano/:aid/excluir', loadChecklist, (req, res) => {
  const item = getAction(req);
  if (!item || item.origin !== 'livre') return res.status(404).render('error', { title: 'Ação não encontrada', message: 'Somente ações livres podem ser excluídas.' });
  const allowed = req.access.canValidateFree || (req.access.canProposeFree && item.proposed_by === req.user.id);
  if (!allowed) return auth.forbidden(res, 'Você não pode excluir esta ação.');
  db().prepare('DELETE FROM action_items WHERE id = ?').run(item.id);
  audit.log(req, 'excluiu_acao', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id, details: { acao: item.id } });
  return planDone(req, res, 'Ação excluída.');
});

router.post('/checklists/:id/observacoes', loadChecklist, (req, res) => {
  if (!req.access.canEditNotes) return auth.forbidden(res, 'Somente o gestor registra observações, antes das assinaturas.');
  db().prepare('UPDATE checklists SET manager_notes = ? WHERE id = ?').run(String(req.body.manager_notes || '').trim().slice(0, 4000) || null, req.bundle.cl.id);
  audit.log(req, 'alterou_observacoes', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id });
  return planDone(req, res, 'Observações salvas.');
});

/* ------------------------------------------------------------ assinaturas */

router.post('/checklists/:id/assinar', loadChecklist, (req, res) => {
  const { cl, evals, actions, sigs } = req.bundle;
  const { access } = req;
  const role = String(req.body.role || '');
  const allowedRole = (role === 'colaborador' && access.canSignAsEmployee)
    || (role === 'gestor' && access.canSignAsManager)
    || (role === 'validador' && access.canValidate);
  if (!allowedRole) return auth.forbidden(res, 'Você não pode assinar neste papel.');
  if (sigs[role]) {
    auth.flash(req, 'info', 'Esta assinatura já foi registrada.');
    return res.redirect(`/checklists/${cl.id}#assinaturas`);
  }
  if (role === 'validador') {
    if (!domain.isSubmitted(evals.gestor)) {
      auth.flash(req, 'error', 'A autoverificação ainda não foi enviada.');
      return res.redirect(`/checklists/${cl.id}#validacao`);
    }
  } else if (!domain.canSignNow(cl, evals, actions)) {
    auth.flash(req, 'error', 'Ainda há requisitos pendentes para assinar. Veja a lista na seção Assinaturas.');
    return res.redirect(`/checklists/${cl.id}#assinaturas`);
  }
  if (!req.body.ciente) {
    auth.flash(req, 'error', 'Marque a confirmação de leitura para assinar.');
    return res.redirect(`/checklists/${cl.id}#assinaturas`);
  }
  // Confirmação com a senha (dispensada quando a administradora testa como outra pessoa)
  if (!req.impersonating && !auth.verifyPassword(String(req.body.senha || ''), req.realUser.password_hash)) {
    auth.flash(req, 'error', 'Senha incorreta. A assinatura eletrônica exige a sua senha.');
    return res.redirect(`/checklists/${cl.id}#assinaturas`);
  }
  const comment = String(req.body.comentario || '').trim().slice(0, 2000) || null;
  db().prepare(`INSERT INTO signatures (checklist_id, role, user_id, signer_name, signed_at, comment, ip, impersonated_by)
                VALUES (?,?,?,?,?,?,?,?)`)
    .run(cl.id, role, req.user.id, req.user.name, nowIso(), comment, req.ip, req.impersonating ? req.realUser.id : null);
  if (role === 'colaborador' && comment) db().prepare('UPDATE checklists SET employee_comment = ? WHERE id = ?').run(comment, cl.id);
  const status = domain.refreshStatus(cl.id);
  audit.log(req, role === 'validador' ? 'validou_autoverificacao' : 'assinou', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { papel: role } });
  auth.flash(req, 'success', status === 'assinada' ? 'Assinatura registrada. O checklist está fechado.' : 'Assinatura registrada.');
  return res.redirect(`/checklists/${cl.id}#assinaturas`);
});

router.post('/checklists/:id/retirar-assinatura', loadChecklist, (req, res) => {
  const { cl, sigs } = req.bundle;
  const role = String(req.body.role || '');
  const sig = sigs[role];
  if (!sig || sig.user_id !== req.user.id) return auth.forbidden(res, 'Você só pode retirar a sua própria assinatura.');
  if (cl.status === 'assinada') {
    auth.flash(req, 'error', 'O checklist já está fechado. Para alterar, peça à administradora que reabra.');
    return res.redirect(`/checklists/${cl.id}#assinaturas`);
  }
  db().prepare('DELETE FROM signatures WHERE id = ?').run(sig.id);
  domain.refreshStatus(cl.id);
  audit.log(req, 'retirou_assinatura', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { papel: role } });
  auth.flash(req, 'success', 'Assinatura retirada. O plano de ação pode ser alterado novamente.');
  return res.redirect(`/checklists/${cl.id}#assinaturas`);
});

/* -------------------------------------------------------- administração */

router.post('/checklists/:id/liberar', loadChecklist, async (req, res, next) => {
  try {
    const { cl } = req.bundle;
    if (!req.access.canRelease) return auth.forbidden(res, 'O resultado só pode ser liberado pela administradora, depois das duas avaliações.');
    db().prepare('UPDATE checklists SET results_released_at = ?, results_released_by = ? WHERE id = ?').run(nowIso(), req.user.id, cl.id);
    audit.log(req, 'liberou_resultado', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id });
    await mailer.queue(mailer.templates.resultadoLiberado(domain.getUser(cl.user_id), cl));
    auth.flash(req, 'success', `Resultado liberado para ${cl.user_name}.`);
    return res.redirect(req.body.voltar === 'acompanhamento' ? '/acompanhamento' : `/checklists/${cl.id}`);
  } catch (err) { return next(err); }
});

router.post('/checklists/:id/reabrir', loadChecklist, (req, res) => {
  const { cl } = req.bundle;
  if (!req.access.canReopen) return auth.forbidden(res, 'Somente a administradora reabre avaliações.');
  const kind = req.body.kind === 'auto' ? 'auto' : 'gestor';
  const reason = String(req.body.motivo || '').trim();
  const ev = req.bundle.evals[kind];
  if (!ev || ev.status !== 'enviada') {
    auth.flash(req, 'error', 'Esta avaliação não está enviada.');
    return res.redirect(`/checklists/${cl.id}`);
  }
  if (!reason) {
    auth.flash(req, 'error', 'Informe o motivo da reabertura.');
    return res.redirect(`/checklists/${cl.id}#admin`);
  }
  const tx = db().transaction(() => {
    db().prepare(`UPDATE evaluations SET status = 'rascunho', submitted_at = NULL, reopened_at = ?, reopened_by = ?, reopen_reason = ?
                  WHERE id = ?`).run(nowIso(), req.realUser.id, reason.slice(0, 1000), ev.id);
    db().prepare('DELETE FROM signatures WHERE checklist_id = ?').run(cl.id);
    db().prepare('UPDATE checklists SET results_released_at = NULL, results_released_by = NULL, closed_at = NULL WHERE id = ?').run(cl.id);
  });
  tx();
  domain.refreshStatus(cl.id);
  audit.log(req, 'reabriu_avaliacao', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { tipo: kind, motivo: reason } });
  auth.flash(req, 'success', `${evalTitle(cl, kind)} reaberta. As assinaturas foram removidas e o resultado voltou a ficar oculto até nova liberação.`);
  return res.redirect(`/checklists/${cl.id}`);
});

router.post('/checklists/:id/validador', loadChecklist, async (req, res, next) => {
  try {
    const { cl } = req.bundle;
    if (!req.access.canSetValidator) return auth.forbidden(res, 'Somente a administradora escolhe o validador.');
    const vid = Number(req.body.validator_user_id) || null;
    const validator = vid ? domain.getUser(vid) : null;
    if (vid && (!validator || !validator.active || validator.id === cl.user_id)) {
      auth.flash(req, 'error', 'Escolha uma pessoa diferente do titular do checklist.');
      return res.redirect(`/checklists/${cl.id}#validacao`);
    }
    if (req.bundle.sigs.validador) {
      auth.flash(req, 'error', 'A validação já foi registrada. Para trocar o validador, reabra a autoverificação.');
      return res.redirect(`/checklists/${cl.id}#validacao`);
    }
    db().prepare('UPDATE checklists SET validator_user_id = ? WHERE id = ?').run(vid, cl.id);
    audit.log(req, 'definiu_validador', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { validador: validator ? validator.name : null } });
    if (validator) await mailer.queue(mailer.templates.validador(validator, cl));
    auth.flash(req, 'success', validator ? `${validator.name} foi definido(a) como validador(a).` : 'Validador removido.');
    return res.redirect(`/checklists/${cl.id}#validacao`);
  } catch (err) { return next(err); }
});

router.post('/checklists/:id/ata', loadChecklist, (req, res, next) => {
  if (!req.access.canUploadAta || !req.bundle.cl.self_verification) return auth.forbidden(res, 'Você não pode anexar a ata neste checklist.');
  return upload.single('arquivo')(req, res, next);
}, (req, res) => {
  if (!req.sessionRow || req.body._csrf !== req.sessionRow.csrf) {
    removeUploaded(req);
    return auth.forbidden(res, 'Sessão expirada. Recarregue a página.');
  }
  if (!req.file) {
    auth.flash(req, 'error', 'Selecione o arquivo da ata.');
    return res.redirect(`/checklists/${req.bundle.cl.id}#validacao`);
  }
  const { cl } = req.bundle;
  db().prepare(`INSERT INTO attachments (checklist_id, kind, original_name, stored_name, mime, size, uploaded_by, uploaded_at)
                VALUES (?, 'ata', ?, ?, ?, ?, ?, ?)`)
    .run(cl.id, req.file.originalname.slice(0, 200), req.file.filename, req.file.mimetype, req.file.size, req.user.id, nowIso());
  domain.refreshStatus(cl.id);
  audit.log(req, 'anexou_ata', { entity: 'checklist', entityId: cl.id, subjectUserId: cl.user_id, details: { arquivo: req.file.originalname } });
  auth.flash(req, 'success', 'Ata da Diretoria anexada ao registro.');
  return res.redirect(`/checklists/${cl.id}#validacao`);
});

/* -------------------------------------------------------------------- PDF */

router.get('/checklists/:id/pdf', loadChecklist, async (req, res, next) => {
  try {
    const pdf = require('../lib/pdf');
    const buf = await pdf.checklistPdf(req.bundle, req.access);
    audit.log(req, 'baixou_pdf_checklist', { entity: 'checklist', entityId: req.bundle.cl.id, subjectUserId: req.bundle.cl.user_id });
    const name = `checklist-${req.bundle.cycle.year}-${req.bundle.cl.cargo_code}-${req.bundle.cl.user_name}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9-]+/g, '-');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${name}.pdf"`);
    res.send(buf);
  } catch (err) { next(err); }
});

module.exports = router;
