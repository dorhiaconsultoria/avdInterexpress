'use strict';
// Regras de negócio: ciclos, checklists, avaliações, lacunas, plano de ação e assinaturas.
const dbm = require('../db');
const { nowIso } = require('./util');


/* ------------------------------------------------------------------ ciclos */

async function getCycle(id) {
  return await dbm.get('SELECT * FROM cycles WHERE id = ?', id);
}

async function listCycles() {
  return await dbm.all('SELECT * FROM cycles ORDER BY year DESC, id DESC');
}

/** Ciclo "atual": o mais recente não encerrado; se não houver, o mais recente. */
async function currentCycle() {
  return await dbm.get("SELECT * FROM cycles WHERE status != 'encerrado' ORDER BY year DESC, id DESC LIMIT 1")
    || await dbm.get('SELECT * FROM cycles ORDER BY year DESC, id DESC LIMIT 1');
}

async function previousCycle(cycle) {
  return await dbm.get('SELECT * FROM cycles WHERE (year < ? OR (year = ? AND id < ?)) ORDER BY year DESC, id DESC LIMIT 1', cycle.year, cycle.year, cycle.id);
}

/** A matriz fica travada enquanto existir ciclo em andamento. */
async function matrixLocked() {
  return !!await dbm.get("SELECT 1 FROM cycles WHERE status = 'em_andamento'");
}

/* ------------------------------------------------------------------ matriz */

async function vigenteVersion() {
  return await dbm.get("SELECT * FROM matrix_versions WHERE status = 'vigente' ORDER BY number DESC LIMIT 1");
}

async function draftVersion() {
  return await dbm.get("SELECT * FROM matrix_versions WHERE status = 'rascunho' LIMIT 1");
}

async function getVersion(id) {
  return await dbm.get('SELECT * FROM matrix_versions WHERE id = ?', id);
}

async function listVersions() {
  return await dbm.all("SELECT v.*, u.name AS created_by_name FROM matrix_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.status != 'rascunho' ORDER BY v.number DESC");
}

async function competenciesOf(versionId) {
  return await dbm.all('SELECT * FROM competencies WHERE version_id = ? ORDER BY sort, code', versionId);
}

/** { cargoId: { C01: 3, C10: null, ... } } */
async function levelsOf(versionId) {
  const out = {};
  for (const r of await dbm.all('SELECT * FROM matrix_levels WHERE version_id = ?', versionId)) {
    (out[r.cargo_id] = out[r.cargo_id] || {})[r.competency_code] = r.required_level;
  }
  return out;
}

/** Versão da matriz usada por um ciclo (a vigente enquanto o ciclo está em planejamento). */
async function cycleVersionId(cycle) {
  if (cycle && cycle.matrix_version_id) return cycle.matrix_version_id;
  const v = await vigenteVersion();
  return v ? v.id : null;
}

/* ------------------------------------------------------------ hierarquia */

async function listCargos() {
  return await dbm.all('SELECT * FROM cargos ORDER BY sort, code');
}

async function listVinculos({ activeOnly = true } = {}) {
  return await dbm.all(`
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
     ORDER BY c.sort, c.code, u.name`);
}

