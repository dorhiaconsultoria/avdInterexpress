'use strict';
// Regras de negócio: ciclos, checklists, avaliações, lacunas, plano de ação e assinaturas.
const dbm = require('../db');
const { nowIso } = require('./util');

const db = () => dbm.get();

/* ------------------------------------------------------------------ ciclos */

function getCycle(id) {
  return db().prepare('SELECT * FROM cycles WHERE id = ?').get(id);
}

function listCycles() {
  return db().prepare('SELECT * FROM cycles ORDER BY year DESC, id DESC').all();
}

/** Ciclo "atual": o mais recente não encerrado; se não houver, o mais recente. */
function currentCycle() {
  return db().prepare("SELECT * FROM cycles WHERE status != 'encerrado' ORDER BY year DESC, id DESC LIMIT 1").get()
    || db().prepare('SELECT * FROM cycles ORDER BY year DESC, id DESC LIMIT 1').get();
}

function previousCycle(cycle) {
  return db().prepare('SELECT * FROM cycles WHERE (year < ? OR (year = ? AND id < ?)) ORDER BY year DESC, id DESC LIMIT 1')
    .get(cycle.year, cycle.year, cycle.id);
}

/** A matriz fica travada enquanto existir ciclo em andamento. */
function matrixLocked() {
  return !!db().prepare("SELECT 1 FROM cycles WHERE status = 'em_andamento'").get();
}

/* ------------------------------------------------------------------ matriz */

function vigenteVersion() {
  return db().prepare("SELECT * FROM matrix_versions WHERE status = 'vigente' ORDER BY number DESC LIMIT 1").get();
}

function draftVersion() {
  return db().prepare("SELECT * FROM matrix_versions WHERE status = 'rascunho' LIMIT 1").get();
}

function getVersion(id) {
  return db().prepare('SELECT * FROM matrix_versions WHERE id = ?').get(id);
}

function listVersions() {
  return db().prepare("SELECT v.*, u.name AS created_by_name FROM matrix_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.status != 'rascunho' ORDER BY v.number DESC").all();
}

function competenciesOf(versionId) {
  return db().prepare('SELECT * FROM competencies WHERE version_id = ? ORDER BY sort, code').all(versionId);
}

/** { cargoId: { C01: 3, C10: null, ... } } */
function levelsOf(versionId) {
  const out = {};
  for (const r of db().prepare('SELECT * FROM matrix_levels WHERE version_id = ?').all(versionId)) {
    (out[r.cargo_id] = out[r.cargo_id] || {})[r.competency_code] = r.required_level;
  }
  return out;
}

/** Versão da matriz usada por um ciclo (a vigente enquanto o ciclo está em planejamento). */
function cycleVersionId(cycle) {
  if (cycle && cycle.matrix_version_id) return cycle.matrix_version_id;
  const v = vigenteVersion();
  return v ? v.id : null;
}

/* ------------------------------------------------------------ hierarquia */

function listCargos() {
  return db().prepare('SELECT * FROM cargos ORDER BY sort, code').all();
}

function listVinculos({ activeOnly = true } = {}) {
  return db().prepare(`
    SELECT v.*, u.name AS user_name, u.email AS user_email, u.active AS user_active,
           c.code AS cargo_code, c.title AS cargo_title, c.short_title AS cargo_short, c.area AS area,
           c.is_leadership AS is_leadership, c.sort AS cargo_sort,
           mv.user_id AS manager_user_id, mu.name AS manager_name, mc.short_title AS manager_cargo_short,
           mc.code AS manager_cargo_code
      FROM vinculos v
      JOIN users u ON u.id = v.user_id
      JOIN cargos c ON c.id = v.cargo_id
      LEFT JOIN vinculos mv ON mv.id = v.manager_vinculo_id
      LEFT JOIN users mu ON mu.id = mv.user_id
      LEFT JOIN cargos mc ON mc.id = mv.cargo_id
     ${activeOnly ? 'WHERE v.active = 1 AND u.active = 1' : ''}
     ORDER BY c.sort, c.code, u.name`).all();
}

