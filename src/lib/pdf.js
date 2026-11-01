'use strict';
// PDFs: checklist individual (evidência de auditoria do SGI), relatórios e indicadores do SGI.
const fs = require('fs');
const path = require('path');
const pdfmake = require('pdfmake');
const dbm = require('../db');
const config = require('../config');
const {
  fmtDate, fmtDateTime, fmtPct, fmtNum, nowIso, LEVEL_LABELS, CHECKLIST_STATUS, ACTION_STATUS, ACTION_CATEGORIES, CYCLE_STATUS,
} = require('./util');

const fontsDir = path.dirname(require.resolve('pdfmake/fonts/Roboto'));
pdfmake.setFonts(require('pdfmake/fonts/Roboto'));
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p) => path.resolve(p).startsWith(fontsDir));

const BLUE = '#1A3E9E';
const ORANGE = '#F28C1B';
const MUTED = '#5B6475';
const LINE = '#D5DAE5';
const RED = '#B42318';
const GREEN = '#1E7B4F';

const DEFAULT_LOGO = fs.readFileSync(path.join(config.root, 'public/img/logo.svg'), 'utf8');
let logoSource = { svg: DEFAULT_LOGO };

/** Carrega o logo enviado pela administradora (guardado no banco) ou o padrão. */
async function loadLogo() {
  logoSource = { svg: DEFAULT_LOGO };
  const row = await dbm.get("SELECT name, mime, data FROM app_files WHERE key = 'logo'");
  if (!row) return;
  const ext = path.extname(row.name).toLowerCase();
  if (ext === '.svg') logoSource = { svg: row.data.toString('utf8') };
  else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    logoSource = { image: `data:${ext === '.png' ? 'image/png' : 'image/jpeg'};base64,${row.data.toString('base64')}` };
  }
}

function logoNode(width = 120) {
  return { ...logoSource, width };
}

/** Confere se um SVG enviado como logo pode ser desenhado no PDF. */
async function svgLogoWorks(svg) {
  try {
    await pdfmake.createPdf({ content: [{ svg, width: 100 }] }).getBuffer();
    return true;
  } catch {
    return false;
  }
}

const styles = {
  h1: { fontSize: 16, bold: true, color: BLUE, margin: [0, 0, 0, 2] },
  h2: { fontSize: 12, bold: true, color: BLUE, margin: [0, 12, 0, 6] },
  h3: { fontSize: 10, bold: true, margin: [0, 8, 0, 4] },
  sub: { fontSize: 9, color: MUTED },
  th: { bold: true, color: '#FFFFFF', fillColor: BLUE, fontSize: 8.5 },
  small: { fontSize: 8, color: MUTED },
  label: { fontSize: 8, color: MUTED },
};

const tableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.6 : 0.4),
  vLineWidth: () => 0,
  hLineColor: () => LINE,
  paddingLeft: () => 5,
  paddingRight: () => 5,
  paddingTop: () => 3.5,
  paddingBottom: () => 3.5,
  fillColor: (row) => (row > 0 && row % 2 === 0 ? '#F5F7FB' : null),
};

function th(text) {
  return { text, style: 'th' };
}

function table(headers, rows, widths, opts = {}) {
  return {
    table: { headerRows: 1, widths: widths || headers.map(() => '*'), body: [headers.map(th), ...rows], dontBreakRows: true },
    layout: tableLayout,
    fontSize: opts.fontSize || 8.5,
    margin: [0, 0, 0, 6],
  };
}

function header(title, subtitle) {
  return {
    columns: [
      { ...logoNode(110), margin: [0, 0, 0, 0] },
      { stack: [{ text: title, style: 'h1', alignment: 'right' }, { text: subtitle || '', style: 'sub', alignment: 'right' }] },
    ],
    margin: [0, 0, 0, 4],
  };
}

function rule(landscape = false) {
  return { canvas: [{ type: 'rect', x: 0, y: 0, w: landscape ? 770 : 523, h: 2.5, color: ORANGE }], margin: [0, 2, 0, 10] };
}

