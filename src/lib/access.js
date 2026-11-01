'use strict';
// Quem pode ver e fazer o quê em cada checklist (regras de perfil + LGPD).
const domain = require('./domain');

/**
 * Permissões do usuário efetivo (viewer) sobre um checklist.
 * Regras principais:
 *  - Gestor vê apenas a equipe direta; só vê a autoavaliação depois de enviar a própria avaliação.
 *  - Colaborador só vê a avaliação do gestor depois que o resultado é liberado.
 *  - Consulta do SGI não vê notas individuais (não abre checklists).
 *  - Execução do ciclo (RH) consulta os registros depois da liberação do resultado, sem editar.
 */
function checklistAccess(viewer, cl, evals) {
  const isOwner = cl.user_id === viewer.id;
  const isSelf = !!cl.self_verification;
  const isEvaluator = !isSelf && cl.evaluator_user_id === viewer.id;
  const isValidator = isSelf && cl.validator_user_id === viewer.id;
  const isAdmin = !!viewer.is_admin;
  const isCeo = !!viewer.is_ceo;
  const isRh = !!viewer.is_rh;
  const released = isSelf || !!cl.results_released_at;
  const autoSent = domain.isSubmitted(evals.auto);
  const gestorSent = domain.isSubmitted(evals.gestor);
  const cycleOpen = cl.cycle_status === 'em_andamento';
  const cycleClosed = cl.cycle_status === 'encerrado';
  const signed = cl.status === 'assinada';
  const general = isAdmin || isCeo; // relatório geral
  const rhRecord = isRh && (released || signed);

  const canView = isOwner || isEvaluator || isValidator || general || rhRecord;

  // Avaliador não vê a autoavaliação antes de enviar a sua (mesmo tendo outro perfil, como o CEO).
  const blockedAsEvaluator = isEvaluator && !gestorSent;
  const seeAuto = !blockedAsEvaluator && (isOwner || isEvaluator || isValidator || general || rhRecord);
  const seeGestor = isOwner ? released : (isEvaluator || isValidator || general || rhRecord);
  const seeRequired = true;

  const hasSignature = Object.keys(domain.signaturesOf(cl.id)).length > 0;
  const planEditable = cycleOpen && !signed && !hasSignature;

  return {
    canView,
    isOwner,
    isSelf,
    isEvaluator,
    isValidator,
    isAdmin,
    isCeo,
    isRh,
    released,
    blockedAsEvaluator,
    seeAuto,
    seeGestor,
    seeRequired,
    readOnlyRole: !isOwner && !isEvaluator && !isValidator,
    // Avaliações
    canEditAuto: isOwner && !isSelf && cycleOpen && !autoSent,
    canEditGestor: ((isEvaluator) || (isSelf && isOwner)) && cycleOpen && !gestorSent,
    // Plano de ação
    canProposeFree: planEditable && ((isOwner && (autoSent || isSelf)) || (isEvaluator && gestorSent)),
    canEditGapActions: planEditable && gestorSent && ((isEvaluator) || (isOwner && released)),
    canValidateFree: planEditable && (isEvaluator || (isSelf && isOwner)),
    canUpdateActionStatus: !cycleClosed && (isOwner && released || isEvaluator) && gestorSent,
    canEditNotes: planEditable && (isEvaluator || (isSelf && isOwner)) && gestorSent,
    // Assinaturas
    canSignAsEmployee: isOwner && !cycleClosed,
    canSignAsManager: isEvaluator && !cycleClosed,
    canValidate: isValidator && !cycleClosed,
    // Administração
    canRelease: isAdmin && !isSelf && autoSent && gestorSent && !cl.results_released_at,
    canReopen: isAdmin && !cycleClosed,
    canSetValidator: isAdmin && isSelf && !cycleClosed,
    canUploadAta: (isAdmin || (isSelf && isOwner)) && !cycleClosed,
    canDownloadPdf: canView,
    canSeeHistory: isAdmin,
  };
}

module.exports = { checklistAccess };
