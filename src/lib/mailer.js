'use strict';
// E-mails: todo envio passa pela caixa de saída. No MODO DE TESTE nada é enviado (fica "retido").
const nodemailer = require('nodemailer');
const dbm = require('../db');
const config = require('../config');
const { nowIso, escapeHtml, fmtDate } = require('./util');

let transporter = null;
function getTransporter() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

function smtpConfigured() {
  return !!config.smtp.host;
}

function layout({ title, paragraphs, button, note }) {
  const btn = button
    ? `<p style="margin:28px 0"><a href="${escapeHtml(button.url)}" style="background:#F28C1B;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">${escapeHtml(button.label)}</a></p>
       <p style="font-size:12px;color:#5b6475">Se o botão não funcionar, copie e cole este endereço no navegador:<br>${escapeHtml(button.url)}</p>`
    : '';
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f3f5fa;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fa;padding:24px 0"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;overflow:hidden">
    <tr><td style="background:#1A3E9E;padding:18px 28px;color:#fff;font-size:18px;font-weight:bold">Inter<span style="color:#F7A541">Express</span>
      <span style="font-weight:normal;font-size:14px;opacity:.9"> · Verificação de Competências</span></td></tr>
    <tr><td style="height:4px;background:#F28C1B"></td></tr>
    <tr><td style="padding:28px">
      <h1 style="font-size:20px;margin:0 0 16px;color:#1A3E9E">${escapeHtml(title)}</h1>
      ${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px">${escapeHtml(p)}</p>`).join('')}
      ${btn}
      ${note ? `<p style="font-size:12px;color:#5b6475;margin-top:20px">${escapeHtml(note)}</p>` : ''}
    </td></tr>
    <tr><td style="padding:16px 28px;background:#f7f8fb;font-size:12px;color:#5b6475">Mensagem automática do sistema de Verificação de Competências da InterExpress. Não responda este e-mail.</td></tr>
  </table></td></tr></table></body></html>`;
  const text = [title, '', ...paragraphs, button ? `\n${button.label}: ${button.url}` : '', note ? `\n${note}` : '']
    .join('\n');
  return { html, text };
}

/** Coloca o e-mail na caixa de saída e envia (se o sistema estiver no ar). */
async function queue({ to, toUserId = null, type, subject, title, paragraphs, button, note }) {
  const { html, text } = layout({ title: title || subject, paragraphs, button, note });
  const testMode = await dbm.isTestMode();
  const status = testMode ? 'retido_teste' : 'pendente';
  const id = await dbm.insert(`INSERT INTO email_outbox (to_email, to_user_id, type, subject, html, text, status, created_at)
                        VALUES (?,?,?,?,?,?,?,?)`, to, toUserId, type, subject, html, text, status, nowIso());
  if (testMode) return { id, status };
  const t = getTransporter();
  if (!t) {
    await dbm.run("UPDATE email_outbox SET status = 'erro', error = ? WHERE id = ?", 'Servidor de e-mail (SMTP) não configurado.', id);
    return { id, status: 'erro' };
  }
  try {
    await t.sendMail({ from: config.smtp.from, to, subject, html, text });
    await dbm.run("UPDATE email_outbox SET status = 'enviado', sent_at = ? WHERE id = ?", nowIso(), id);
    return { id, status: 'enviado' };
  } catch (err) {
    await dbm.run("UPDATE email_outbox SET status = 'erro', error = ? WHERE id = ?", String(err.message || err).slice(0, 500), id);
    return { id, status: 'erro' };
  }
}

const url = (p) => `${config.appUrl}${p}`;

/* ------------------------------------------------------------- modelos */

const templates = {
  convite(user, token) {
    return {
      to: user.email, toUserId: user.id, type: 'convite',
      subject: 'Convite: Verificação de Competências InterExpress',
      paragraphs: [
        `Olá, ${user.name}!`,
        'Você foi convidado(a) para acessar o sistema de Verificação de Competências da InterExpress.',
        'Clique no botão abaixo para criar a sua senha de acesso. O link é pessoal e vale por 7 dias.',
      ],
      button: { label: 'Criar minha senha', url: url(`/convite/${token}`) },
    };
  },
  redefinirSenha(user, token) {
    return {
      to: user.email, toUserId: user.id, type: 'redefinir_senha',
      subject: 'Redefinição de senha — Verificação de Competências',
      paragraphs: [
        `Olá, ${user.name}.`,
        'Recebemos um pedido para redefinir a sua senha. O link abaixo vale por 2 horas.',
        'Se você não fez esse pedido, ignore esta mensagem; a sua senha continua a mesma.',
      ],
      button: { label: 'Redefinir senha', url: url(`/redefinir-senha/${token}`) },
    };
  },
  abertura(user, cycle, { inviteToken } = {}) {
    return {
      to: user.email, toUserId: user.id, type: 'abertura',
      subject: `${cycle.name} de Verificação de Competências começou`,
      paragraphs: [
        `Olá, ${user.name}!`,
        `O ${cycle.name} de Verificação de Competências da InterExpress está aberto.`,
        `Prazos: autoavaliação até ${fmtDate(cycle.self_deadline)}; avaliação do gestor até ${fmtDate(cycle.manager_deadline)}; plano de ação e assinaturas até ${fmtDate(cycle.feedback_deadline)}.`,
        'No sistema, o painel "O que eu preciso fazer" mostra as suas tarefas. Toda nota precisa de uma evidência: um fato observado.',
      ],
      button: inviteToken
        ? { label: 'Criar minha senha e acessar', url: url(`/convite/${inviteToken}`) }
        : { label: 'Acessar o sistema', url: url('/') },
    };
  },
  lembrete(user, { titulo, itens, prazo }) {
    return {
      to: user.email, toUserId: user.id, type: 'lembrete',
      subject: `Lembrete: ${titulo}`,
      title: titulo,
      paragraphs: [
        `Olá, ${user.name}.`,
        'Você tem pendências na Verificação de Competências:',
        ...itens.map((i) => `• ${i}`),
        prazo ? `Prazo: ${fmtDate(prazo)}.` : '',
      ].filter(Boolean),
      button: { label: 'Abrir o sistema', url: url('/') },
    };
  },
  resultadoLiberado(user, cl) {
    return {
      to: user.email, toUserId: user.id, type: 'resultado_liberado',
      subject: 'Seu resultado da Verificação de Competências está disponível',
      paragraphs: [
        `Olá, ${user.name}.`,
        `O resultado do seu checklist (${cl.cargo_code} — ${cl.cargo_title}) foi liberado.`,
        'Confira as notas e as evidências, complete o plano de ação com o seu gestor e assine o checklist.',
      ],
      button: { label: 'Ver meu checklist', url: url(`/checklists/${cl.id}`) },
    };
  },
  validador(user, cl) {
    return {
      to: user.email, toUserId: user.id, type: 'validador',
      subject: 'Você foi designado(a) para validar uma autoverificação',
      paragraphs: [
        `Olá, ${user.name}.`,
        `A administradora do processo designou você para validar a autoverificação de ${cl.user_name} (${cl.cargo_code} — ${cl.cargo_title}).`,
        'Quando a autoverificação estiver concluída, revise as notas e as evidências e registre a sua validação no sistema.',
      ],
      button: { label: 'Abrir o checklist', url: url(`/checklists/${cl.id}`) },
    };
  },
};

module.exports = { queue, templates, smtpConfigured, layout };