function footer(extra) {
  return (current, total) => ({
    columns: [
      { text: `InterExpress · Verificação de Competências · Registro SGI E3.3.1, item 7${extra ? ` · ${extra}` : ''}`, style: 'small' },
      { text: `Gerado em ${fmtDateTime(nowIso())} · página ${current} de ${total}`, style: 'small', alignment: 'right' },
    ],
    margin: [36, 10, 36, 0],
  });
}

async function render(doc) {
  const out = pdfmake.createPdf({
    pageSize: 'A4',
    pageMargins: [36, 36, 36, 40],
    defaultStyle: { font: 'Roboto', fontSize: 9, lineHeight: 1.15 },
    styles,
    info: { creator: 'InterExpress — Verificação de Competências', producer: 'InterExpress' },
    ...doc,
  });
  return out.getBuffer();
}

function lvl(n) {
  return n == null ? '—' : `${n}`;
}

function gapText(required, verified) {
  if (verified == null) return { text: '—', color: MUTED };
  if (verified >= required) return { text: 'Atende', color: GREEN, bold: true };
  return { text: `Lacuna (${verified - required})`, color: RED, bold: true };
}

/* ------------------------------------------------------------- checklist */

async function checklistPdf(bundle, access) {
  await loadLogo();
  const { cl, cycle, comps, evals, actions, sigs, plan, attachments, ata } = bundle;
  const isSelf = !!cl.self_verification;
  const autoOk = access.seeAuto && evals.auto && evals.auto.status === 'enviada';
  const gestorOk = access.seeGestor && evals.gestor && evals.gestor.status === 'enviada';
  const verLabel = isSelf ? 'Autoverificação' : 'Gestor';

  const info = [
    [{ text: 'Colaborador', style: 'label' }, cl.user_name, { text: 'Ciclo', style: 'label' }, `${cycle.name} (${CYCLE_STATUS[cycle.status]})`],
    [{ text: 'Cargo', style: 'label' }, `${cl.cargo_title}`, { text: 'Código', style: 'label' }, cl.cargo_code],
    [{ text: 'Área', style: 'label' }, cl.area, { text: 'Matriz', style: 'label' }, comps.version ? `Versão ${comps.version.number} de ${fmtDate(comps.version.version_date)}` : '—'],
    [{ text: 'Gestor avaliador', style: 'label' }, isSelf ? 'Autoverificação, validada por terceiro' : `${cl.evaluator_name}${cl.evaluator_cargo_short ? ` (${cl.evaluator_cargo_short})` : ''}`,
      { text: 'Status', style: 'label' }, CHECKLIST_STATUS[cl.status]],
    [{ text: 'Período do ciclo', style: 'label' }, `${fmtDate(cycle.start_date)} a ${fmtDate(cycle.end_date)}`,
      { text: 'Prazos', style: 'label' }, `Auto ${fmtDate(cycle.self_deadline)} · Gestor ${fmtDate(cycle.manager_deadline)} · Assinaturas ${fmtDate(cycle.feedback_deadline)}`],
    [{ text: 'Autoavaliação', style: 'label' }, isSelf ? 'Não se aplica' : (evals.auto && evals.auto.submitted_at ? `Enviada em ${fmtDateTime(evals.auto.submitted_at)}` : 'Pendente'),
      { text: isSelf ? 'Autoverificação' : 'Avaliação do gestor', style: 'label' }, evals.gestor && evals.gestor.submitted_at ? `Enviada em ${fmtDateTime(evals.gestor.submitted_at)}` : 'Pendente'],
  ];
  if (isSelf) {
    info.push([{ text: 'Validador', style: 'label' }, cl.validator_name || 'A definir', { text: 'Ata da Diretoria', style: 'label' }, ata.length ? ata.map((a) => a.original_name).join(', ') : 'Não anexada']);
  } else {
    info.push([{ text: 'Resultado liberado', style: 'label' }, cl.results_released_at ? fmtDateTime(cl.results_released_at) : 'Não', { text: 'Fechamento', style: 'label' }, cl.closed_at ? fmtDateTime(cl.closed_at) : '—']);
  }

  const compRows = comps.applicable.map((c) => {
    const a = autoOk ? evals.auto.items[c.code] : null;
    const g = gestorOk ? evals.gestor.items[c.code] : null;
    const aR = a ? a.rating : null;
    const gR = g ? g.rating : null;
    const row = [{ text: c.code, bold: true }, c.name, { text: lvl(c.required), alignment: 'center' }];
    if (!isSelf) row.push({ text: a ? `${aR}` : (access.blockedAsEvaluator ? 'oculta' : '—'), alignment: 'center' });
    row.push({ text: lvl(gR), alignment: 'center' });
    if (!isSelf) row.push({ text: aR != null && gR != null ? `${gR - aR > 0 ? '+' : ''}${gR - aR}` : '—', alignment: 'center' });
    row.push(gapText(c.required, gR));
    return row;
  });
  const compHead = ['Cód.', 'Competência', 'Exigido'].concat(isSelf ? [] : ['Auto']).concat([verLabel]).concat(isSelf ? [] : ['Dif.']).concat(['Situação']);
  const compWidths = isSelf ? [28, '*', 42, 70, 70] : [28, '*', 42, 36, 40, 30, 62];

  const evidenceBlocks = [];
  for (const c of comps.applicable) {
    const a = autoOk ? evals.auto.items[c.code] : null;
    const g = gestorOk ? evals.gestor.items[c.code] : null;
    if (!a && !g) continue;
    const files = (evId) => attachments.filter((f) => f.evaluation_id === evId && f.competency_code === c.code).map((f) => f.original_name);
    const lines = [{ text: `${c.code} ${c.name}`, bold: true, margin: [0, 4, 0, 1] }];
    if (a) {
      const fl = files(evals.auto.id);
      lines.push({ text: [{ text: `Autoavaliação (${a.rating} — ${LEVEL_LABELS[a.rating]}): `, bold: true, color: MUTED }, a.evidence || ''] });
      if (fl.length) lines.push({ text: `Anexos: ${fl.join(', ')}`, style: 'small' });
    }
    if (g) {
      const fl = files(evals.gestor.id);
      lines.push({ text: [{ text: `${verLabel} (${g.rating} — ${LEVEL_LABELS[g.rating]}): `, bold: true, color: MUTED }, g.evidence || ''] });
      if (fl.length) lines.push({ text: `Anexos: ${fl.join(', ')}`, style: 'small' });
    }
    evidenceBlocks.push({ stack: lines, unbreakable: true });
  }

  const showPlan = gestorOk;
  const planRows = showPlan ? actions.map((a) => [
    a.origin === 'lacuna' ? { text: `Lacuna ${a.competency_code}\nexigido ${a.required_level}, verificado ${a.verified_level}`, color: RED } : (ACTION_CATEGORIES[a.category] || 'Livre'),
    a.action || { text: 'Sem ação definida', color: RED },
    a.responsible || '—',
    fmtDate(a.due_date),
    ACTION_STATUS[a.status] + (a.origin === 'livre' ? (a.validated_by ? '' : '\n(aguardando validação)') : ''),
  ]) : [];

  const sigRows = [];
  const sigRow = (label, s) => [label, s ? s.signer_name : 'Pendente', s ? fmtDateTime(s.signed_at) : '—', s && s.comment ? s.comment : (s && s.impersonated_by ? 'Assinatura de teste' : '')];
  sigRows.push(sigRow(isSelf ? 'Titular' : 'Colaborador', sigs.colaborador));
  if (isSelf) {
    if (sigs.validador) sigRows.push(sigRow('Validador', sigs.validador));
    else if (ata.length) sigRows.push(['Validação', 'Ata da Diretoria anexada', fmtDateTime(ata[0].uploaded_at), ata[0].original_name]);
    else sigRows.push(['Validação', 'Pendente', '—', '']);
  } else {
    sigRows.push(sigRow('Gestor', sigs.gestor));
  }

  const content = [
    header('Checklist de Verificação de Competências', `${cycle.name} · ${cl.cargo_code} · ${cl.user_name}`),
    rule(),
    { table: { widths: [78, '*', 78, '*'], body: info }, layout: 'noBorders', fontSize: 9, margin: [0, 0, 0, 4] },
    { text: 'Níveis exigidos e verificados', style: 'h2' },
    { text: 'Escala: 1 — Não atende · 2 — Em desenvolvimento · 3 — Atende ao padrão. Lacuna = nível verificado menor que o exigido.', style: 'small', margin: [0, 0, 0, 4] },
    table(compHead, compRows, compWidths),
  ];
  if (comps.notApplicable.length) content.push({ text: `Não se aplicam ao cargo: ${comps.notApplicable.map((c) => `${c.code} ${c.name}`).join('; ')}.`, style: 'small' });
  if (!gestorOk && access.isOwner && !isSelf) content.push({ text: 'A avaliação do gestor será exibida após a liberação do resultado.', style: 'small', margin: [0, 4, 0, 0] });
  if (evidenceBlocks.length) content.push({ text: 'Evidências', style: 'h2' }, ...evidenceBlocks);
  content.push({ text: 'Plano de ação / PDI', style: 'h2' });
  if (showPlan) {
    content.push({ text: `Lacunas: ${plan.gaps} · com ação, responsável e prazo: ${plan.gapsDefined} · ações concluídas: ${plan.done} de ${plan.total}`, style: 'small', margin: [0, 0, 0, 4] });
    content.push(planRows.length ? table(['Origem', 'Ação acordada', 'Responsável', 'Prazo', 'Status'], planRows, [72, '*', 80, 52, 70]) : { text: 'Sem lacunas e sem ações registradas.', style: 'small' });
    content.push({ text: isSelf ? 'Observações do titular' : 'Observações do gestor', style: 'h3' }, { text: cl.manager_notes || 'Sem observações.' });
  } else {
    content.push({ text: 'Disponível após a avaliação do gestor e a liberação do resultado.', style: 'small' });
  }
  content.push({ text: 'Assinaturas eletrônicas', style: 'h2' });
  content.push(table(['Papel', 'Nome', 'Data e hora (Brasília)', 'Comentário'], sigRows, [70, 110, 110, '*']));
  content.push({ text: 'As assinaturas são confirmações eletrônicas registradas no sistema com nome, data e hora. O histórico de acesso e alterações fica no log do sistema (LGPD).', style: 'small', margin: [0, 6, 0, 0] });

  return render({ content, footer: footer(`${cl.cargo_code} ${cl.user_name}`) });
}

