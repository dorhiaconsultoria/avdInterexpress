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
const userId = async (name) => (await dbm.get('SELECT id FROM users WHERE name = ?', name)).id;
const checklistOf = async (code) => (await dbm.get('SELECT cl.id FROM checklists cl JOIN cargos c ON c.id = cl.cargo_id WHERE c.code = ? ORDER BY cl.id DESC', code)).id;
const statusOf = async (id) => (await dbm.get('SELECT status FROM checklists WHERE id = ?', id)).status;
const applicable = async (code) => (await dbm.all(`SELECT ml.competency_code AS c FROM matrix_levels ml JOIN cargos ca ON ca.id = ml.cargo_id
  JOIN matrix_versions v ON v.id = ml.version_id WHERE v.status = 'vigente' AND ca.code = ? AND ml.required_level IS NOT NULL ORDER BY ml.competency_code`, code)).map((r) => r.c);

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
  const r = await c.post('/admin/entrar-como', { user_id: await userId(name) });
  assert.equal(r.status, 302, `entrar como ${name}`);
  await c.get('/');
}

async function back(c) {
  await c.post('/admin/sair-entrar-como');
  await c.get('/');
}

test.before(async () => {
  const app = createApp();
  await dbm.ready();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await dbm.close();
});

test('carga inicial: 15 pessoas, 16 verificações, matriz V1 e 3 exemplos', async () => {
  assert.equal((await dbm.get('SELECT COUNT(*) AS n FROM users')).n, 15);
  assert.equal((await dbm.get('SELECT COUNT(*) AS n FROM checklists')).n, 16);
  const v = await dbm.get("SELECT * FROM matrix_versions WHERE status = 'vigente'");
  assert.equal(v.number, 1);
  assert.equal(v.version_date, '2026-10-14');
  assert.equal(await statusOf(await checklistOf('F15')), 'assinada');
  assert.equal(await statusOf(await checklistOf('F16')), 'concluida');
  assert.equal(await statusOf(await checklistOf('F13')), 'em_andamento');
  // Dhiego: dois checklists de autoverificação
  const dh = await dbm.all('SELECT * FROM checklists WHERE user_id = ?', await userId('Dhiego'));
  assert.equal(dh.length, 2);
  assert.ok(dh.every((c) => c.self_verification === 1));
  // C10 não se aplica a F08..F16
  assert.ok(!(await applicable('F16')).includes('C10'));
  assert.ok((await applicable('F07')).includes('C10'));
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
  assert.equal(await statusOf(await checklistOf('F15')), 'assinada');
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
  const det = await c.get(`/relatorios?aba=individual&checklist=${await checklistOf('F15')}`);
  assert.match(det.text, /Karine — F15/);
  const xlsx = await c.get('/relatorios/exportar.xlsx');
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.buffer.subarray(0, 2).toString(), 'PK');
  const pdf = await c.get('/relatorios/exportar.pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
  const cpdf = await c.get(`/checklists/${await checklistOf('F15')}/pdf`);
  assert.equal(cpdf.buffer.subarray(0, 4).toString(), '%PDF');
  const sgi = await c.get('/sgi/exportar.pdf');
  assert.equal(sgi.buffer.subarray(0, 4).toString(), '%PDF');
  for (const p of ['/admin', '/admin/teste', '/admin/ciclo', '/admin/pessoas', '/admin/cargos', '/admin/matriz', '/admin/emails', '/admin/log', '/admin/configuracoes', '/organograma', '/acompanhamento', '/sgi', `/admin/pessoas/${await userId('Karine')}`]) {
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
  const outra = await c.get(`/checklists/${await checklistOf('F15')}`);
  assert.equal(outra.status, 403);

  const lucas = await checklistOf('F13');
  const view = await c.get(`/checklists/${lucas}`);
  assert.equal(view.status, 200);
  assert.match(view.text, /fica oculta até você enviar/);

  const form = await c.get(`/checklists/${lucas}/avaliar/gestor`);
  assert.equal(form.status, 200);
  assert.match(form.text, /Nível exigido/);
  const codes = await applicable('F13');
  // Rascunho com uma nota sem evidência não pode ser enviado
  await c.postJson(`/checklists/${lucas}/avaliar/gestor/rascunho`, { items: [{ code: codes[0], rating: 2, evidence: '' }] });
  const bad = await c.post(`/checklists/${lucas}/avaliar/gestor/enviar`);
  assert.equal(bad.status, 302);
  assert.match(bad.location, /revisar/);
  assert.equal((await dbm.get("SELECT status FROM evaluations WHERE checklist_id = ? AND kind = 'gestor'", lucas)).status, 'rascunho');

  const items = codes.map((code) => ({ code, rating: code === 'C02' || code === 'C04' ? 2 : 3, evidence: `Fato observado em ${code}.` }));
  const save = await c.postJson(`/checklists/${lucas}/avaliar/gestor/rascunho`, { items });
  assert.equal(save.status, 200);
  assert.equal(JSON.parse(save.text).progress.done, codes.length);
  const rev = await c.get(`/checklists/${lucas}/avaliar/gestor/revisar`);
  assert.equal(rev.status, 200);
  const send = await c.post(`/checklists/${lucas}/avaliar/gestor/enviar`);
  assert.equal(send.status, 302);
  assert.equal(await statusOf(lucas), 'concluida');
  const gaps = await dbm.all("SELECT * FROM action_items WHERE checklist_id = ? AND origin = 'lacuna'", lucas);
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
  assert.equal((await dbm.get('SELECT COUNT(*) AS n FROM signatures WHERE checklist_id = ?', lucas)).n, 0);

  // Administradora libera o resultado; e-mail fica retido (modo de teste)
  await back(c);
  const before = (await dbm.get("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'retido_teste'")).n;
  const rel = await c.post(`/checklists/${lucas}/liberar`);
  assert.equal(rel.status, 302);
  const afterMail = (await dbm.get("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'retido_teste'")).n;
  assert.equal(afterMail, before + 1);
  assert.equal((await dbm.get("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'enviado'")).n, 0);

  // Gestora preenche o plano e assina
  await actAs(c, 'Kellen');
  for (const g of gaps) {
    const u = await c.post(`/checklists/${lucas}/plano/${g.id}`, { action: 'Treinamento prático', responsible: 'Lucas', due_date: '2027-02-26', status: 'nao_iniciada' });
    assert.equal(u.status, 302);
  }
  const sg = await c.post(`/checklists/${lucas}/assinar`, { role: 'gestor', ciente: '1' });
  assert.equal(sg.status, 302);
  assert.equal(await statusOf(lucas), 'concluida');
  // Com assinatura, o plano trava
  const locked = await c.post(`/checklists/${lucas}/plano/${gaps[0].id}`, { action: 'Outra', responsible: 'X', due_date: '2027-01-01' });
  assert.equal(locked.status, 403);

  await back(c);
  await actAs(c, 'Lucas');
  const sc = await c.post(`/checklists/${lucas}/assinar`, { role: 'colaborador', ciente: '1', comentario: 'De acordo.' });
  assert.equal(sc.status, 302);
  assert.equal(await statusOf(lucas), 'assinada');
  await back(c);
});

test('consulta do SGI não vê notas individuais; RH sem relatórios analíticos', async () => {
  const c = await loginAdmin();
  await actAs(c, 'Jefferson');
  const sgi = await c.get('/sgi');
  assert.equal(sgi.status, 200);
  assert.match(sgi.text, /Status dos fechamentos/);
  assert.doesNotMatch(sgi.text, /class="lvl lvl-/);
  assert.equal((await c.get(`/checklists/${await checklistOf('F15')}`)).status, 403);
  assert.equal((await c.get('/relatorios')).status, 403);
  assert.equal((await c.get('/acompanhamento')).status, 403);
  await back(c);

  await actAs(c, 'Lígia');
  assert.equal((await c.get('/acompanhamento')).status, 200);
  assert.equal((await c.get('/relatorios')).status, 403);
  assert.equal((await c.get('/admin/matriz')).status, 403);
  assert.equal((await c.get(`/checklists/${await checklistOf('F15')}`)).status, 200); // resultado liberado
  assert.equal((await c.get(`/checklists/${await checklistOf('F12')}`)).status, 403); // não liberado
  const before = (await dbm.get("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'lembrete'")).n;
  const rem = await c.post('/acompanhamento/lembretes', { todos: '1' });
  assert.equal(rem.status, 302);
  assert.ok((await dbm.get("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'lembrete'")).n > before);
  await back(c);

  await actAs(c, 'Dhiego');
  assert.equal((await c.get('/relatorios')).status, 200);
  const f01 = await checklistOf('F01');
  const intro = await c.get(`/checklists/${f01}/avaliar/gestor`);
  assert.match(intro.text, /Antes de começar/);
  await back(c);
});

test('autoverificação do CEO fecha com validação por terceiro', async () => {
  const c = await loginAdmin();
  const f01 = await checklistOf('F01');
  const v = await c.post(`/checklists/${f01}/validador`, { validator_user_id: await userId('Fernanda') });
  assert.equal(v.status, 302);
  await actAs(c, 'Dhiego');
  await c.post(`/checklists/${f01}/avaliar/gestor/iniciar`);
  const codes = await applicable('F01');
  await c.postJson(`/checklists/${f01}/avaliar/gestor/rascunho`, { items: codes.map((code) => ({ code, rating: 3, evidence: 'Evidência objetiva.' })) });
  assert.equal((await c.post(`/checklists/${f01}/avaliar/gestor/enviar`)).status, 302);
  assert.equal(await statusOf(f01), 'concluida');
  await c.post(`/checklists/${f01}/assinar`, { role: 'colaborador', ciente: '1' });
  assert.equal(await statusOf(f01), 'concluida');
  await back(c);
  await actAs(c, 'Fernanda');
  await c.post(`/checklists/${f01}/assinar`, { role: 'validador', ciente: '1', comentario: 'Validado.' });
  assert.equal(await statusOf(f01), 'assinada');
  await back(c);
});

test('esqueci minha senha no modo de teste: e-mail retido com link funcional', async () => {
  const c = new Client(base);
  await c.get('/esqueci-senha');
  const r = await c.post('/esqueci-senha', { email: 'karine@interexpress.test' });
  assert.equal(r.status, 200);
  const mail = await dbm.get("SELECT * FROM email_outbox WHERE type = 'redefinir_senha' ORDER BY id DESC");
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
  const users = (await dbm.get('SELECT COUNT(*) AS n FROM users')).n;
  // Matriz travada com ciclo em andamento
  const lockedTry = await c.post('/admin/matriz/nova-versao');
  assert.equal(lockedTry.status, 302);
  assert.equal((await dbm.get("SELECT COUNT(*) AS n FROM matrix_versions WHERE status = 'rascunho'")).n, 0);

  assert.equal((await c.post('/admin/teste/apagar')).status, 302);
  assert.equal((await dbm.get('SELECT COUNT(*) AS n FROM evaluations')).n, 0);
  assert.equal((await dbm.get('SELECT COUNT(*) AS n FROM users')).n, users);
  assert.equal((await dbm.get('SELECT COUNT(*) AS n FROM checklists')).n, 16);
  assert.equal((await dbm.get("SELECT status FROM cycles ORDER BY id LIMIT 1")).status, 'planejamento');

  assert.equal((await c.post('/admin/matriz/nova-versao')).status, 302);
  const draft = await dbm.get("SELECT * FROM matrix_versions WHERE status = 'rascunho'");
  assert.ok(draft);
  const f13 = (await dbm.get("SELECT id FROM cargos WHERE code = 'F13'")).id;
  await c.get('/admin/matriz/rascunho');
  assert.equal((await c.post('/admin/matriz/rascunho', { [`lvl_${f13}_C01`]: '3' })).status, 302);
  const pub = await c.post('/admin/matriz/rascunho/publicar', { version_date: '2026-11-01', notes: 'F13 passa a exigir nível 3 em C01.' });
  assert.equal(pub.status, 302);
  const v2 = await dbm.get("SELECT * FROM matrix_versions WHERE status = 'vigente'");
  assert.equal(v2.number, 2);
  assert.equal((await dbm.get("SELECT status FROM matrix_versions WHERE number = 1")).status, 'substituida');
  const ver = await c.get(`/admin/matriz/versao/${v2.id}`);
  assert.match(ver.text, /F13 × C01: 2 → 3/);

  assert.equal((await c.post('/admin/teste/exemplos')).status, 302);
  assert.equal(await statusOf(await checklistOf('F15')), 'assinada');
  assert.equal((await dbm.get("SELECT status FROM cycles ORDER BY id LIMIT 1")).status, 'em_andamento');
});

test('importação de e-mails por CSV', async () => {
  const c = await loginAdmin();
  await c.get('/admin/pessoas');
  const fd = new FormData();
  fd.append('_csrf', c.csrf);
  fd.append('arquivo', new Blob(['Código;Colaborador;E-mail\nF15;Karine;karine.real@interexpress.com.br\nF99;Ninguém;x@y.com\nF01;Dhiego;dhiego.real@interexpress.com.br\nF02;Dhiego;dhiego.real@interexpress.com.br\n'], { type: 'text/csv' }), 'emails.csv');
  const r = await c.req('POST', '/admin/pessoas/importar', { multipart: fd });
  assert.equal(r.status, 302);
  assert.equal((await dbm.get('SELECT email FROM users WHERE id = ?', await userId('Karine'))).email, 'karine.real@interexpress.com.br');
  assert.equal((await dbm.get('SELECT email FROM users WHERE id = ?', await userId('Dhiego'))).email, 'dhiego.real@interexpress.com.br');
  const page = await c.get('/admin/pessoas?importacao=1');
  assert.match(page.text, /pessoa não encontrada \(F99\)/);
});

test('colocar no ar: exige confirmação, apaga testes e desativa "entrar como"', async () => {
  const c = await loginAdmin();
  const wrong = await c.post('/admin/colocar-no-ar', { confirmacao: 'sim' });
  assert.equal(wrong.status, 302);
  assert.equal(await dbm.isTestMode(), true);
  const ok = await c.post('/admin/colocar-no-ar', { confirmacao: 'COLOCAR NO AR' });
  assert.equal(ok.status, 302);
  assert.equal(await dbm.isTestMode(), false);
  assert.equal((await dbm.get('SELECT COUNT(*) AS n FROM evaluations')).n, 0);
  assert.equal((await dbm.get('SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL')).n, 1);
  await c.get('/');
  const imp = await c.post('/admin/entrar-como', { user_id: await userId('Kellen') });
  assert.equal(imp.status, 403);
  // Sem SMTP configurado, o envio real registra erro (não fica retido)
  await c.get('/admin/ciclo');
  const cyc = (await dbm.get("SELECT id FROM cycles ORDER BY id LIMIT 1")).id;
  const st = await c.post(`/admin/ciclo/${cyc}/iniciar`);
  assert.equal(st.status, 302);
  const abertura = await dbm.all("SELECT status, COUNT(*) AS n FROM email_outbox WHERE type = 'abertura' GROUP BY status");
  assert.ok(abertura.length && abertura.every((a) => a.status === 'erro'));
});

test('lembretes automáticos (no ar): prazo próximo, sem duplicar', async () => {
  const reminders = require('../src/lib/reminders');
  const cyc = await dbm.get("SELECT * FROM cycles WHERE status = 'em_andamento' ORDER BY id LIMIT 1");
  assert.ok(cyc);
  // Prazo da autoavaliação daqui a 2 dias (dentro da janela de 3 dias)
  const { todayLocal } = require('../src/lib/util');
  const d = new Date(`${todayLocal()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  const prazo = d.toISOString().slice(0, 10);
  await dbm.run('UPDATE cycles SET self_deadline = ? WHERE id = ?', prazo, cyc.id);
  const before = (await dbm.get("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'lembrete'")).n;
  const sent = await reminders.runAutomatic();
  assert.ok(sent.length > 0);
  const mid = (await dbm.get("SELECT COUNT(*) AS n FROM email_outbox WHERE type = 'lembrete'")).n;
  assert.equal(mid, before + sent.length);
  const again = await reminders.runAutomatic();
  assert.equal(again.length, 0);
});

test('anexos de evidência e logo ficam guardados no banco', async () => {
  // Precisa de um ciclo em andamento: recarrega os exemplos no modo de teste
  await dbm.setSetting('test_mode', '1');
  const c = await loginAdmin();
  await c.post('/admin/teste/exemplos');
  const edson = await checklistOf('F12');
  await actAs(c, 'Kellen');
  await c.get(`/checklists/${edson}/avaliar/gestor`);
  const fd = new FormData();
  fd.append('_csrf', c.csrf);
  fd.append('code', 'C01');
  fd.append('arquivo', new Blob(['conteúdo da evidência'], { type: 'text/plain' }), 'evidência.txt');
  const up = await c.req('POST', `/checklists/${edson}/avaliar/gestor/anexo`, { multipart: fd });
  assert.equal(up.status, 200, up.text);
  const { id, name } = JSON.parse(up.text);
  assert.equal(name, 'evidência.txt');
  const down = await c.get(`/anexos/${id}`);
  assert.equal(down.status, 200);
  assert.equal(Buffer.from(down.text || down.buffer).toString(), 'conteúdo da evidência');
  await back(c);
  // Outro gestor não baixa o anexo (LGPD)
  await actAs(c, 'José');
  assert.equal((await c.get(`/anexos/${id}`)).status, 403);
  await back(c);

  await c.get('/admin/configuracoes');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const lf = new FormData();
  lf.append('_csrf', c.csrf);
  lf.append('logo', new Blob([png], { type: 'image/png' }), 'logo.png');
  const lr = await c.req('POST', '/admin/configuracoes/logo', { multipart: lf });
  assert.equal(lr.status, 302);
  const logo = await c.get('/logo');
  assert.equal(logo.status, 200);
  assert.ok(logo.buffer.equals(png));
  const pdf = await c.get(`/checklists/${await checklistOf('F15')}/pdf`);
  assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
});
