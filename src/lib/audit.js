'use strict';
// Registro de acesso e alterações (LGPD): quem viu ou alterou o quê e quando.
const dbm = require('../db');
const { nowIso } = require('./util');

const ACTIONS = {
  login: 'Entrou no sistema',
  login_falhou: 'Tentativa de login sem sucesso',
  logout: 'Saiu do sistema',
  senha_alterada: 'Alterou a senha',
  senha_redefinida: 'Redefiniu a senha',
  convite_aceito: 'Aceitou o convite',
  entrar_como: 'Entrou como outra pessoa (modo de teste)',
  sair_entrar_como: 'Voltou à própria conta',
  visualizou_checklist: 'Visualizou checklist',
  baixou_pdf_checklist: 'Baixou PDF do checklist',
  baixou_anexo: 'Baixou anexo',
  iniciou_avaliacao: 'Iniciou avaliação',
  salvou_rascunho: 'Salvou rascunho',
  anexou_arquivo: 'Anexou arquivo',
  removeu_anexo: 'Removeu anexo',
  enviou_avaliacao: 'Enviou avaliação',
  reabriu_avaliacao: 'Reabriu avaliação',
  liberou_resultado: 'Liberou resultado',
  alterou_plano: 'Alterou plano de ação',
  incluiu_acao: 'Incluiu ação de desenvolvimento',
  excluiu_acao: 'Excluiu ação de desenvolvimento',
  validou_acao: 'Validou ação sugerida',
  alterou_observacoes: 'Alterou observações do gestor',
  assinou: 'Assinou o checklist',
  retirou_assinatura: 'Retirou assinatura',
  validou_autoverificacao: 'Validou autoverificação',
  definiu_validador: 'Definiu validador',
  anexou_ata: 'Anexou ata da Diretoria',
  visualizou_relatorio: 'Visualizou relatórios',
  exportou_relatorio: 'Exportou relatório',
  visualizou_indicadores_sgi: 'Visualizou indicadores do SGI',
  enviou_lembrete: 'Enviou lembrete',
  alterou_ciclo: 'Alterou ciclo',
  iniciou_ciclo: 'Iniciou ciclo',
  encerrou_ciclo: 'Encerrou ciclo',
  criou_ciclo: 'Criou ciclo',
  alterou_matriz: 'Alterou matriz (rascunho)',
  publicou_matriz: 'Publicou nova versão da matriz',
  alterou_pessoa: 'Alterou cadastro de pessoa',
  incluiu_pessoa: 'Incluiu pessoa',
  importou_emails: 'Importou e-mails',
  enviou_convite: 'Enviou convite',
  alterou_hierarquia: 'Alterou cargo/hierarquia',
  alterou_cargo: 'Alterou cargo',
  apagou_testes: 'Apagou avaliações de teste',
  carregou_exemplos: 'Carregou avaliações de exemplo',
  colocou_no_ar: 'Colocou o sistema no ar',
  alterou_configuracoes: 'Alterou configurações',
  exportou_log: 'Exportou log de acesso',
};

/**
 * Registra um evento. `req` fornece o usuário real e o efetivo (quando a administradora "entra como").
 * coalesceMinutes: evita registros repetidos do mesmo evento em sequência (ex.: autosave, visualização).
 */
function log(req, action, { entity = null, entityId = null, subjectUserId = null, details = null, coalesceMinutes = 0 } = {}) {
  const db = dbm.get();
  const realId = req && req.realUser ? req.realUser.id : null;
  const actingId = req && req.impersonating ? req.user.id : null;
  const now = nowIso();
  if (coalesceMinutes > 0) {
    const since = new Date(Date.now() - coalesceMinutes * 60000).toISOString();
    const prev = db.prepare(`SELECT id FROM audit_log WHERE user_id IS ? AND acting_as_user_id IS ? AND action = ?
                               AND entity IS ? AND entity_id IS ? AND at >= ? ORDER BY id DESC LIMIT 1`)
      .get(realId, actingId, action, entity, entityId, since);
    if (prev) {
      db.prepare('UPDATE audit_log SET at = ? WHERE id = ?').run(now, prev.id);
      return;
    }
  }
  db.prepare(`INSERT INTO audit_log (at, user_id, acting_as_user_id, action, entity, entity_id, subject_user_id, details, ip)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(now, realId, actingId, action, entity, entityId, subjectUserId,
      details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)),
      req && req.ip ? req.ip : null);
}

/** Registro sem requisição (ex.: tarefa automática). */
function logSystem(action, opts = {}) {
  log(null, action, opts);
}

module.exports = { log, logSystem, ACTIONS };
