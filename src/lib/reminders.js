'use strict';
// Lembretes por e-mail: manuais (RH/administradora) e automáticos (prazo próximo e pendências).
const dbm = require('../db');
const domain = require('./domain');
const mailer = require('./mailer');
const tasks = require('./tasks');
const { todayLocal, daysBetween, nowIso } = require('./util');

function earliest(items) {
  return items.map((i) => i.deadline).filter(Boolean).sort()[0] || null;
}

async function sendReminder(userId, items, titulo = 'pendências na Verificação de Competências') {
  const user = domain.getUser(userId);
  if (!user || !user.active || !items.length) return null;
  return mailer.queue(mailer.templates.lembrete(user, { titulo, itens: items.map((i) => i.text), prazo: earliest(items) }));
}

/** Envia lembrete a todos com pendência (ou só aos ids informados). */
async function sendManualReminders(cycle, userIds = null) {
  const groups = tasks.groupByUser(tasks.cyclePendencias(cycle))
    .filter((g) => !userIds || userIds.includes(g.userId));
  const results = [];
  for (const g of groups) {
    const r = await sendReminder(g.userId, g.items);
    if (r) results.push({ userId: g.userId, userName: g.userName, status: r.status });
  }
  return results;
}

/** Lembretes automáticos: só funcionam com o sistema no ar (fora do modo de teste). */
async function runAutomatic(now = new Date()) {
  if (dbm.isTestMode()) return [];
  const cycle = domain.currentCycle();
  if (!cycle || cycle.status !== 'em_andamento') return [];
  const db = dbm.get();
  const today = todayLocal(now);
  const perUser = new Map();
  for (const p of tasks.cyclePendencias(cycle)) {
    if (!p.userId || !p.deadline) continue;
    const left = daysBetween(today, p.deadline);
    let key = null;
    let kind = null;
    if (left >= 0 && left <= (cycle.reminder_days || 3)) {
      key = `prazo:${p.type}:${p.checklistId}:${p.userId}:${p.deadline}`;
      kind = 'prazo';
    } else if (left < 0) {
      key = `pendencia:${p.type}:${p.checklistId}:${p.userId}:${Math.floor(-left / 7)}`;
      kind = 'pendencia';
    }
    if (!key || db.prepare('SELECT 1 FROM reminders_sent WHERE key = ?').get(key)) continue;
    if (!perUser.has(p.userId)) perUser.set(p.userId, { items: [], keys: [], kinds: new Set() });
    const g = perUser.get(p.userId);
    g.items.push(p);
    g.keys.push(key);
    g.kinds.add(kind);
  }
  const sent = [];
  for (const [userId, g] of perUser) {
    const titulo = g.kinds.has('pendencia') ? 'há pendências com prazo vencido' : 'prazo próximo na Verificação de Competências';
    const r = await sendReminder(userId, g.items, titulo);
    if (!r) continue;
    for (const k of g.keys) db.prepare('INSERT OR IGNORE INTO reminders_sent (key, sent_at) VALUES (?, ?)').run(k, nowIso());
    sent.push({ userId, status: r.status });
  }
  return sent;
}

module.exports = { sendReminder, sendManualReminders, runAutomatic };
