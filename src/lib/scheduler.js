'use strict';
// Agenda simples: verifica lembretes automáticos a cada hora (somente com o sistema no ar).
const reminders = require('./reminders');

let timer = null;

function start() {
  if (timer || process.env.DISABLE_SCHEDULER === '1') return;
  const tick = () => reminders.runAutomatic().catch((err) => console.error('Lembretes automáticos:', err));
  setTimeout(tick, 60 * 1000).unref();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
}

module.exports = { start };
