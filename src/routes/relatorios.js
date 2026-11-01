'use strict';
const express = require('express');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const domain = require('../lib/domain');
const reports = require('../lib/reports');

const router = require('../lib/async-router')();

const TABS = {
  visao: 'Cobertura e pendências',
  individual: 'Resultado individual',
  lacunas: 'Lacunas e plano de ação',
  competencia: 'Por competência',
  cargo: 'Por cargo',
  gestor: 'Por gestor / equipe',
  area: 'Por área',
  comparacao: 'Comparação com o ciclo anterior',
};

async function readFilters(req) {
  const cycles = await domain.listCycles();
  const cur = await domain.currentCycle();
  const cycle = cycles.find((c) => String(c.id) === String(req.query.ciclo)) || cur;
  const filters = {
    area: req.query.area || '',
    gestor: req.query.gestor || '',
    cargo: req.query.cargo || '',
  };
  return { cycles, cycle, filters };
}

function qs(cycle, filters, extra = {}) {
  const p = new URLSearchParams({ ciclo: cycle ? cycle.id : '', ...filters, ...extra });
  for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
  return p.toString();
}

router.get('/relatorios', auth.requireRole('admin', 'ceo'), async (req, res) => {
  const { cycles, cycle, filters } = await readFilters(req);
  if (!cycle) return res.render('error', { title: 'Relatórios', message: 'Nenhum ciclo cadastrado.' });
  const tab = TABS[req.query.aba] ? req.query.aba : 'visao';
  const report = await reports.buildReport(cycle, filters, req.user);
  await audit.log(req, 'visualizou_relatorio', { details: { aba: tab, ciclo: cycle.name, ...filters }, coalesceMinutes: 10 });
  const selected = req.query.checklist ? report.rows.find((r) => String(r.cl.id) === String(req.query.checklist)) : null;
  res.render('relatorios/index', {
    title: 'Relatórios',
    cycles, cycle, filters, tab, TABS, report, selected,
    options: await reports.filterOptions(cycle),
    qs: (extra) => qs(cycle, filters, extra),
  });
});

router.get('/relatorios/exportar.:fmt(pdf|xlsx)', auth.requireRole('admin', 'ceo'), async (req, res, next) => {
  try {
    const { cycle, filters } = await readFilters(req);
    const report = await reports.buildReport(cycle, filters, req.user);
    const section = TABS[req.query.aba] ? req.query.aba : 'todas';
    await audit.log(req, 'exportou_relatorio', { details: { formato: req.params.fmt, aba: section, ciclo: cycle.name, ...filters } });
    const base = `relatorio-competencias-${cycle.year}${section !== 'todas' ? `-${section}` : ''}`;
    if (req.params.fmt === 'xlsx') {
      const buf = await require('../lib/excel').reportWorkbook(report, section);
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${base}.xlsx"`);
      return res.send(Buffer.from(buf));
    }
    const buf = await require('../lib/pdf').reportPdf(report, section, TABS);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${base}.pdf"`);
    return res.send(buf);
  } catch (err) { return next(err); }
});

/* ------------------------------------------------- Indicadores do SGI */

async function sgiData(cycle) {
  const rows = await reports.detailRows(await domain.listChecklists(cycle.id), cycle, null);
  const full = await reports.buildReport(cycle, {}, null);
  return {
    rows: rows.map((r) => ({
      code: r.cl.cargo_code,
      colaborador: r.cl.user_name,
      cargo: r.cl.cargo_short,
      area: r.cl.area,
      avaliador: r.evaluatorLabel,
      avaliacoes: r.cl.self_verification ? r.gestorSent : (r.autoSent && r.gestorSent),
      planoCompleto: r.gestorSent ? r.plan.complete : null,
      assinado: r.cl.status === 'assinada',
      status: r.cl.status,
      closedAt: r.cl.closed_at,
      selfVerification: !!r.cl.self_verification,
      validacao: r.cl.self_verification ? (r.sigs.validador ? `Validado por ${r.sigs.validador.signer_name}` : (r.hasAta ? 'Ata da Diretoria anexada' : 'Pendente')) : null,
    })),
    coverage: reports.coverageOf(rows),
    gaps: { total: full.gaps.total, pctComAcao: full.gaps.pctComAcao, pctConcluidas: full.gaps.pctConcluidas },
    version: full.version,
  };
}

router.get('/sgi', auth.requireRole('admin', 'ceo', 'rh', 'sgi'), async (req, res) => {
  const cycles = await domain.listCycles();
  const cycle = cycles.find((c) => String(c.id) === String(req.query.ciclo)) || await domain.currentCycle();
  if (!cycle) return res.render('error', { title: 'Indicadores SGI', message: 'Nenhum ciclo cadastrado.' });
  await audit.log(req, 'visualizou_indicadores_sgi', { details: { ciclo: cycle.name }, coalesceMinutes: 10 });
  res.render('relatorios/sgi', { title: 'Indicadores SGI', cycle, cycles, ...await sgiData(cycle) });
});

router.get('/sgi/exportar.pdf', auth.requireRole('admin', 'ceo', 'rh', 'sgi'), async (req, res, next) => {
  try {
    const cycles = await domain.listCycles();
    const cycle = cycles.find((c) => String(c.id) === String(req.query.ciclo)) || await domain.currentCycle();
    const buf = await require('../lib/pdf').sgiPdf(cycle, await sgiData(cycle));
    await audit.log(req, 'exportou_relatorio', { details: { formato: 'pdf', aba: 'sgi', ciclo: cycle.name } });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="sgi-e3-3-1-item7-${cycle.year}.pdf"`);
    return res.send(buf);
  } catch (err) { return next(err); }
});

module.exports = router;
module.exports.TABS = TABS;