function evaluatorFor(vinculo) {
  const mgr = vinculo.manager_vinculo_id
    ? db().prepare('SELECT * FROM vinculos WHERE id = ?').get(vinculo.manager_vinculo_id)
    : null;
  if (!mgr || mgr.user_id === vinculo.user_id) {
    // Autoverificação (ex.: CEO, ou cargo cujo superior é a própria pessoa)
    return { evaluator_user_id: vinculo.user_id, evaluator_vinculo_id: mgr ? mgr.id : null, self_verification: 1 };
  }
  return { evaluator_user_id: mgr.user_id, evaluator_vinculo_id: mgr.id, self_verification: 0 };
}

/**
 * Garante um checklist por vínculo ativo no ciclo. Atualiza o avaliador enquanto a avaliação
 * do gestor não começou e remove checklists de vínculos inativos que ainda não têm dados.
 */
function syncChecklists(cycleId) {
  const cycle = getCycle(cycleId);
  if (!cycle || cycle.status === 'encerrado') return;
  const d = db();
  const vincs = d.prepare(`SELECT v.* FROM vinculos v JOIN users u ON u.id = v.user_id
                            WHERE v.active = 1 AND u.active = 1`).all();
  const tx = d.transaction(() => {
    const activeIds = new Set();
    for (const v of vincs) {
      activeIds.add(v.id);
      const ev = evaluatorFor(v);
      const existing = d.prepare('SELECT * FROM checklists WHERE cycle_id = ? AND vinculo_id = ?').get(cycleId, v.id);
      if (!existing) {
        d.prepare(`INSERT INTO checklists (cycle_id, vinculo_id, user_id, cargo_id, evaluator_user_id, evaluator_vinculo_id,
                    self_verification, status, created_at) VALUES (?,?,?,?,?,?,?, 'nao_iniciada', ?)`)
          .run(cycleId, v.id, v.user_id, v.cargo_id, ev.evaluator_user_id, ev.evaluator_vinculo_id, ev.self_verification, nowIso());
      } else {
        const gestorEval = d.prepare("SELECT 1 FROM evaluations WHERE checklist_id = ? AND kind = 'gestor'").get(existing.id);
        if (!gestorEval && (existing.evaluator_user_id !== ev.evaluator_user_id
            || existing.self_verification !== ev.self_verification
            || existing.evaluator_vinculo_id !== ev.evaluator_vinculo_id)) {
          d.prepare('UPDATE checklists SET evaluator_user_id = ?, evaluator_vinculo_id = ?, self_verification = ? WHERE id = ?')
            .run(ev.evaluator_user_id, ev.evaluator_vinculo_id, ev.self_verification, existing.id);
        }
        if (existing.cargo_id !== v.cargo_id) {
          d.prepare('UPDATE checklists SET cargo_id = ? WHERE id = ?').run(v.cargo_id, existing.id);
        }
      }
    }
    for (const cl of d.prepare('SELECT * FROM checklists WHERE cycle_id = ?').all(cycleId)) {
      if (activeIds.has(cl.vinculo_id)) continue;
      const hasData = d.prepare('SELECT 1 FROM evaluations WHERE checklist_id = ?').get(cl.id);
      if (!hasData) d.prepare('DELETE FROM checklists WHERE id = ?').run(cl.id);
    }
  });
  tx();
}

/* -------------------------------------------------------------- checklist */

