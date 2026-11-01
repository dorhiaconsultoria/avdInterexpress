'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const dbm = require('./db');
const auth = require('./lib/auth');
const util = require('./lib/util');
const domain = require('./lib/domain');
const { wrap } = require('./lib/async-router');

async function buildNav(user) {
  if (!user) return [];
  const cycle = await domain.currentCycle();
  const items = [{ href: '/', label: 'Início', key: 'inicio' }];
  if (cycle && await domain.isManager(user.id, cycle.id)) items.push({ href: '/equipe', label: 'Minha equipe', key: 'equipe' });
  if (user.is_admin || user.is_rh) items.push({ href: '/acompanhamento', label: 'Acompanhamento', key: 'acompanhamento' });
  if (user.is_admin || user.is_ceo) items.push({ href: '/relatorios', label: 'Relatórios', key: 'relatorios' });
  if (user.is_admin || user.is_ceo || user.is_rh || user.is_sgi) {
    items.push({ href: '/sgi', label: 'Indicadores SGI', key: 'sgi' });
    items.push({ href: '/organograma', label: 'Organograma', key: 'organograma' });
  }
  if (user.is_admin) items.push({ href: '/admin', label: 'Administração', key: 'admin' });
  return items;
}

/** Valores mínimos para as páginas renderizarem (inclusive a página de erro). */
function defaultLocals(res) {
  Object.assign(res.locals, {
    user: null, realUser: null, impersonating: false, testMode: false, csrf: '', getFlash: () => [],
    nav: [], path: '', u: util, logoUrl: '/img/logo.svg', title: '', allUsers: [],
  });
}

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
    });
    defaultLocals(res);
    next();
  });

  app.use(express.static(path.join(config.root, 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '1mb' }));

  // Banco pronto (tabelas e carga inicial) antes de qualquer página
  app.use(wrap(async (req, res, next) => {
    await dbm.ready();
    next();
  }));

  // Lembretes automáticos disparados pela agenda do Vercel (Cron Jobs)
  app.get('/cron/lembretes', wrap(async (req, res) => {
    // Com CRON_SECRET definido, o Vercel envia "Authorization: Bearer <segredo>". Sem ele, aceita só a agenda do Vercel.
    const secret = process.env.CRON_SECRET;
    const ok = secret
      ? req.get('authorization') === `Bearer ${secret}`
      : (!process.env.VERCEL || String(req.get('user-agent') || '').startsWith('vercel-cron'));
    if (!ok) return res.status(401).json({ error: 'não autorizado' });
    const sent = await require('./lib/reminders').runAutomatic();
    return res.json({ ok: true, enviados: sent.length });
  }));

  app.use(auth.loadSession);

  app.use(wrap(async (req, res, next) => {
    const testMode = await dbm.isTestMode();
    const logoFile = await dbm.getSetting('logo_file');
    Object.assign(res.locals, {
      user: req.user,
      realUser: req.realUser,
      impersonating: req.impersonating,
      testMode,
      csrf: req.sessionRow ? req.sessionRow.csrf : '',
      getFlash: () => (req.sessionRow ? auth.takeFlash(req) : []),
      nav: await buildNav(req.user),
      path: req.path,
      logoUrl: logoFile ? `/logo?v=${await dbm.getSetting('logo_version', '1')}` : '/img/logo.svg',
      allUsers: req.realUser && req.realUser.is_admin && testMode ? await domain.listUsers({ activeOnly: true }) : [],
    });
    next();
  }));
  app.use(auth.csrfProtect);

  app.get('/logo', wrap(async (req, res) => {
    const row = await dbm.get("SELECT mime, data FROM app_files WHERE key = 'logo'");
    if (!row) return res.redirect('/img/logo.svg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Content-Type', row.mime || 'application/octet-stream');
    return res.send(row.data);
  }));

  app.use(require('./routes/auth'));
  app.use(auth.requireLogin);
  app.use(require('./routes/home'));
  app.use(require('./routes/checklists'));
  app.use(require('./routes/acompanhamento'));
  app.use(require('./routes/relatorios'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => res.status(404).render('error', { title: 'Página não encontrada', message: 'O endereço acessado não existe.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (!(err instanceof dbm.ConfigError)) console.error(err);
    let message = err.expose ? err.message : 'Ocorreu um erro inesperado. Tente novamente.';
    if (err.code === 'LIMIT_FILE_SIZE') message = `O arquivo é maior que o limite de ${config.maxUploadMb} MB.`;
    if (err instanceof dbm.ConfigError) message = err.message;
    const status = err instanceof dbm.ConfigError ? 503 : (err.status || 500);
    if (req.xhr || (req.headers.accept || '').includes('application/json')) return res.status(status).json({ error: message });
    return res.status(status).render('error', { title: err instanceof dbm.ConfigError ? 'Configuração pendente' : 'Erro', message });
  });

  if (!process.env.VERCEL) require('./lib/scheduler').start();
  return app;
}

if (require.main === module) {
  const app = createApp();
  dbm.ready().then(async () => {
    app.listen(config.port, async () => {
      console.log(`Verificação de Competências InterExpress em ${config.appUrl} (porta ${config.port})`);
      if (await dbm.isTestMode()) console.log('MODO DE TESTE ativo: nenhum e-mail será enviado.');
    });
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { createApp };
