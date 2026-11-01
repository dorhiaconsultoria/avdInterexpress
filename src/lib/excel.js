'use strict';
// Exportação dos relatórios em Excel (uma aba por seção).
const ExcelJS = require('exceljs');
const { CHECKLIST_STATUS, ACTION_STATUS, ACTION_CATEGORIES, fmtDate } = require('./util');

const BLUE = 'FF1A3E9E';

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.columns = columns.map(([header, key, width]) => ({ header, key, width: width || 16 }));
  rows.forEach((r) => ws.addRow(r));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
  head.alignment = { vertical: 'middle', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: 'top', wrapText: true }; });
  return ws;
}

const pct = (v) => (v == null ? null : v / 100);

function setPct(ws, keys) {
  keys.forEach((k) => { ws.getColumn(k).numFmt = '0.0%'; });
}

async function reportWorkbook(report, section = 'todas') {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'InterExpress — Verificação de Competências';
  wb.created = new Date();
  const all = section === 'todas';
  const cov = report.coverage;

  if (all || section === 'visao') {
    sheet(wb, 'Cobertura', [['Indicador', 'ind', 52], ['Valor', 'val', 18]], [
      { ind: 'Ciclo', val: report.cycle.name },
      { ind: 'Matriz', val: report.version ? `Versão ${report.version.number} de ${fmtDate(report.version.version_date)}` : '—' },
      { ind: 'Verificações previstas', val: cov.previstas },
      { ind: 'Realizadas (avaliações concluídas)', val: cov.realizadas },
      { ind: 'Cobertura (meta 100%)', val: `${cov.cobertura}%` },
      { ind: 'Checklists assinados', val: cov.assinados },
      { ind: 'Autoavaliações enviadas', val: `${cov.autoEnviadas} de ${cov.autoEsperadas}` },
      { ind: 'Avaliações do gestor / autoverificações enviadas', val: `${cov.gestorEnviadas} de ${cov.previstas}` },
      { ind: 'Resultados liberados ao colaborador', val: `${cov.liberados} de ${cov.autoEsperadas}` },
    ]);
    sheet(wb, 'Pendências', [['Responsável', 'resp', 20], ['Pendência', 'text', 70], ['Colaborador', 'colab', 18], ['Cargo', 'cargo', 34], ['Prazo', 'prazo', 12]],
      report.pendencias.all.map((p) => ({ resp: p.userName || '—', text: p.text, colab: p.colaborador, cargo: p.cargo, prazo: fmtDate(p.deadline) })));
  }

  if (all || section === 'individual') {
    const rows = [];
    for (const r of report.rows) {
      for (const i of r.items) {
        rows.push({
          colab: r.cl.user_name, code: r.cl.cargo_code, cargo: r.cl.cargo_short, area: r.cl.area, aval: r.evaluatorLabel,
          comp: `${i.code} ${i.name}`, req: i.required, auto: r.masked ? 'oculta' : i.auto, gestor: i.gestor, diff: i.diff,
          lacuna: i.gestor == null ? '' : (i.gap ? i.gap : 'Atende'), status: CHECKLIST_STATUS[r.cl.status],
          evAuto: r.masked ? '' : (i.autoEvidence || ''), evGestor: i.gestorEvidence || '',
        });
      }
    }
    sheet(wb, 'Resultado individual', [
      ['Colaborador', 'colab', 16], ['Cód.', 'code', 7], ['Cargo', 'cargo', 28], ['Área', 'area', 22], ['Avaliador', 'aval', 28],
      ['Competência', 'comp', 36], ['Exigido', 'req', 9], ['Autoavaliação', 'auto', 13], ['Gestor', 'gestor', 9], ['Diferença (gestor − auto)', 'diff', 13],
      ['Lacuna', 'lacuna', 10], ['Status', 'status', 14], ['Evidência autoavaliação', 'evAuto', 50], ['Evidência gestor', 'evGestor', 50],
    ], rows);
  }

  if (all || section === 'lacunas') {
    sheet(wb, 'Lacunas e plano', [
      ['Colaborador', 'colab', 16], ['Cód.', 'code', 7], ['Cargo', 'cargo', 28], ['Competência', 'comp', 34], ['Exigido', 'req', 9], ['Verificado', 'ver', 10],
      ['Ação acordada', 'acao', 60], ['Responsável', 'resp', 18], ['Prazo', 'prazo', 12], ['Status', 'status', 14], ['Ação definida', 'def', 12],
    ], report.gaps.lacunas.map((l) => ({
      colab: l.colaborador, code: l.cargoCode, cargo: l.cargo, comp: `${l.competency_code} ${l.competencia}`, req: l.required_level, ver: l.verified_level,
      acao: l.action || '', resp: l.responsible || '', prazo: fmtDate(l.due_date), status: ACTION_STATUS[l.status], def: l.defined ? 'Sim' : 'Não',
    })));
    sheet(wb, 'Ações livres (PDI)', [
      ['Colaborador', 'colab', 16], ['Cód.', 'code', 7], ['Tipo', 'tipo', 20], ['Ação', 'acao', 60], ['Responsável', 'resp', 18], ['Prazo', 'prazo', 12],
      ['Validada pelo gestor', 'val', 14], ['Status', 'status', 14],
    ], report.gaps.livres.map((l) => ({
      colab: l.colaborador, code: l.cargoCode, tipo: ACTION_CATEGORIES[l.category] || '', acao: l.action || '', resp: l.responsible || '',
      prazo: fmtDate(l.due_date), val: l.validated_by ? 'Sim' : 'Não', status: ACTION_STATUS[l.status],
    })));
    sheet(wb, 'Indicadores do plano', [['Indicador', 'ind', 44], ['Valor', 'val', 14]], [
      { ind: 'Lacunas registradas', val: report.gaps.total },
      { ind: '% lacunas com ação, responsável e prazo', val: report.gaps.pctComAcao == null ? '—' : `${report.gaps.pctComAcao}%` },
      { ind: '% ações de lacuna concluídas', val: report.gaps.pctConcluidas == null ? '—' : `${report.gaps.pctConcluidas}%` },
    ]);
  }

  if (all || section === 'competencia') {
    const ws = sheet(wb, 'Por competência', [
      ['Competência', 'comp', 38], ['Aplicável', 'apl', 10], ['Avaliadas', 'av', 10], ['Atende', 'at', 9], ['Lacunas', 'lac', 9], ['% que atende', 'pct', 12],
      ['Média exigida', 'mex', 12], ['Média verificada', 'mver', 13], ['Média auto', 'mauto', 11], ['Dif. média (gestor − auto)', 'dif', 14],
    ], report.byCompetency.map((c) => ({
      comp: `${c.code} ${c.name}`, apl: c.aplicavel, av: c.avaliadas, at: c.atende, lac: c.lacunas, pct: pct(c.pctAtende),
      mex: c.mediaExigida, mver: c.mediaVerificada, mauto: c.mediaAuto, dif: c.difMedia,
    })));
    setPct(ws, ['pct']);
    ['mex', 'mver', 'mauto', 'dif'].forEach((k) => { ws.getColumn(k).numFmt = '0.00'; });
  }

  const agg = (name, data, head) => {
    const ws = sheet(wb, name, [
      [head, 'label', 34], ['Previstas', 'prev', 10], ['Realizadas', 'real', 11], ['Cobertura', 'cob', 11], ['Assinados', 'ass', 10],
      ['Competências avaliadas', 'av', 14], ['% que atende', 'pct', 12], ['Lacunas', 'lac', 9],
    ], data.map((d) => ({ label: d.label, prev: d.previstas, real: d.realizadas, cob: pct(d.cobertura), ass: d.assinados, av: d.avaliadas, pct: pct(d.pctAtende), lac: d.lacunas })));
    setPct(ws, ['cob', 'pct']);
  };
  if (all || section === 'cargo') agg('Por cargo', report.byCargo, 'Cargo');
  if (all || section === 'gestor') agg('Por gestor', report.byGestor, 'Gestor / equipe');
  if (all || section === 'area') agg('Por área', report.byArea, 'Área');

  if (all || section === 'comparacao') {
    if (report.comparison) {
      const p = report.comparison.previous;
      const c = report.comparison.current;
      sheet(wb, 'Comparação', [['Indicador', 'ind', 36], [p.cycle.name, 'prev', 14], [c.cycle.name, 'cur', 14]], [
        { ind: 'Verificações previstas', prev: p.coverage.previstas, cur: c.coverage.previstas },
        { ind: 'Cobertura (%)', prev: p.coverage.cobertura, cur: c.coverage.cobertura },
        { ind: 'Assinados', prev: p.coverage.assinados, cur: c.coverage.assinados },
        { ind: '% competências que atendem', prev: p.pctAtende, cur: c.pctAtende },
        { ind: 'Lacunas', prev: p.lacunas, cur: c.lacunas },
        ...c.competencias.map((cc) => {
          const pc = p.competencias.find((x) => x.code === cc.code);
          return { ind: `% atende ${cc.code} ${cc.name}`, prev: pc ? pc.pctAtende : null, cur: cc.pctAtende };
        }),
      ]);
    } else {
      sheet(wb, 'Comparação', [['Observação', 'obs', 80]], [{ obs: `${report.cycle.name} é o primeiro ciclo: ainda não há base de comparação.` }]);
    }
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { reportWorkbook };
