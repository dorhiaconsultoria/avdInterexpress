'use strict';
// Teste de ponta a ponta do fluxo principal, das permissões por perfil e do modo de teste.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, Client } = require('./helpers');

setupEnv();
const { createApp } = require('../src/server');
const dbm = require('../src/db');

let server;
let base;
const db = () => dbm.get();
const userId = (name) => db().prepare('SELECT id FROM users WHERE name = ?').get(name).id;
const checklistOf = (code) => db().prepare('SELECT cl.id FROM checklists cl JOIN cargos c ON c.id = cl.cargo_id WHERE c.code = ? ORDER BY cl.id DESC').get(code).id;
const statusOf = (id) => db().prepare('SELECT status FROM checklists WHERE id = ?').get(id).status;
const applicable = (code) => db().prepare(`SELECT ml.competency_code AS c FROM matrix_levels ml JOIN cargos ca ON ca.id = ml.cargo_id
  JOIN matrix_versions v ON v.id = ml.version_id WHERE v.status = 'vigente' AND ca.code = ? AND ml.required_level IS NOT NULL ORDER BY ml.competency_code`).all(code).map((r) => r.c);

const admin = { email: 'bianca@interexpress.test', senha: 'NovaSenha123' };

async function loginAdmin() {
  const c = new Client(base);
  await c.get('/login');
  const r = await c.post('/login', { email: admin.email, senha: admin.senha });
  assert.equal(r.status, 302);
  await c.get('/');
  return c;
}

async function actAs(c, name) {
  const r = await c.post('/admin/entrar-como', { user_id: userId(name) });
  assert.equal(r.status, 302, `entrar como ${name}`);
  await c.get('/');
}

async function back(c) {
  await c.post('/admin/sair-entrar-como');
  await c.get('/');
}

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
});

test('carga inicial: 15 pessoas, 16 verificações, matriz V1 e 3 exemplos', () => {
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM users').get().n, 15);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM checklists').get().n, 16);
  const v = db().prepare("SELECT * FROM matrix_versions WHERE status = 'vigente'").get();
  assert.equal(v.number, 1);
  assert.equal(v.version_date, '2026-10-14');
  assert.equal(statusOf(checklistOf('F15')), 'assinada');
  assert.equal(statusOf(checklistOf('F16')), 'concluida');
  assert.equal(statusOf(checklistOf('F13')), 'em_andamento');
  // Dhiego: dois checklists de autoverificação
  const dh = db().prepare('SELECT * FROM checklists WHERE user_id = ?').all(userId('Dhiego'));
  assert.equal(dh.length, 2);
  assert.ok(dh.every((c) => c.self_verification === 1));
  // C10 não se aplica a F08..F16
  assert.ok(!applicable('F16').includes('C10'));
  assert.ok(applicable('F07').includes('C10'));
});

test('primeiro acesso da administradora exige troca de senha', async () => {
  const c = new Client(base);
  await c.get('/login');
  const bad = await c.post('/login', { email: admin.email, senha: 'errada' });
  assert.equal(bad.status, 401);
  const r = await c.post('/login', { email: admin.email, senha: 'Teste@2026' });
  assert.equal(r.status, 302);
  assert.match(r.location, /\/conta\?primeiro=1/);
  const home = await c.get('/');
  assert.equal(home.status, 302);
  await c.get('/conta?primeiro=1');
  const ch = await c.post('/conta/senha', { atual: 'Teste@2026', senha: admin.senha, confirmacao: admin.senha });
  assert.equal(ch.status, 302);
  const ok = await c.get('/');
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Olá, Bianca/);
  assert.match(ok.text, /MODO DE TESTE/);
});

test('sem CSRF a alteração é recusada', async () => {
  const c = await loginAdmin();
  c.csrf = 'invalido';
  const r = await c.post('/admin/teste/apagar');
  assert.equal(r.status, 403);
  assert.equal(statusOf(checklistOf('F15')), 'assinada');
});