const CHECKLIST_SELECT = `
  SELECT cl.*, u.name AS user_name, u.email AS user_email,
         c.code AS cargo_code, c.title AS cargo_title, c.short_title AS cargo_short, c.area AS area,
         c.is_leadership AS is_leadership,
         eu.name AS evaluator_name, ec.short_title AS evaluator_cargo_short, ec.code AS evaluator_cargo_code,
         vu.name AS validator_name,
         cy.name AS cycle_name, cy.status AS cycle_status, cy.year AS cycle_year
    FROM checklists cl
    JOIN users u ON u.id = cl.user_id
    JOIN cargos c ON c.id = cl.cargo_id
    JOIN cycles cy ON cy.id = cl.cycle_id
    LEFT JOIN users eu ON eu.id = cl.evaluator_user_id
    LEFT JOIN vinculos ev ON ev.id = cl.evaluator_vinculo_id
    LEFT JOIN cargos ec ON ec.id = ev.cargo_id
    LEFT JOIN users vu ON vu.id = cl.validator_user_id`;

function getChecklist(id) {
  return db().prepare(`${CHECKLIST_SELECT} WHERE cl.id = ?`).get(id);
}

function listChecklists(cycleId, where = '', params = []) {
  return db().prepare(`${CHECKLIST_SELECT} WHERE cl.cycle_id = ? ${where} ORDER BY c.sort, c.code, u.name`)
    .all(cycleId, ...params);
}

/** Rótulo do avaliador para exibição: "José (Coord. de Faturamento)" ou autoverificação. */
function evaluatorLabel(cl) {
  if (cl.self_verification) return 'Autoverificação, validada por terceiro';
  return cl.evaluator_cargo_short ? `${cl.evaluator_name} (${cl.evaluator_cargo_short})` : (cl.evaluator_name || '—');
}

/** Competências aplicáveis ao cargo do checklist (com nível exigido) e as que não se aplicam. */
function checklistCompetencies(cl) {
  const cycle = getCycle(cl.cycle_id);
  const versionId = cycleVersionId(cycle);
  const comps = versionId ? competenciesOf(versionId) : [];
  const levels = versionId ? (levelsOf(versionId)[cl.cargo_id] || {}) : {};
  const applicable = [];
  const notApplicable = [];
  for (const c of comps) {
    const req = levels[c.code];
    if (req == null) notApplicable.push(c);
    else applicable.push({ ...c, required: req });
  }
  return { applicable, notApplicable, versionId, version: versionId ? getVersion(versionId) : null };
}

function getEvaluation(checklistId, kind) {
  const ev = db().prepare('SELECT e.*, u.name AS evaluator_name FROM evaluations e JOIN users u ON u.id = e.evaluator_user_id WHERE checklist_id = ? AND kind = ?')
    .get(checklistId, kind);
  if (!ev) return null;
  ev.items = {};
  for (const it of db().prepare('SELECT * FROM evaluation_items WHERE evaluation_id = ?').all(ev.id)) {
    ev.items[it.competency_code] = it;
  }
  return ev;
}

function getEvaluations(checklistId) {
  return { auto: getEvaluation(checklistId, 'auto'), gestor: getEvaluation(checklistId, 'gestor') };
}

function attachmentsOf(checklistId) {
  return db().prepare(`SELECT a.*, u.name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
                        WHERE a.checklist_id = ? ORDER BY a.uploaded_at`).all(checklistId);
}

function signaturesOf(checklistId) {
  const out = {};
  for (const s of db().prepare('SELECT * FROM signatures WHERE checklist_id = ?').all(checklistId)) out[s.role] = s;
  return out;
}

function actionsOf(checklistId, { includeObsolete = false } = {}) {
  return db().prepare(`SELECT a.*, pu.name AS proposed_by_name, vu.name AS validated_by_name
                         FROM action_items a
                         LEFT JOIN users pu ON pu.id = a.proposed_by
                         LEFT JOIN users vu ON vu.id = a.validated_by
                        WHERE a.checklist_id = ? ${includeObsolete ? '' : 'AND a.obsolete = 0'}
                        ORDER BY CASE a.origin WHEN 'lacuna' THEN 0 ELSE 1 END, a.competency_code, a.id`).all(checklistId);
}

