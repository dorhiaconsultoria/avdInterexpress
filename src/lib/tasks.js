'use strict';
// Pendências do ciclo: alimentam o painel "o que eu preciso fazer", o acompanhamento e os lembretes.
const dbm = require('../db');
const domain = require('./domain');

/**
 * Lista todas as pendências do ciclo.
 * Cada pendência: { userId, userName, checklistId, type, text, deadline, href, colaborador, cargo }
 */
async function cyclePendencias(cycle) {
  if (!cycle) return [];
  const list = await domain.listChecklists(cycle.id);
  const evalRows = await dbm.all(`SELECT e.checklist_id, e.kind, e.status FROM evaluations e
                                 JOIN checklists cl ON cl.id = e.checklist_id WHERE cl.cycle_id = ?`, cycle.id);
  const evalMap = {};
  for (const r of evalRows) (evalMap[r.checklist_id] = evalMap[r.checklist_id] || {})[r.kind] = r.status;
  const out = [];
  const push = (cl, userId, userName, type, text, deadline, href) => out.push({
    userId, userName, checklistId: cl.id, type, text, deadline, href: href || `/checklists/${cl.id}`,
    colaborador: cl.user_name, cargo: `${cl.cargo_code} — ${cl.cargo_short}`, evaluatorName: cl.evaluator_name,
    selfVerification: !!cl.self_verification,
  });

  for (const cl of list) {
    const ev = evalMap[cl.id] || {};
    const sigs = await domain.signaturesOf(cl.id);
    const plan = await domain.planSummary(cl.id);
    if (cl.status === 'assinada') continue;
    if (cl.self_verification) {
      if (ev.gestor !== 'enviada') {
        push(cl, cl.user_id, cl.user_name, 'autoverificacao', `Fazer a autoverificação do cargo ${cl.cargo_code} — ${cl.cargo_short}`,
          cycle.manager_deadline, `/checklists/${cl.id}/avaliar/gestor`);
        continue;
      }
      if (!plan.complete) push(cl, cl.user_id, cl.user_name, 'plano', `Completar o plano de ação do cargo ${cl.cargo_code}`, cycle.feedback_deadline);
      else if (!sigs.colaborador) push(cl, cl.user_id, cl.user_name, 'assinatura', `Assinar o checklist do cargo ${cl.cargo_code}`, cycle.feedback_deadline);
      if (!sigs.validador && !await domain.hasAta(cl.id)) {
        if (cl.validator_user_id) {
          push(cl, cl.validator_user_id, cl.validator_name, 'validacao', `Validar a autoverificação de ${cl.user_name} (${cl.cargo_code} — ${cl.cargo_short})`, cycle.feedback_deadline);
        } else {
          push(cl, null, 'Administradora', 'definir_validador', `Definir validador ou anexar a ata da Diretoria — ${cl.user_name} (${cl.cargo_code})`, cycle.feedback_deadline);
        }
      }
      continue;
    }
    if (ev.auto !== 'enviada') {
      push(cl, cl.user_id, cl.user_name, 'autoavaliacao',
        ev.auto === 'rascunho' ? `Concluir e enviar a autoavaliação (${cl.cargo_code} — ${cl.cargo_short})` : `Fazer a autoavaliação (${cl.cargo_code} — ${cl.cargo_short})`,
        cycle.self_deadline, `/checklists/${cl.id}/avaliar/auto`);
    }
    if (ev.gestor !== 'enviada') {
      push(cl, cl.evaluator_user_id, cl.evaluator_name, 'avaliacao_gestor',
        `${ev.gestor === 'rascunho' ? 'Concluir a avaliação de' : 'Avaliar'} ${cl.user_name} (${cl.cargo_code} — ${cl.cargo_short})`,
        cycle.manager_deadline, `/checklists/${cl.id}/avaliar/gestor`);
    }
    if (ev.auto === 'enviada' && ev.gestor === 'enviada') {
      if (!cl.results_released_at) {
        push(cl, null, 'Administradora', 'liberar', `Liberar o resultado de ${cl.user_name} (${cl.cargo_code})`, cycle.feedback_deadline);
        continue;
      }
      if (!plan.complete || plan.freePending || plan.freeIncomplete) {
        push(cl, cl.evaluator_user_id, cl.evaluator_name, 'plano',
          `Completar ${plan.freePending ? 'e validar ' : ''}o plano de ação de ${cl.user_name} (${plan.gapsDefined} de ${plan.gaps} lacunas com ação)`, cycle.feedback_deadline);
        continue;
      }
      if (!sigs.colaborador) push(cl, cl.user_id, cl.user_name, 'assinatura', `Assinar o seu checklist (${cl.cargo_code} — ${cl.cargo_short})`, cycle.feedback_deadline);
      if (!sigs.gestor) push(cl, cl.evaluator_user_id, cl.evaluator_name, 'assinatura_gestor', `Assinar o checklist de ${cl.user_name} (${cl.cargo_code})`, cycle.feedback_deadline);
    }
  }
  return out;
}

async function tasksForUser(userId, cycle) {
  if (!cycle || cycle.status !== 'em_andamento') return [];
  return (await cyclePendencias(cycle)).filter((p) => p.userId === userId);
}

/** Agrupa pendências por pessoa (para lembretes). */
function groupByUser(pendencias) {
  const map = new Map();
  for (const p of pendencias) {
    if (!p.userId) continue;
    if (!map.has(p.userId)) map.set(p.userId, { userId: p.userId, userName: p.userName, items: [] });
    map.get(p.userId).items.push(p);
  }
  return [...map.values()];
}

module.exports = { cyclePendencias, tasksForUser, groupByUser };
