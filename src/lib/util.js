'use strict';
const crypto = require('crypto');
const config = require('../config');

const TZ = config.timezone;

function nowIso() {
  return new Date().toISOString();
}

/** Data de hoje (AAAA-MM-DD) no fuso de São Paulo. */
function todayLocal(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 'AAAA-MM-DD' -> 'DD/MM/AAAA' */
function fmtDate(d) {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-');
  if (!y || !m || !day) return s;
  return `${day}/${m}/${y}`;
}

/** ISO -> 'DD/MM/AAAA às HH:MM' (horário de Brasília) */
function fmtDateTime(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return String(iso);
  const d = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(dt);
  const t = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(dt);
  return `${d} às ${t}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** Diferença em dias entre duas datas AAAA-MM-DD (b - a). */
function daysBetween(a, b) {
  const da = Date.UTC(...a.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  const dbb = Date.UTC(...b.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  return Math.round((dbb - da) / 86400000);
}

function isValidDate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function fmtPct(v) {
  return `${String(v).replace('.', ',')}%`;
}

function fmtNum(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  return Number(v).toFixed(digits).replace('.', ',');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LEVEL_LABELS = {
  1: 'Não atende',
  2: 'Em desenvolvimento',
  3: 'Atende ao padrão',
};

const LEVEL_DESCRIPTIONS = {
  1: 'Não domina a competência. Depende de outra pessoa para executar.',
  2: 'Executa com supervisão ou conferência.',
  3: 'Executa com autonomia. É o nível esperado nas competências centrais do cargo.',
};

const CHECKLIST_STATUS = {
  nao_iniciada: 'Não iniciada',
  em_andamento: 'Em andamento',
  concluida: 'Concluída',
  assinada: 'Assinada',
};

const ACTION_STATUS = {
  nao_iniciada: 'Não iniciada',
  em_andamento: 'Em andamento',
  concluida: 'Concluída',
};

const ACTION_CATEGORIES = {
  curso: 'Curso / treinamento',
  mentoria: 'Mentoria',
  projeto: 'Projeto',
  leitura: 'Leitura',
  pratica: 'Prática supervisionada',
  outro: 'Outro',
};

const CYCLE_STATUS = {
  planejamento: 'Em planejamento',
  em_andamento: 'Em andamento',
  encerrado: 'Encerrado',
};

const EVAL_STATUS = {
  pendente: 'Pendente',
  rascunho: 'Rascunho',
  enviada: 'Enviada',
};

const STATUS_CLASS = { nao_iniciada: 'neutral', em_andamento: 'info', concluida: 'warn', assinada: 'success' };
const STATUS_ICON = { nao_iniciada: '○', em_andamento: '◐', concluida: '●', assinada: '✓' };

function statusBadge(status) {
  return `<span class="badge badge-${STATUS_CLASS[status] || 'neutral'}"><span aria-hidden="true">${STATUS_ICON[status] || ''}</span> ${escapeHtml(CHECKLIST_STATUS[status] || status)}</span>`;
}

function evalBadge(status) {
  const map = { pendente: ['neutral', '○', 'Pendente'], rascunho: ['info', '◐', 'Rascunho'], enviada: ['success', '✓', 'Enviada'] };
  const [cls, icon, label] = map[status] || map.pendente;
  return `<span class="badge badge-${cls}"><span aria-hidden="true">${icon}</span> ${label}</span>`;
}

function actionBadge(status) {
  const map = { nao_iniciada: ['neutral', '○'], em_andamento: ['info', '◐'], concluida: ['success', '✓'] };
  const [cls, icon] = map[status] || map.nao_iniciada;
  return `<span class="badge badge-${cls}"><span aria-hidden="true">${icon}</span> ${escapeHtml(ACTION_STATUS[status] || status)}</span>`;
}

function levelChip(n) {
  if (n == null) return '<span class="lvl lvl-na" title="Não se aplica">—</span>';
  return `<span class="lvl lvl-${Number(n)}" title="${escapeHtml(LEVEL_LABELS[n] || '')}">${Number(n)}</span>`;
}

function gapBadge(required, verified) {
  if (verified == null || required == null) return '<span class="muted">—</span>';
  if (verified >= required) return '<span class="badge badge-success"><span aria-hidden="true">✓</span> Atende</span>';
  return `<span class="badge badge-danger"><span aria-hidden="true">!</span> Lacuna (${verified - required})</span>`;
}

function diffText(d) {
  if (d == null) return '—';
  if (d === 0) return '0';
  return d > 0 ? `+${d}` : String(d);
}

/** Prazo com contagem de dias: "até 13/11/2026 · faltam 12 dias". */
function deadline(d) {
  if (!d) return '<span class="muted">sem prazo</span>';
  const left = daysBetween(todayLocal(), String(d).slice(0, 10));
  let extra;
  let cls = 'due';
  if (left > 1) extra = `faltam ${left} dias`;
  else if (left === 1) { extra = 'vence amanhã'; cls = 'due due-soon'; }
  else if (left === 0) { extra = 'vence hoje'; cls = 'due due-soon'; }
  else { extra = `vencido há ${-left} dia${left === -1 ? '' : 's'}`; cls = 'due due-late'; }
  if (left > 1 && left <= 3) cls = 'due due-soon';
  return `<span class="${cls}">até ${fmtDate(d)} · ${extra}</span>`;
}

module.exports = {
  deadline,
  statusBadge,
  evalBadge,
  actionBadge,
  levelChip,
  gapBadge,
  diffText,
  nowIso,
  todayLocal,
  fmtDate,
  fmtDateTime,
  fmtTime,
  daysBetween,
  isValidDate,
  pct,
  fmtPct,
  fmtNum,
  randomToken,
  sha256,
  escapeHtml,
  LEVEL_LABELS,
  LEVEL_DESCRIPTIONS,
  CHECKLIST_STATUS,
  ACTION_STATUS,
  ACTION_CATEGORIES,
  CYCLE_STATUS,
  EVAL_STATUS,
};
