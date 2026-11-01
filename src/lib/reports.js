'use strict';
// Consolidação dos relatórios (cobertura, pendências, resultados, lacunas, visões e comparação).
const domain = require('./domain');
const tasks = require('./tasks');
const { pct } = require('./util');

function avg(list) {
  const v = list.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function applyFilters(list, f) {
  return list.filter((cl) => (!f.area || cl.area === f.area)
    && (!f.cargo || String(cl.cargo_id) === String(f.cargo))
    && (!f.gestor || (f.gestor === 'auto' ? cl.self_verification === 1
      : (!cl.self_verification && String(cl.evaluator_user_id) === String(f.gestor)))));
}

/** Monta o detalhe de cada checklist do conjunto (com máscara da autoavaliação quando necessário). */
async function detailRows(list, cycle, viewer) {
  const versionId = await domain.cycleVersionId(cycle);
  const comps = versionId ? await domain.competenciesOf(versionId) : [];
  const levels = versionId ? await domain.levelsOf(versionId) : {};
  return Promise.all(list.map(async (cl) => {
    const evals = await domain.getEvaluations(cl.id);
    const autoSent = domain.isSubmitted(evals.auto);
    const gestorSent = domain.isSubmitted(evals.gestor);
    const masked = !!viewer && !cl.self_verification && cl.evaluator_user_id === viewer.id && !gestorSent;
    const lv = levels[cl.cargo_id] || {};
    const items = [];
    for (const c of comps) {
      const required = lv[c.code];
      if (required == null) continue;
      const a = autoSent && !masked && evals.auto.items[c.code] ? evals.auto.items[c.code] : null;
      const g = gestorSent && evals.gestor.items[c.code] ? evals.gestor.items[c.code] : null;
      const auto = a ? a.rating : null;
      const gestor = g ? g.rating : null;
      items.push({
        code: c.code,
        name: c.name,
        required,
        auto,
        gestor,
        autoEvidence: a ? a.evidence : null,
        gestorEvidence: g ? g.evidence : null,
        diff: auto != null && gestor != null && !cl.self_verification ? gestor - auto : null,
        gap: gestor != null && gestor < required ? gestor - required : 0,
        meets: gestor != null ? gestor >= required : null,
      });
    }
    const actions = await domain.actionsOf(cl.id);
    const sigs = await domain.signaturesOf(cl.id);
    const plan = await domain.planSummary(cl.id, actions);
    return {
      cl, items, actions, sigs, plan, autoSent, gestorSent, masked,
      evaluatorLabel: domain.evaluatorLabel(cl),
      stage: domain.stageOf(cl, evals, sigs, plan),
      hasAta: await domain.hasAta(cl.id),
    };
  }));
}

function coverageOf(rows) {
  const previstas = rows.length;
  const realizadas = rows.filter((r) => r.cl.status === 'concluida' || r.cl.status === 'assinada').length;
  const assinados = rows.filter((r) => r.cl.status === 'assinada').length;
  const autoEsperadas = rows.filter((r) => !r.cl.self_verification).length;
  return {
    previstas,
    realizadas,
    cobertura: pct(realizadas, previstas),
    assinados,
    pctAssinados: pct(assinados, previstas),
    autoEsperadas,
    autoEnviadas: rows.filter((r) => !r.cl.self_verification && r.autoSent).length,
    gestorEnviadas: rows.filter((r) => r.gestorSent).length,
    naoIniciadas: rows.filter((r) => r.cl.status === 'nao_iniciada').length,
    emAndamento: rows.filter((r) => r.cl.status === 'em_andamento').length,
    concluidas: rows.filter((r) => r.cl.status === 'concluida').length,
    liberados: rows.filter((r) => !r.cl.self_verification && r.cl.results_released_at).length,
  };
}

function aggregate(rows, keyFn, labelFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (!groups.has(key)) groups.set(key, { key, label: labelFn(r), rows: [] });
    groups.get(key).rows.push(r);
  }
  return [...groups.values()].map((g) => {
    const verified = g.rows.flatMap((r) => r.items.filter((i) => i.gestor != null));
    const atende = verified.filter((i) => i.meets).length;
    const gaps = verified.filter((i) => !i.meets).length;
    const cov = coverageOf(g.rows);
    return {
      key: g.key,
      label: g.label,
      previstas: cov.previstas,
      realizadas: cov.realizadas,
      cobertura: cov.cobertura,
      assinados: cov.assinados,
      autoEnviadas: cov.autoEnviadas,
      gestorEnviadas: cov.gestorEnviadas,
      avaliadas: verified.length,
      atende,
      lacunas: gaps,
      pctAtende: verified.length ? pct(atende, verified.length) : null,
      mediaVerificada: avg(verified.map((i) => i.gestor)),
      mediaExigida: avg(verified.map((i) => i.required)),
    };
  }).sort((a, b) => String(a.label).localeCompare(String(b.label), 'pt-BR'));
}