/* ------------------------------------------------------------- relatórios */

function reportSections(report, TABS) {
  const s = {};
  const cov = report.coverage;
  s.visao = [
    { text: TABS.visao, style: 'h2' },
    table(['Indicador', 'Valor'], [
      ['Verificações previstas', `${cov.previstas}`],
      ['Realizadas (avaliações concluídas)', `${cov.realizadas}`],
      ['Cobertura (meta 100%)', fmtPct(cov.cobertura)],
      ['Checklists assinados', `${cov.assinados} (${fmtPct(cov.pctAssinados)})`],
      ['Autoavaliações enviadas', `${cov.autoEnviadas} de ${cov.autoEsperadas}`],
      ['Avaliações do gestor / autoverificações enviadas', `${cov.gestorEnviadas} de ${cov.previstas}`],
      ['Resultados liberados ao colaborador', `${cov.liberados} de ${cov.autoEsperadas}`],
      ['Não iniciadas / em andamento / concluídas / assinadas', `${cov.naoIniciadas} / ${cov.emAndamento} / ${cov.concluidas} / ${cov.assinados}`],
    ], ['*', 160]),
    { text: 'Pendências', style: 'h3' },
    report.pendencias.all.length
      ? table(['Responsável', 'Pendência', 'Prazo'], report.pendencias.all.map((p) => [p.userName || '—', p.text, fmtDate(p.deadline)]), [100, '*', 60])
      : { text: 'Nenhuma pendência.', style: 'small' },
  ];
  const compCodes = report.comps.map((c) => c.code);
  s.individual = [{ text: TABS.individual, style: 'h2' }];
  for (const r of report.rows) {
    if (!r.autoSent && !r.gestorSent) continue;
    s.individual.push({ text: `${r.cl.user_name} — ${r.cl.cargo_code} ${r.cl.cargo_short} · avaliador: ${r.evaluatorLabel} · ${CHECKLIST_STATUS[r.cl.status]}`, style: 'h3' });
    s.individual.push(table(['Competência', 'Exigido', 'Auto', 'Gestor', 'Dif.', 'Lacuna'], r.items.map((i) => [
      `${i.code} ${i.name}`, { text: lvl(i.required), alignment: 'center' }, { text: r.masked ? 'oculta' : lvl(i.auto), alignment: 'center' },
      { text: lvl(i.gestor), alignment: 'center' }, { text: i.diff == null ? '—' : `${i.diff > 0 ? '+' : ''}${i.diff}`, alignment: 'center' },
      gapText(i.required, i.gestor),
    ]), ['*', 45, 45, 45, 40, 70]));
  }
  if (s.individual.length === 1) s.individual.push({ text: 'Nenhuma avaliação enviada ainda.', style: 'small' });
  s.individual.splice(1, 0, table(['Colaborador', 'Cód.', ...compCodes, 'Lacunas'], report.rows.map((r) => [
    r.cl.user_name, r.cl.cargo_code,
    ...report.comps.map((c) => {
      const it = r.items.find((i) => i.code === c.code);
      if (!it) return { text: '—', alignment: 'center', color: MUTED };
      if (it.gestor == null) return { text: '·', alignment: 'center', color: MUTED };
      return { text: `${it.gestor}`, alignment: 'center', color: it.gap ? RED : '#1D2433', bold: !!it.gap };
    }),
    { text: r.gestorSent ? `${r.items.filter((i) => i.gap).length}` : '—', alignment: 'center' },
  ]), [70, 28, ...compCodes.map(() => '*'), 40], { fontSize: 8 }));
  const g = report.gaps;
  s.lacunas = [
    { text: TABS.lacunas, style: 'h2' },
    { text: `Lacunas: ${g.total} · com ação, responsável e prazo: ${g.pctComAcao == null ? '—' : fmtPct(g.pctComAcao)} · concluídas: ${g.pctConcluidas == null ? '—' : fmtPct(g.pctConcluidas)}`, margin: [0, 0, 0, 6] },
    g.lacunas.length ? table(['Colaborador', 'Cargo', 'Competência', 'Exig. / verif.', 'Ação acordada', 'Responsável', 'Prazo', 'Status'], g.lacunas.map((l) => [
      l.colaborador, l.cargoCode, `${l.competency_code} ${l.competencia}`, { text: `${l.required_level} / ${l.verified_level}`, alignment: 'center' },
      l.action || { text: 'Sem ação definida', color: RED }, l.responsible || '—', fmtDate(l.due_date), ACTION_STATUS[l.status],
    ]), [62, 30, 90, 46, '*', 60, 48, 56]) : { text: 'Nenhuma lacuna registrada.', style: 'small' },
  ];
  if (g.livres.length) {
    s.lacunas.push({ text: 'Ações livres de desenvolvimento', style: 'h3' }, table(['Colaborador', 'Tipo', 'Ação', 'Responsável', 'Prazo', 'Validada', 'Status'], g.livres.map((l) => [
      l.colaborador, ACTION_CATEGORIES[l.category] || '—', l.action || '—', l.responsible || '—', fmtDate(l.due_date), l.validated_by ? 'Sim' : 'Não', ACTION_STATUS[l.status],
    ]), [62, 60, '*', 60, 48, 40, 56]));
  }
  const pctTxt = (v) => (v == null ? '—' : fmtPct(v));
  s.competencia = [
    { text: TABS.competencia, style: 'h2' },
    table(['Competência', 'Avaliadas', 'Atende', 'Lacunas', '% atende', 'Méd. exigida', 'Méd. verificada', 'Méd. auto', 'Dif. média'], report.byCompetency.map((c) => [
      `${c.code} ${c.name}`, `${c.avaliadas}/${c.aplicavel}`, `${c.atende}`, `${c.lacunas}`, pctTxt(c.pctAtende),
      fmtNum(c.mediaExigida), fmtNum(c.mediaVerificada), fmtNum(c.mediaAuto), c.difMedia == null ? '—' : `${c.difMedia > 0 ? '+' : ''}${fmtNum(c.difMedia, 2)}`,
    ]), ['*', 46, 38, 40, 44, 50, 54, 44, 44]),
  ];
  const aggTable = (data, head) => table([head, 'Previstas', 'Realizadas', 'Cobertura', 'Assinados', 'Comp. avaliadas', '% atende', 'Lacunas'],
    data.map((d) => [d.label, `${d.previstas}`, `${d.realizadas}`, pctTxt(d.cobertura), `${d.assinados}`, `${d.avaliadas}`, pctTxt(d.pctAtende), `${d.lacunas}`]),
    ['*', 46, 50, 50, 46, 60, 46, 40]);
  s.cargo = [{ text: TABS.cargo, style: 'h2' }, aggTable(report.byCargo, 'Cargo')];
  s.gestor = [{ text: TABS.gestor, style: 'h2' }, aggTable(report.byGestor, 'Gestor / equipe')];
  s.area = [{ text: TABS.area, style: 'h2' }, aggTable(report.byArea, 'Área')];
  if (report.comparison) {
    const p = report.comparison.previous;
    const c = report.comparison.current;
    s.comparacao = [
      { text: TABS.comparacao, style: 'h2' },
      table(['Indicador', p.cycle.name, c.cycle.name], [
        ['Verificações previstas', `${p.coverage.previstas}`, `${c.coverage.previstas}`],
        ['Cobertura', fmtPct(p.coverage.cobertura), fmtPct(c.coverage.cobertura)],
        ['Assinados', `${p.coverage.assinados}`, `${c.coverage.assinados}`],
        ['% competências que atendem', pctTxt(p.pctAtende), pctTxt(c.pctAtende)],
        ['Lacunas', `${p.lacunas}`, `${c.lacunas}`],
      ], ['*', 100, 100]),
      table(['Competência', `% atende ${p.cycle.name}`, `% atende ${c.cycle.name}`], c.competencias.map((cc) => {
        const pc = p.competencias.find((x) => x.code === cc.code);
        return [`${cc.code} ${cc.name}`, pctTxt(pc ? pc.pctAtende : null), pctTxt(cc.pctAtende)];
      }), ['*', 110, 110]),
    ];
  } else {
    s.comparacao = [{ text: TABS.comparacao, style: 'h2' }, { text: `${report.cycle.name} é o primeiro ciclo: ainda não há base de comparação.`, style: 'small' }];
  }
  return s;
}