test('relatórios e exportações (administradora)', async () => {
  const c = await loginAdmin();
  const r = await c.get('/relatorios');
  assert.equal(r.status, 200);
  assert.match(r.text, /verificações previstas/);
  for (const aba of ['individual', 'lacunas', 'competencia', 'cargo', 'gestor', 'area', 'comparacao']) {
    const t = await c.get(`/relatorios?aba=${aba}`);
    assert.equal(t.status, 200, aba);
  }
  const det = await c.get(`/relatorios?aba=individual&checklist=${checklistOf('F15')}`);
  assert.match(det.text, /Karine — F15/);
  const xlsx = await c.get('/relatorios/exportar.xlsx');
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.buffer.subarray(0, 2).toString(), 'PK');
  const pdf = await c.get('/relatorios/exportar.pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
  const cpdf = await c.get(`/checklists/${checklistOf('F15')}/pdf`);
  assert.equal(cpdf.buffer.subarray(0, 4).toString(), '%PDF');
  const sgi = await c.get('/sgi/exportar.pdf');
  assert.equal(sgi.buffer.subarray(0, 4).toString(), '%PDF');
  for (const p of ['/admin', '/admin/teste', '/admin/ciclo', '/admin/pessoas', '/admin/cargos', '/admin/matriz', '/admin/emails', '/admin/log', '/admin/configuracoes', '/organograma', '/acompanhamento', '/sgi', `/admin/pessoas/${userId('Karine')}`]) {
    const x = await c.get(p);
    assert.equal(x.status, 200, p);
  }
});

test('gestor: equipe direta, autoavaliação oculta até enviar, lacunas e assinaturas', async () => {
  const c = await loginAdmin();
  await actAs(c, 'Kellen');
  const equipe = await c.get('/equipe');
  assert.equal(equipe.status, 200);
  for (const n of ['Lucas', 'Felipe', 'Edson', 'Anderson']) assert.match(equipe.text, new RegExp(`<td><strong>${n}</strong>`));
  assert.doesNotMatch(equipe.text, /<td><strong>Karine/);
  // LGPD: não vê checklist fora da equipe direta
  const outra = await c.get(`/checklists/${checklistOf('F15')}`);
  assert.equal(outra.status, 403);

  const lucas = checklistOf('F13');
  const view = await c.get(`/checklists/${lucas}`);
  assert.equal(view.status, 200);
  assert.match(view.text, /fica oculta até você enviar/);

  const form = await c.get(`/checklists/${lucas}/avaliar/gestor`);
  assert.equal(form.status, 200);
  assert.match(form.text, /Nível exigido/);
  const codes = applicable('F13');
  // Rascunho com uma nota sem evidência não pode ser enviado
  await c.postJson(`/checklists/${lucas}/avaliar/gestor/rascunho`, { items: [{ code: codes[0], rating: 2, evidence: '' }] });
  const bad = await c.post(`/checklists/${lucas}/avaliar/gestor/enviar`);
  assert.equal(bad.status, 302);
  assert.match(bad.location, /revisar/);
  assert.equal(db().prepare("SELECT status FROM evaluations WHERE checklist_id = ? AND kind = 'gestor'").get(lucas).status, 'rascunho');

  const items = codes.map((code) => ({ code, rating: code === 'C02' || code === 'C04' ? 2 : 3, evidence: `Fato observado em ${code}.` }));
  const save = await c.postJson(`/checklists/${lucas}/avaliar/gestor/rascunho`, { items });
  assert.equal(save.status, 200);
  assert.equal(JSON.parse(save.text).progress.done, codes.length);
  const rev = await c.get(`/checklists/${lucas}/avaliar/gestor/revisar`);
  assert.equal(rev.status, 200);
  const send = await c.post(`/checklists/${lucas}/avaliar/gestor/enviar`);
  assert.equal(send.status, 302);
  assert.equal(statusOf(lucas), 'concluida');
  const gaps = db().prepare("SELECT * FROM action_items WHERE checklist_id = ? AND origin = 'lacuna'").all(lucas);
  assert.deepEqual(gaps.map((g) => g.competency_code).sort(), ['C02', 'C04']);
  const after = await c.get(`/checklists/${lucas}`);
  assert.doesNotMatch(after.text, /fica oculta até você enviar/);

  // Colaborador ainda não vê o resultado (não liberado)
  await back(c);
  await actAs(c, 'Lucas');
  const lv = await c.get(`/checklists/${lucas}`);
  assert.match(lv.text, /depois que o RH liberar o resultado/);
  const sigTry = await c.post(`/checklists/${lucas}/assinar`, { role: 'colaborador', ciente: '1' });
  assert.equal(sigTry.status, 302);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM signatures WHERE checklist_id = ?').get(lucas).n, 0);

  // Administradora libera o resultado; e-mail fica retido (modo de teste)
  await back(c);
  const before = db().prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'retido_teste'").get().n;
  const rel = await c.post(`/checklists/${lucas}/liberar`);
  assert.equal(rel.status, 302);
  const afterMail = db().prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'retido_teste'").get().n;
  assert.equal(afterMail, before + 1);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'enviado'").get().n, 0);

  // Gestora preenche o plano e assina
  await actAs(c, 'Kellen');
  for (const g of gaps) {
    const u = await c.post(`/checklists/${lucas}/plano/${g.id}`, { action: 'Treinamento prático', responsible: 'Lucas', due_date: '2027-02-26', status: 'nao_iniciada' });
    assert.equal(u.status, 302);
  }
  const sg = await c.post(`/checklists/${lucas}/assinar`, { role: 'gestor', ciente: '1' });
  assert.equal(sg.status, 302);
  assert.equal(statusOf(lucas), 'concluida');
  // Com assinatura, o plano trava
  const locked = await c.post(`/checklists/${lucas}/plano/${gaps[0].id}`, { action: 'Outra', responsible: 'X', due_date: '2027-01-01' });
  assert.equal(locked.status, 403);

  await back(c);
  await actAs(c, 'Lucas');
  const sc = await c.post(`/checklists/${lucas}/assinar`, { role: 'colaborador', ciente: '1', comentario: 'De acordo.' });
  assert.equal(sc.status, 302);
  assert.equal(statusOf(lucas), 'assinada');
  await back(c);
});