function isSubmitted(ev) {
  return !!ev && ev.status === 'enviada';
}

/** Avaliação "oficial" (nível verificado): a do gestor ou a autoverificação. */
function verificationOf(cl, evals) {
  return evals.gestor;
}

/** Lacunas: nível verificado menor que o exigido. */
function computeGaps(applicable, verification) {
  if (!isSubmitted(verification)) return [];
  const gaps = [];
  for (const c of applicable) {
    const it = verification.items[c.code];
    if (it && it.rating != null && it.rating < c.required) {
      gaps.push({ code: c.code, name: c.name, required: c.required, verified: it.rating, diff: it.rating - c.required });
    }
  }
  return gaps;
}

/** Abre automaticamente uma linha de plano de ação para cada lacuna. */
function syncGapActions(checklistId) {
  const cl = getChecklist(checklistId);
  const { applicable } = checklistCompetencies(cl);
  const evals = getEvaluations(checklistId);
  const gaps = computeGaps(applicable, verificationOf(cl, evals));
  const d = db();
  const now = nowIso();
  const existing = d.prepare("SELECT * FROM action_items WHERE checklist_id = ? AND origin = 'lacuna'").all(checklistId);
  const byCode = Object.fromEntries(existing.map((a) => [a.competency_code, a]));
  const gapCodes = new Set(gaps.map((g) => g.code));
  for (const g of gaps) {
    const ex = byCode[g.code];
    if (!ex) {
      d.prepare(`INSERT INTO action_items (checklist_id, origin, competency_code, required_level, verified_level, status, created_at, updated_at)
                 VALUES (?, 'lacuna', ?, ?, ?, 'nao_iniciada', ?, ?)`).run(checklistId, g.code, g.required, g.verified, now, now);
    } else {
      d.prepare('UPDATE action_items SET required_level = ?, verified_level = ?, obsolete = 0, updated_at = ? WHERE id = ?')
        .run(g.required, g.verified, now, ex.id);
    }
  }
  for (const ex of existing) {
    if (gapCodes.has(ex.competency_code)) continue;
    if (!ex.action && !ex.responsible && !ex.due_date) d.prepare('DELETE FROM action_items WHERE id = ?').run(ex.id);
    else d.prepare('UPDATE action_items SET obsolete = 1, updated_at = ? WHERE id = ?').run(now, ex.id);
  }
}

function actionDefined(a) {
  return !!(a.action && a.action.trim() && a.responsible && a.responsible.trim() && a.due_date);
}

/** Situação do plano de ação de um checklist. */
function planSummary(checklistId, actions = actionsOf(checklistId)) {
  const gaps = actions.filter((a) => a.origin === 'lacuna');
  const free = actions.filter((a) => a.origin === 'livre');
  const gapsDefined = gaps.filter(actionDefined).length;
  const freePending = free.filter((a) => !a.validated_by).length;
  const freeIncomplete = free.filter((a) => !actionDefined(a)).length;
  const all = gaps.concat(free);
  return {
    gaps: gaps.length,
    gapsDefined,
    gapsDone: gaps.filter((a) => a.status === 'concluida').length,
    free: free.length,
    freePending,
    freeIncomplete,
    total: all.length,
    done: all.filter((a) => a.status === 'concluida').length,
    complete: gapsDefined === gaps.length,
  };
}

function hasAta(checklistId) {
  return !!db().prepare("SELECT 1 FROM attachments WHERE checklist_id = ? AND kind = 'ata'").get(checklistId);
}

