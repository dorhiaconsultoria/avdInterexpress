'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const dbm = require('./db');
const auth = require('./lib/auth');
const util = require('./lib/util');
const domain = require('./lib/domain');

function buildNav(user) {
  if (!user) return [];
  const cycle = domain.currentCycle();
  const items = [{ href: '/', label: 'Início', key: 'inicio' }];
  if (cycle && domain.isManager(user.id, cycle.id)) items.push({ href: '/equipe', label: 'Minha equipe', key: 'equipe' });
  if (user.is_admin || user.is_rh) items.push({ href: '/acompanhamento', label: 'Acompanhamento', key: 'acompanhamento' });
  if (user.is_admin || user.is_ceo) items.push({ href: '/relatorios', label: 'Relatórios', key: 'relatorios' });
  if (user.is_admin || user.is_ceo || user.is_rh || user.is_sgi) {
    items.push({ href: '/sgi', label: 'Indicadores SGI', key: 'sgi' });
    items.push({ href: '/organograma', label: 'Organograma', key: 'organograma' });
  }
  if (user.is_admin) items.push({ href: '/admin', label: 'Administração', key: 'admin' });
  return items;
}

function createApp() {
  dbm.open();
  require('./db/seed').seedIfEmpty();

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
    next();
  });

  app.use(express.static(path.join(config.root, 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(auth.loadSession);

  app.use((req, res, next) => {
    res.locals.user = req.user;
    res.locals.realUser = req.realUser;
    res.locals.impersonating = req.impersonating;
    res.locals.testMode = dbm.isTestMode();
    res.locals.csrf = req.sessionRow ? req.sessionRow.csrf : '';
    res.locals.getFlash = () => (req.sessionRow ? auth.takeFlash(req) : []);
    res.locals.nav = buildNav(req.user);
    res.locals.path = req.path;
    res.locals.u = util;
    res.locals.logoUrl = dbm.getSetting('logo_file') ? `/logo?v=${dbm.getSetting('logo_version', '1')}` : '/img/logo.svg';
    res.locals.title = '';
    res.locals.allUsers = req.realUser && req.realUser.is_admin && res.locals.testMode
      ? domain.listUsers({ activeOnly: true }) : [];
    next();
  });
  app.use(auth.csrfProtect);

  app.get('/logo', (req, res) => {
    const f = dbm.getSetting('logo_file');
    if (!f) return res.redirect('/img/logo.svg');
    const p = path.join(config.uploadsDir, f);
    if (!fs.existsSync(p)) return res.redirect('/img/logo.svg');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.sendFile(p);
  });

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
    console.error(err);
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `O arquivo é maior que o limite de ${config.maxUploadMb} MB.`
      : (err.expose ? err.message : 'Ocorreu um erro inesperado. Tente novamente.');
    if (req.xhr || (req.headers.accept || '').includes('application/json')) return res.status(err.status || 500).json({ error: message });
    return res.status(err.status || 500).render('error', { title: 'Erro', message });
  });

  require('./lib/scheduler').start();
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Verificação de Competências InterExpress em ${config.appUrl} (porta ${config.port})`);
    if (dbm.isTestMode()) console.log('MODO DE TESTE ativo: nenhum e-mail será enviado.');
  });
}

module.exports = { createApp };