test('consulta do SGI não vê notas individuais; RH sem relatórios analíticos', async () => {
  const c = await loginAdmin();
  await actAs(c, 'Jefferson');
  const sgi = await c.get('/sgi');
  assert.equal(sgi.status, 200);
  assert.match(sgi.text, /Status dos fechamentos/);
  assert.doesNotMatch(sgi.text, /class="lvl lvl-/);
  assert.equal((await c.get(`/checklists/${checklistOf('F15')}`)).status, 403);
  assert.equal((await c.get('/relatorios')).status, 403);
  assert.equal((await c.get('/acompanhamento')).status, 403);
  await back(c);

  await actAs(c, 'Lígia');
  assert.equal((await c.get('/acompanhamento')).status, 200);
  assert.equal((await c.get('/relatorios')).status, 403);
  assert.equal((await c.get('/admin/matriz')).status, 403);
  assert.equal((await c.get(`/checklists/${checklistOf('F15')}`)).status, 200); // resultado liberado
  assert.equal((await c.get(`/checklists/${checklistOf('F12')}`)).status, 403); // não liberado
  const before = db().prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'lembrete'").get().n;
  const rem = await c.post('/acompanhamento/lembretes', { todos: '1' });
  assert.equal(rem.status, 302);
  assert.ok(db().prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'lembrete'").get().n > before);
  await back(c);

  await actAs(c, 'Dhiego');
  assert.equal((await c.get('/relatorios')).status, 200);
  const f01 = checklistOf('F01');
  const intro = await c.get(`/checklists/${f01}/avaliar/gestor`);
  assert.match(intro.text, /Antes de começar/);
  await back(c);
});

test('autoverificação do CEO fecha com validação por terceiro', async () => {
  const c = await loginAdmin();
  const f01 = checklistOf('F01');
  const v = await c.post(`/checklists/${f01}/validador`, { validator_user_id: userId('Fernanda') });
  assert.equal(v.status, 302);
  await actAs(c, 'Dhiego');
  await c.post(`/checklists/${f01}/avaliar/gestor/iniciar`);
  const codes = applicable('F01');
  await c.postJson(`/checklists/${f01}/avaliar/gestor/rascunho`, { items: codes.map((code) => ({ code, rating: 3, evidence: 'Evidência objetiva.' })) });
  assert.equal((await c.post(`/checklists/${f01}/avaliar/gestor/enviar`)).status, 302);
  assert.equal(statusOf(f01), 'concluida');
  await c.post(`/checklists/${f01}/assinar`, { role: 'colaborador', ciente: '1' });
  assert.equal(statusOf(f01), 'concluida');
  await back(c);
  await actAs(c, 'Fernanda');
  await c.post(`/checklists/${f01}/assinar`, { role: 'validador', ciente: '1', comentario: 'Validado.' });
  assert.equal(statusOf(f01), 'assinada');
  await back(c);
});

test('esqueci minha senha no modo de teste: e-mail retido com link funcional', async () => {
  const c = new Client(base);
  await c.get('/esqueci-senha');
  const r = await c.post('/esqueci-senha', { email: 'karine@interexpress.test' });
  assert.equal(r.status, 200);
  const mail = db().prepare("SELECT * FROM email_outbox WHERE type = 'redefinir_senha' ORDER BY id DESC").get();
  assert.equal(mail.status, 'retido_teste');
  const token = mail.text.match(/redefinir-senha\/([A-Za-z0-9_-]+)/)[1];
  assert.equal((await c.get(`/redefinir-senha/${token}`)).status, 200);
  const done = await c.post(`/redefinir-senha/${token}`, { senha: 'Karine2026x', confirmacao: 'Karine2026x' });
  assert.equal(done.status, 302);
  const home = await c.get('/');
  assert.match(home.text, /Olá, Karine/);
  assert.equal((await c.get('/admin')).status, 403);
});

test('apagar testes mantém cadastros e matriz; matriz versionada; exemplos recarregam', async () => {
  const c = await loginAdmin();
  const users = db().prepare('SELECT COUNT(*) AS n FROM users').get().n;
  // Matriz travada com ciclo em andamento
  const lockedTry = await c.post('/admin/matriz/nova-versao');
  assert.equal(lockedTry.status, 302);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM matrix_versions WHERE status = 'rascunho'").get().n, 0);

  assert.equal((await c.post('/admin/teste/apagar')).status, 302);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM evaluations').get().n, 0);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM users').get().n, users);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM checklists').get().n, 16);
  assert.equal(db().prepare("SELECT status FROM cycles ORDER BY id LIMIT 1").get().status, 'planejamento');

  assert.equal((await c.post('/admin/matriz/nova-versao')).status, 302);
  const draft = db().prepare("SELECT * FROM matrix_versions WHERE status = 'rascunho'").get();
  assert.ok(draft);
  const f13 = db().prepare("SELECT id FROM cargos WHERE code = 'F13'").get().id;
  await c.get('/admin/matriz/rascunho');
  assert.equal((await c.post('/admin/matriz/rascunho', { [`lvl_${f13}_C01`]: '3' })).status, 302);
  const pub = await c.post('/admin/matriz/rascunho/publicar', { version_date: '2026-11-01', notes: 'F13 passa a exigir nível 3 em C01.' });
  assert.equal(pub.status, 302);
  const v2 = db().prepare("SELECT * FROM matrix_versions WHERE status = 'vigente'").get();
  assert.equal(v2.number, 2);
  assert.equal(db().prepare("SELECT status FROM matrix_versions WHERE number = 1").get().status, 'substituida');
  const ver = await c.get(`/admin/matriz/versao/${v2.id}`);
  assert.match(ver.text, /F13 × C01: 2 → 3/);

  assert.equal((await c.post('/admin/teste/exemplos')).status, 302);
  assert.equal(statusOf(checklistOf('F15')), 'assinada');
  assert.equal(db().prepare("SELECT status FROM cycles ORDER BY id LIMIT 1").get().status, 'em_andamento');
});