/** Requisitos para assinar/fechar o checklist. Retorna lista de { ok, text }. */
function signatureRequirements(cl, evals = getEvaluations(cl.id), actions = actionsOf(cl.id)) {
  const reqs = [];
  const plan = planSummary(cl.id, actions);
  if (cl.self_verification) {
    reqs.push({ ok: isSubmitted(evals.gestor), text: 'Autoverificação enviada' });
  } else {
    reqs.push({ ok: isSubmitted(evals.auto), text: 'Autoavaliação enviada pelo colaborador' });
    reqs.push({ ok: isSubmitted(evals.gestor), text: 'Avaliação do gestor enviada' });
    reqs.push({ ok: !!cl.results_released_at, text: 'Resultado liberado pelo RH' });
  }
  reqs.push({ ok: plan.complete, text: `Todas as lacunas com ação, responsável e prazo (${plan.gapsDefined} de ${plan.gaps})` });
  if (plan.free) {
    reqs.push({ ok: plan.freeIncomplete === 0, text: 'Ações de desenvolvimento livres com ação, responsável e prazo' });
    if (!cl.self_verification) reqs.push({ ok: plan.freePending === 0, text: 'Ações livres sugeridas validadas pelo gestor' });
  }
  return reqs;
}

function canSignNow(cl, evals, actions) {
  return signatureRequirements(cl, evals, actions).every((r) => r.ok);
}

/** Recalcula o status do checklist: Não iniciada, Em andamento, Concluída, Assinada. */
function refreshStatus(checklistId) {
  const d = db();
  const cl = d.prepare('SELECT * FROM checklists WHERE id = ?').get(checklistId);
  if (!cl) return null;
  const evals = d.prepare('SELECT kind, status FROM evaluations WHERE checklist_id = ?').all(checklistId);
  const ev = Object.fromEntries(evals.map((e) => [e.kind, e.status]));
  const sigs = signaturesOf(checklistId);
  let concluded;
  let signed;
  if (cl.self_verification) {
    concluded = ev.gestor === 'enviada';
    signed = concluded && !!sigs.colaborador && (!!sigs.validador || hasAta(checklistId));
  } else {
    concluded = ev.auto === 'enviada' && ev.gestor === 'enviada';
    signed = concluded && !!sigs.colaborador && !!sigs.gestor;
  }
  let status = 'nao_iniciada';
  if (signed) status = 'assinada';
  else if (concluded) status = 'concluida';
  else if (evals.length || Object.keys(sigs).length) status = 'em_andamento';

  let closedAt = null;
  if (signed) {
    const times = Object.values(sigs).map((s) => s.signed_at);
    const ata = d.prepare("SELECT MAX(uploaded_at) AS t FROM attachments WHERE checklist_id = ? AND kind = 'ata'").get(checklistId);
    if (cl.self_verification && !sigs.validador && ata && ata.t) times.push(ata.t);
    closedAt = cl.closed_at || times.sort().pop() || nowIso();
  }
  d.prepare('UPDATE checklists SET status = ?, closed_at = ? WHERE id = ?').run(status, closedAt, checklistId);

  // Liberação automática do resultado (se configurada no ciclo)
  if (concluded && !cl.self_verification && !cl.results_released_at) {
    const cycle = getCycle(cl.cycle_id);
    if (cycle && cycle.auto_release) {
      d.prepare('UPDATE checklists SET results_released_at = ? WHERE id = ?').run(nowIso(), checklistId);
    }
  }
  return status;
}