function filtersText(report) {
  const f = report.filters;
  const parts = [];
  if (f.area) parts.push(`Área: ${f.area}`);
  if (f.cargo) {
    const r = report.rows.find((x) => String(x.cl.cargo_id) === String(f.cargo));
    parts.push(`Cargo: ${r ? `${r.cl.cargo_code} ${r.cl.cargo_short}` : f.cargo}`);
  }
  if (f.gestor) {
    const r = report.rows.find((x) => String(x.cl.evaluator_user_id) === String(f.gestor));
    parts.push(`Gestor: ${f.gestor === 'auto' ? 'Autoverificação' : (r ? r.cl.evaluator_name : f.gestor)}`);
  }
  return parts.length ? parts.join(' · ') : 'Sem filtros (empresa toda)';
}

async function reportPdf(report, section, TABS) {
  await loadLogo();
  const sections = reportSections(report, TABS);
  const keys = section === 'todas' ? Object.keys(TABS) : [section];
  const content = [
    header('Relatório de Verificação de Competências', `${report.cycle.name} · matriz ${report.version ? `Versão ${report.version.number}` : '—'}`),
    rule(true),
    { text: filtersText(report), style: 'sub', margin: [0, 0, 0, 4] },
  ];
  keys.forEach((k, i) => {
    const block = sections[k] || [];
    if (i > 0 && section === 'todas') block[0] = { ...block[0], pageBreak: 'before' };
    content.push(...block);
  });
  return render({ pageOrientation: 'landscape', content, footer: footer(report.cycle.name) });
}