test('importação de e-mails por CSV', async () => {
  const c = await loginAdmin();
  await c.get('/admin/pessoas');
  const fd = new FormData();
  fd.append('_csrf', c.csrf);
  fd.append('arquivo', new Blob(['Código;Colaborador;E-mail\nF15;Karine;karine.real@interexpress.com.br\nF99;Ninguém;x@y.com\nF01;Dhiego;dhiego.real@interexpress.com.br\nF02;Dhiego;dhiego.real@interexpress.com.br\n'], { type: 'text/csv' }), 'emails.csv');
  const r = await c.req('POST', '/admin/pessoas/importar', { multipart: fd });
  assert.equal(r.status, 302);
  assert.equal(db().prepare('SELECT email FROM users WHERE id = ?').get(userId('Karine')).email, 'karine.real@interexpress.com.br');
  assert.equal(db().prepare('SELECT email FROM users WHERE id = ?').get(userId('Dhiego')).email, 'dhiego.real@interexpress.com.br');
  const page = await c.get('/admin/pessoas?importacao=1');
  assert.match(page.text, /pessoa não encontrada \(F99\)/);
});

test('colocar no ar: exige confirmação, apaga testes e desativa "entrar como"', async () => {
  const c = await loginAdmin();
  const wrong = await c.post('/admin/colocar-no-ar', { confirmacao: 'sim' });
  assert.equal(wrong.status, 302);
  assert.equal(dbm.isTestMode(), true);
  const ok = await c.post('/admin/colocar-no-ar', { confirmacao: 'COLOCAR NO AR' });
  assert.equal(ok.status, 302);
  assert.equal(dbm.isTestMode(), false);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM evaluations').get().n, 0);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL').get().n, 1);
  await c.get('/');
  const imp = await c.post('/admin/entrar-como', { user_id: userId('Kellen') });
  assert.equal(imp.status, 403);
  // Sem SMTP configurado, o envio real registra erro (não fica retido)
  await c.get('/admin/ciclo');
  const cyc = db().prepare("SELECT id FROM cycles ORDER BY id LIMIT 1").get().id;
  const st = await c.post(`/admin/ciclo/${cyc}/iniciar`);
  assert.equal(st.status, 302);
  const abertura = db().prepare("SELECT status, COUNT(*) AS n FROM email_outbox WHERE type = 'abertura' GROUP BY status").all();
  assert.ok(abertura.length && abertura.every((a) => a.status === 'erro'));
});

test('lembretes automáticos (no ar): prazo próximo, sem duplicar', async () => {
  const reminders = require('../src/lib/reminders');
  const cyc = db().prepare("SELECT * FROM cycles WHERE status = 'em_andamento' ORDER BY id LIMIT 1").get();
  assert.ok(cyc);
  // Prazo da autoavaliação daqui a 2 dias (dentro da janela de 3 dias)
  const { todayLocal } = require('../src/lib/util');
  const d = new Date(`${todayLocal()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  const prazo = d.toISOString().slice(0, 10);
  db().prepare('UPDATE cycles SET self_deadline = ? WHERE id = ?').run(prazo, cyc.id);
  const before = db().prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'lembrete'").get().n;
  const sent = await reminders.runAutomatic();
  assert.ok(sent.length > 0);
  const mid = db().prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'lembrete'").get().n;
  assert.equal(mid, before + sent.length);
  const again = await reminders.runAutomatic();
  assert.equal(again.length, 0);
});