async function evaluatorFor(vinculo) {
  const mgr = vinculo.manager_vinculo_id
    ? await dbm.get('SELECT * FROM vinculos WHERE id = ?', vinculo.manager_vinculo_id)
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
async function syncChecklists(cycleId) {
  const cycle = await getCycle(cycleId);
  if (!cycle || cycle.status === 'encerrado') return;
  const vincs = await dbm.all(`SELECT v.* FROM vinculos v JOIN users u ON u.id = v.user_id
                            WHERE v.active = 1 AND u.active = 1`);
  await dbm.tx(async () => {
    const activeIds = new Set();
    for (const v of vincs) {
      activeIds.add(v.id);
      const ev = await evaluatorFor(v);
      const existing = await dbm.get('SELECT * FROM checklists WHERE cycle_id = ? AND vinculo_id = ?', cycleId, v.id);
      if (!existing) {
        await dbm.run(`INSERT INTO checklists (cycle_id, vinculo_id, user_id, cargo_id, evaluator_user_id, evaluator_vinculo_id,
                    self_verification, status, created_at) VALUES (?,?,?,?,?,?,?, 'nao_iniciada', ?)`, cycleId, v.id, v.user_id, v.cargo_id, ev.evaluator_user_id, ev.evaluator_vinculo_id, ev.self_verification, nowIso());
      } else {
        const gestorEval = await dbm.get("SELECT 1 FROM evaluations WHERE checklist_id = ? AND kind = 'gestor'", existing.id);
        if (!gestorEval && (existing.evaluator_user_id !== ev.evaluator_user_id
            || existing.self_verification !== ev.self_verification
            || existing.evaluator_vinculo_id !== ev.evaluator_vinculo_id)) {
          await dbm.run('UPDATE checklists SET evaluator_user_id = ?, evaluator_vinculo_id = ?, self_verification = ? WHERE id = ?', ev.evaluator_user_id, ev.evaluator_vinculo_id, ev.self_verification, existing.id);
        }
        if (existing.cargo_id !== v.cargo_id) {
          await dbm.run('UPDATE checklists SET cargo_id = ? WHERE id = ?', v.cargo_id, existing.id);
        }
      }
    }
    for (const cl of await dbm.all('SELECT * FROM checklists WHERE cycle_id = ?', cycleId)) {
      if (activeIds.has(cl.vinculo_id)) continue;
      const hasData = await dbm.get('SELECT 1 FROM evaluations WHERE checklist_id = ?', cl.id);
      if (!hasData) await dbm.run('DELETE FROM checklists WHERE id = ?', cl.id);
    }
  });
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

async function getChecklist(id) {
  return await dbm.get(`${CHECKLIST_SELECT} WHERE cl.id = ?`, id);
}

async function listChecklists(cycleId, where = '', params = []) {
  return await dbm.all(`${CHECKLIST_SELECT} WHERE cl.cycle_id = ? ${where} ORDER BY c.sort, c.code, u.name`, cycleId, ...params);
}

/** Rótulo do avaliador para exibição: "José (Coord. de Faturamento)" ou autoverificação. */
function evaluatorLabel(cl) {
  if (cl.self_verification) return 'Autoverificação, validada por terceiro';
  return cl.evaluator_cargo_short ? `${cl.evaluator_name} (${cl.evaluator_cargo_short})` : (cl.evaluator_name || '—');
}

/** Competências aplicáveis ao cargo do checklist (com nível exigido) e as que não se aplicam. */
async function checklistCompetencies(cl) {
  const cycle = await getCycle(cl.cycle_id);
  const versionId = await cycleVersionId(cycle);
  const comps = versionId ? await competenciesOf(versionId) : [];
  const levels = versionId ? ((await levelsOf(versionId))[cl.cargo_id] || {}) : {};
  const applicable = [];
  const notApplicable = [];
  for (const c of comps) {
    const req = levels[c.code];
    if (req == null) notApplicable.push(c);
    else applicable.push({ ...c, required: req });
  }
  return { applicable, notApplicable, versionId, version: versionId ? await getVersion(versionId) : null };
}

async function getEvaluation(checklistId, kind) {
  const ev = await dbm.get('SELECT e.*, u.name AS evaluator_name FROM evaluations e JOIN users u ON u.id = e.evaluator_user_id WHERE checklist_id = ? AND kind = ?', checklistId, kind);
  if (!ev) return null;
  ev.items = {};
  for (const it of await dbm.all('SELECT * FROM evaluation_items WHERE evaluation_id = ?', ev.id)) {
    ev.items[it.competency_code] = it;
  }
  return ev;
}

async function getEvaluations(checklistId) {
  return { auto: await getEvaluation(checklistId, 'auto'), gestor: await getEvaluation(checklistId, 'gestor') };
}

async function attachmentsOf(checklistId) {
  return await dbm.all(`SELECT a.id, a.checklist_id, a.evaluation_id, a.competency_code, a.kind, a.original_name, a.mime, a.size,
                               a.uploaded_by, a.uploaded_at, u.name AS uploaded_by_name
                          FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
                        WHERE a.checklist_id = ? ORDER BY a.uploaded_at`, checklistId);
}

async function signaturesOf(checklistId) {
  const out = {};
  for (const s of await dbm.all('SELECT * FROM signatures WHERE checklist_id = ?', checklistId)) out[s.role] = s;
  return out;
}

async function actionsOf(checklistId, { includeObsolete = false } = {}) {
  return await dbm.all(`SELECT a.*, pu.name AS proposed_by_name, vu.name AS validated_by_name
                         FROM action_items a
                         LEFT JOIN users pu ON pu.id = a.proposed_by
                         LEFT JOIN users vu ON vu.id = a.validated_by
                        WHERE a.checklist_id = ? ${includeObsolete ? '' : 'AND a.obsolete = 0'}
                        ORDER BY CASE a.origin WHEN 'lacuna' THEN 0 ELSE 1 END, a.competency_code, a.id`, checklistId);
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
async function syncGapActions(checklistId) {
  const cl = await getChecklist(checklistId);
  const { applicable } = await checklistCompetencies(cl);
  const evals = await getEvaluations(checklistId);
  const gaps = computeGaps(applicable, verificationOf(cl, evals));
  const now = nowIso();
  const existing = await dbm.all("SELECT * FROM action_items WHERE checklist_id = ? AND origin = 'lacuna'", checklistId);
  const byCode = Object.fromEntries(existing.map((a) => [a.competency_code, a]));
  const gapCodes = new Set(gaps.map((g) => g.code));
  for (const g of gaps) {
    const ex = byCode[g.code];
    if (!ex) {
      await dbm.run(`INSERT INTO action_items (checklist_id, origin, competency_code, required_level, verified_level, status, created_at, updated_at)
                 VALUES (?, 'lacuna', ?, ?, ?, 'nao_iniciada', ?, ?)`, checklistId, g.code, g.required, g.verified, now, now);
    } else {
      await dbm.run('UPDATE action_items SET required_level = ?, verified_level = ?, obsolete = 0, updated_at = ? WHERE id = ?', g.required, g.verified, now, ex.id);
    }
  }
  for (const ex of existing) {
    if (gapCodes.has(ex.competency_code)) continue;
    if (!ex.action && !ex.responsible && !ex.due_date) await dbm.run('DELETE FROM action_items WHERE id = ?', ex.id);
    else await dbm.run('UPDATE action_items SET obsolete = 1, updated_at = ? WHERE id = ?', now, ex.id);
  }
}

function actionDefined(a) {
  return !!(a.action && a.action.trim() && a.responsible && a.responsible.trim() && a.due_date);
}

/** Situação do plano de ação de um checklist. */
async function planSummary(checklistId, actionsArg) {
  const actions = actionsArg || await actionsOf(checklistId);
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

async function hasAta(checklistId) {
  return !!await dbm.get("SELECT 1 FROM attachments WHERE checklist_id = ? AND kind = 'ata'", checklistId);
}

/** Requisitos para assinar/fechar o checklist. Retorna lista de { ok, text }. */
async function signatureRequirements(cl, evalsArg, actionsArg) {
  const evals = evalsArg || await getEvaluations(cl.id);
  const actions = actionsArg || await actionsOf(cl.id);
  const reqs = [];
  const plan = await planSummary(cl.id, actions);
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

async function canSignNow(cl, evals, actions) {
  return (await signatureRequirements(cl, evals, actions)).every((r) => r.ok);
}

/** Recalcula o status do checklist: Não iniciada, Em andamento, Concluída, Assinada. */
async function refreshStatus(checklistId) {
  const cl = await dbm.get('SELECT * FROM checklists WHERE id = ?', checklistId);
  if (!cl) return null;
  const evals = await dbm.all('SELECT kind, status FROM evaluations WHERE checklist_id = ?', checklistId);
  const ev = Object.fromEntries(evals.map((e) => [e.kind, e.status]));
  const sigs = await signaturesOf(checklistId);
  let concluded;
  let signed;
  if (cl.self_verification) {
    concluded = ev.gestor === 'enviada';
    signed = concluded && !!sigs.colaborador && (!!sigs.validador || await hasAta(checklistId));
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
    const ata = await dbm.get("SELECT MAX(uploaded_at) AS t FROM attachments WHERE checklist_id = ? AND kind = 'ata'", checklistId);
    if (cl.self_verification && !sigs.validador && ata && ata.t) times.push(ata.t);
    closedAt = cl.closed_at || times.sort().pop() || nowIso();
  }
  await dbm.run('UPDATE checklists SET status = ?, closed_at = ? WHERE id = ?', status, closedAt, checklistId);

  // Liberação automática do resultado (se configurada no ciclo)
  if (concluded && !cl.self_verification && !cl.results_released_at) {
    const cycle = await getCycle(cl.cycle_id);
    if (cycle && cycle.auto_release) {
      await dbm.run('UPDATE checklists SET results_released_at = ? WHERE id = ?', nowIso(), checklistId);
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
async function loadChecklistBundle(id) {
  const cl = await getChecklist(id);
  if (!cl) return null;
  const comps = await checklistCompetencies(cl);
  const evals = await getEvaluations(id);
  const actions = await actionsOf(id);
  const sigs = await signaturesOf(id);
  const plan = await planSummary(id, actions);
  const attachments = await attachmentsOf(id);
  const cycle = await getCycle(cl.cycle_id);
  const gaps = computeGaps(comps.applicable, verificationOf(cl, evals));
  return {
    cl, cycle, comps, evals, actions, sigs, plan, attachments, gaps,
    stage: stageOf(cl, evals, sigs, plan),
    requirements: await signatureRequirements(cl, evals, actions),
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

async function getUser(id) {
  return await dbm.get('SELECT * FROM users WHERE id = ?', id);
}

async function listUsers({ activeOnly = false } = {}) {
  return await dbm.all(`SELECT * FROM users ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY name`);
}

/** Pessoas que avaliam alguém (gestores) no ciclo. */
async function managersInCycle(cycleId) {
  return await dbm.all(`SELECT DISTINCT u.id, u.name FROM checklists cl JOIN users u ON u.id = cl.evaluator_user_id
                        WHERE cl.cycle_id = ? AND cl.self_verification = 0 ORDER BY u.name`, cycleId);
}

async function isManager(userId, cycleId) {
  if (!cycleId) return false;
  return !!await dbm.get('SELECT 1 FROM checklists WHERE cycle_id = ? AND evaluator_user_id = ? AND self_verification = 0', cycleId, userId);
}

async function isValidatorOf(userId, cycleId) {
  if (!cycleId) return false;
  return !!await dbm.get('SELECT 1 FROM checklists WHERE cycle_id = ? AND validator_user_id = ?', cycleId, userId);
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