/** Etapa e próximo passo do checklist (para os painéis). */
function stageOf(cl, evals, sigs, plan) {
  if (cl.status === 'assinada') return { key: 'assinada', text: 'Checklist assinado e fechado' };
  if (cl.self_verification) {
    if (!isSubmitted(evals.gestor)) return { key: 'gestor', text: 'Autoverificação pendente' };
    if (!plan.complete) return { key: 'plano', text: 'Plano de ação incompleto' };
    if (!sigs.colaborador) return { key: 'assinatura', text: 'Aguardando assinatura do titular' };
    return { key: 'validacao', text: 'Aguardando validação por terceiro ou ata da Diretoria' };
  }
  if (!isSubmitted(evals.auto) && !isSubmitted(evals.gestor)) return { key: 'avaliacoes', text: 'Autoavaliação e avaliação do gestor pendentes' };
  if (!isSubmitted(evals.auto)) return { key: 'auto', text: 'Autoavaliação pendente' };
  if (!isSubmitted(evals.gestor)) return { key: 'gestor', text: 'Avaliação do gestor pendente' };
  if (!cl.results_released_at) return { key: 'liberacao', text: 'Aguardando liberação do resultado pelo RH' };
  if (!plan.complete) return { key: 'plano', text: 'Plano de ação incompleto' };
  if (plan.freePending) return { key: 'plano', text: 'Ações livres aguardando validação do gestor' };
  const faltam = [];
  if (!sigs.colaborador) faltam.push('colaborador');
  if (!sigs.gestor) faltam.push('gestor');
  return { key: 'assinatura', text: `Aguardando assinatura: ${faltam.join(' e ')}` };
}

/** Pacote completo para exibição de um checklist. */
function loadChecklistBundle(id) {
  const cl = getChecklist(id);
  if (!cl) return null;
  const comps = checklistCompetencies(cl);
  const evals = getEvaluations(id);
  const actions = actionsOf(id);
  const sigs = signaturesOf(id);
  const plan = planSummary(id, actions);
  const attachments = attachmentsOf(id);
  const cycle = getCycle(cl.cycle_id);
  const gaps = computeGaps(comps.applicable, verificationOf(cl, evals));
  return {
    cl, cycle, comps, evals, actions, sigs, plan, attachments, gaps,
    stage: stageOf(cl, evals, sigs, plan),
    requirements: signatureRequirements(cl, evals, actions),
    ata: attachments.filter((a) => a.kind === 'ata'),
  };
}

/** Progresso de preenchimento de uma avaliação (nota + evidência). */
function evaluationProgress(applicable, ev) {
  const total = applicable.length;
  if (!ev) return { done: 0, total, pct: 0 };
  let done = 0;
  for (const c of applicable) {
    const it = ev.items[c.code];
    if (it && it.rating && it.evidence && it.evidence.trim().length >= 1) done += 1;
  }
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/* ------------------------------------------------------------ pessoas */

function getUser(id) {
  return db().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function listUsers({ activeOnly = false } = {}) {
  return db().prepare(`SELECT * FROM users ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY name`).all();
}

/** Pessoas que avaliam alguém (gestores) no ciclo. */
function managersInCycle(cycleId) {
  return db().prepare(`SELECT DISTINCT u.id, u.name FROM checklists cl JOIN users u ON u.id = cl.evaluator_user_id
                        WHERE cl.cycle_id = ? AND cl.self_verification = 0 ORDER BY u.name`).all(cycleId);
}

function isManager(userId, cycleId) {
  if (!cycleId) return false;
  return !!db().prepare('SELECT 1 FROM checklists WHERE cycle_id = ? AND evaluator_user_id = ? AND self_verification = 0').get(cycleId, userId);
}

function isValidatorOf(userId, cycleId) {
  if (!cycleId) return false;
  return !!db().prepare('SELECT 1 FROM checklists WHERE cycle_id = ? AND validator_user_id = ?').get(cycleId, userId);
}

module.exports = {
  getCycle, listCycles, currentCycle, previousCycle, matrixLocked,
  vigenteVersion, draftVersion, getVersion, listVersions, competenciesOf, levelsOf, cycleVersionId,
  listCargos, listVinculos, evaluatorFor, syncChecklists,
  getChecklist, listChecklists, evaluatorLabel, checklistCompetencies, getEvaluation, getEvaluations,
  attachmentsOf, signaturesOf, actionsOf, isSubmitted, verificationOf, computeGaps, syncGapActions,
  actionDefined, planSummary, hasAta, signatureRequirements, canSignNow, refreshStatus, stageOf,
  loadChecklistBundle, evaluationProgress,
  getUser, listUsers, managersInCycle, isManager, isValidatorOf,
};