async function sgiPdf(cycle, data) {
  await loadLogo();
  const cov = data.coverage;
  // pdfmake altera os nós durante o layout: cada célula precisa de um objeto novo
  const yes = () => ({ text: 'Sim', color: GREEN, bold: true });
  const no = () => ({ text: 'Não', color: MUTED });
  const content = [
    header('Evidência — Registro SGI E3.3.1, item 7', `Competência por função · ${cycle.name}`),
    rule(),
    { text: 'A InterExpress define, verifica e desenvolve a competência exigida de cada função:', margin: [0, 0, 0, 4] },
    { ul: [
      `Define: matriz de competências por cargo ${data.version ? `(Versão ${data.version.number} de ${fmtDate(data.version.version_date)})` : ''}, com nível exigido e critérios de cada nível.`,
      'Verifica: checklist individual por colaborador e cargo, com autoavaliação, avaliação do gestor (ou autoverificação validada por terceiro), evidência em cada nota e assinaturas eletrônicas.',
      'Desenvolve: plano de ação para 100% das lacunas, com ação, responsável e prazo, acompanhado até a conclusão.',
    ], margin: [0, 0, 0, 6] },
    { text: 'Cobertura do ciclo', style: 'h2' },
    table(['Verificações previstas', 'Realizadas', 'Cobertura (meta 100%)', 'Assinados', 'Lacunas com ação definida', 'Ações de lacuna concluídas'], [[
      `${cov.previstas}`, `${cov.realizadas}`, fmtPct(cov.cobertura), `${cov.assinados} (${fmtPct(cov.pctAssinados)})`,
      data.gaps.pctComAcao == null ? 'Sem lacunas' : fmtPct(data.gaps.pctComAcao), data.gaps.pctConcluidas == null ? '—' : fmtPct(data.gaps.pctConcluidas),
    ]]),
    { text: 'Status dos fechamentos', style: 'h2' },
    table(['Cód.', 'Colaborador', 'Cargo', 'Avaliador', 'Avaliações', 'Plano completo', 'Status', 'Fechado em'], data.rows.map((r) => [
      r.code, r.colaborador, r.cargo, r.selfVerification ? `${r.avaliador}\n${r.validacao}` : r.avaliador, r.avaliacoes ? yes() : no(),
      r.planoCompleto == null ? { text: '—', color: MUTED } : (r.planoCompleto ? yes() : no()), CHECKLIST_STATUS[r.status], r.closedAt ? fmtDateTime(r.closedAt) : '—',
    ]), [26, 56, 90, '*', 48, 48, 56, 70], { fontSize: 8 }),
    { text: 'Documento sem notas individuais. Os checklists individuais assinados ficam disponíveis no sistema para auditoria.', style: 'small', margin: [0, 6, 0, 0] },
  ];
  return render({ content, footer: footer(cycle.name) });
}

module.exports = { checklistPdf, reportPdf, sgiPdf, svgLogoWorks };