function byCompetency(rows, comps) {
  return comps.map((c) => {
    const its = rows.map((r) => r.items.find((i) => i.code === c.code)).filter(Boolean);
    const verified = its.filter((i) => i.gestor != null);
    const pair = its.filter((i) => i.gestor != null && i.auto != null && i.diff != null);
    const atende = verified.filter((i) => i.meets).length;
    return {
      code: c.code,
      name: c.name,
      aplicavel: its.length,
      avaliadas: verified.length,
      atende,
      lacunas: verified.length - atende,
      pctAtende: verified.length ? pct(atende, verified.length) : null,
      mediaExigida: avg(its.map((i) => i.required)),
      mediaVerificada: avg(verified.map((i) => i.gestor)),
      mediaAuto: avg(its.map((i) => i.auto)),
      difMedia: avg(pair.map((i) => i.diff)),
    };
  });
}

function gapRegister(rows) {
  const lacunas = [];
  const livres = [];
  for (const r of rows) {
    for (const a of r.actions) {
      const base = {
        checklistId: r.cl.id, colaborador: r.cl.user_name, cargoCode: r.cl.cargo_code, cargo: r.cl.cargo_short,
        area: r.cl.area, avaliador: r.evaluatorLabel, ...a, defined: domain.actionDefined(a),
      };
      if (a.origin === 'lacuna') {
        const comp = r.items.find((i) => i.code === a.competency_code);
        lacunas.push({ ...base, competencia: comp ? comp.name : a.competency_code });
      } else livres.push(base);
    }
  }
  const comAcao = lacunas.filter((l) => l.defined).length;
  const concluidas = lacunas.filter((l) => l.status === 'concluida').length;
  return {
    lacunas,
    livres,
    total: lacunas.length,
    comAcao,
    pctComAcao: lacunas.length ? pct(comAcao, lacunas.length) : null,
    concluidas,
    pctConcluidas: lacunas.length ? pct(concluidas, lacunas.length) : null,
    emAndamento: lacunas.filter((l) => l.status === 'em_andamento').length,
  };
}

async function summaryForComparison(cycle, filters) {
  const list = applyFilters(await domain.listChecklists(cycle.id), filters);
  const rows = await detailRows(list, cycle, null);
  const versionId = await domain.cycleVersionId(cycle);
  const comps = versionId ? await domain.competenciesOf(versionId) : [];
  const verified = rows.flatMap((r) => r.items.filter((i) => i.gestor != null));
  const atende = verified.filter((i) => i.meets).length;
  return {
    cycle,
    coverage: coverageOf(rows),
    pctAtende: verified.length ? pct(atende, verified.length) : null,
    lacunas: verified.length - atende,
    competencias: byCompetency(rows, comps),
  };
}

/**
 * Relatório completo de um ciclo com filtros { area, gestor, cargo }.
 * viewer: usuário efetivo (para esconder autoavaliações de quem ainda vai avaliar).
 */
async function buildReport(cycle, filters = {}, viewer = null) {
  const all = await domain.listChecklists(cycle.id);
  const list = applyFilters(all, filters);
  const rows = await detailRows(list, cycle, viewer);
  const versionId = await domain.cycleVersionId(cycle);
  const comps = versionId ? await domain.competenciesOf(versionId) : [];
  const ids = new Set(list.map((c) => c.id));
  const pend = (await tasks.cyclePendencias(cycle)).filter((p) => ids.has(p.checklistId));
  const prev = await domain.previousCycle(cycle);
  const current = await summaryForComparison(cycle, filters);
  return {
    cycle,
    filters,
    version: versionId ? await domain.getVersion(versionId) : null,
    comps,
    rows,
    coverage: coverageOf(rows),
    pendencias: {
      all: pend,
      autoavaliacao: pend.filter((p) => p.type === 'autoavaliacao' || p.type === 'autoverificacao'),
      gestor: pend.filter((p) => p.type === 'avaliacao_gestor'),
      liberacao: pend.filter((p) => p.type === 'liberar'),
      plano: pend.filter((p) => p.type === 'plano'),
      assinatura: pend.filter((p) => ['assinatura', 'assinatura_gestor', 'validacao', 'definir_validador'].includes(p.type)),
    },
    gaps: gapRegister(rows),
    byCompetency: byCompetency(rows, comps),
    byCargo: aggregate(rows, (r) => r.cl.cargo_id, (r) => `${r.cl.cargo_code} — ${r.cl.cargo_short}`),
    byGestor: aggregate(rows, (r) => (r.cl.self_verification ? 'auto' : r.cl.evaluator_user_id),
      (r) => (r.cl.self_verification ? 'Autoverificação (validada por terceiro)' : r.cl.evaluator_name)),
    byArea: aggregate(rows, (r) => r.cl.area, (r) => r.cl.area),
    comparison: prev ? { previous: await summaryForComparison(prev, filters), current } : null,
  };
}

/** Opções dos filtros (áreas, gestores e cargos presentes no ciclo). */
async function filterOptions(cycle) {
  const list = await domain.listChecklists(cycle.id);
  const areas = [...new Set(list.map((c) => c.area))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const gestores = await domain.managersInCycle(cycle.id);
  const cargos = [...new Map(list.map((c) => [c.cargo_id, { id: c.cargo_id, label: `${c.cargo_code} — ${c.cargo_short}` }])).values()];
  return { areas, gestores, cargos, hasSelf: list.some((c) => c.self_verification) };
}

module.exports = { buildReport, filterOptions, coverageOf, detailRows, applyFilters };
