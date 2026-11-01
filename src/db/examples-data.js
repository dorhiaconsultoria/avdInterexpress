'use strict';
// Avaliações de exemplo (somente para o modo de teste), para visualizar o fluxo e os relatórios.
// Cada item: [nota, evidência]

const EXAMPLES = [
  {
    // Exemplo 1 — checklist completo e ASSINADO
    cargo: 'F15', // Karine — Assistente de Faturamento (avaliador: José)
    auto: {
      started_at: '2026-10-26T13:05:00Z',
      submitted_at: '2026-10-27T17:40:00Z',
      items: {
        C01: [3, 'Emito diariamente as notas fiscais de serviço dos processos de importação e calculo os reembolsos sem precisar de apoio. Em setembro/2026 emiti 142 notas.'],
        C02: [3, 'Arquivo os comprovantes de cada processo na pasta do cliente e uso o formulário de solicitação de faturamento vigente.'],
        C03: [2, 'Uso o módulo de faturamento do ERP nas funções do dia a dia; para relatórios gerenciais ainda peço ajuda ao José.'],
        C04: [3, 'Entrego o faturamento dos processos no prazo do fechamento mensal e aviso o cliente quando falta documento.'],
        C05: [2, 'Conheço as regras do escritório (rota de fuga, ergonomia) e participei da integração de segurança em março/2026.'],
        C06: [2, 'Sigo as orientações do José sobre retenções de ISS e PIS/COFINS nas notas.'],
        C07: [3, 'Cumpro as tarefas combinadas na reunião semanal sem precisar ser cobrada.'],
        C08: [2, 'Respondo os e-mails dos clientes sobre cobrança e encaminho dúvidas operacionais para a equipe de Operações.'],
        C09: [3, 'Sigo o código de conduta e já informei ao José uma divergência de valor solicitada por um cliente.'],
      },
    },
    gestor: {
      started_at: '2026-10-28T17:10:00Z',
      submitted_at: '2026-10-28T19:20:00Z',
      items: {
        C01: [2, 'Emite as notas com segurança nos processos padrão, mas nos processos com reembolso de impostos ainda depende da minha conferência: 3 notas corrigidas em set/2026 por CFOP incorreto.'],
        C02: [2, 'Arquiva corretamente, porém em ago/2026 usou um formulário de solicitação de faturamento desatualizado em 2 processos; ainda precisa de conferência para garantir a versão vigente.'],
        C03: [2, 'Opera o módulo de faturamento do ERP nas funções básicas; os relatórios de contas a receber ainda são extraídos pela coordenação.'],
        C04: [2, 'Cumpre o prazo do fechamento com acompanhamento; em out/2026 avisou o atraso de documentação do cliente somente depois de questionada.'],
        C05: [2, 'Conhece as regras do escritório e participou da integração de SST; cumpre quando orientada.'],
        C06: [2, 'Aplica as retenções rotineiras corretamente com orientação; ainda consulta a coordenação em casos de alíquota diferenciada.'],
        C07: [3, 'Cumpre com constância o que é combinado na reunião semanal e registra as pendências na planilha de controle.'],
        C08: [3, 'Comunicação clara com os clientes na cobrança; antecipou à equipe de Operações a falta de documentos em 4 processos de set/2026.'],
        C09: [3, 'Reportou espontaneamente o pedido de um cliente para alterar o valor de uma nota fora do contrato (set/2026).'],
      },
    },
    released_at: '2026-10-29T12:00:00Z',
    manager_notes: 'Karine é dedicada e tem ótima comunicação com os clientes. O foco deste ciclo é ganhar autonomia na emissão de notas com reembolso de impostos e eliminar o retrabalho de documentação.',
    employee_comment: 'Concordo com o plano. Vou usar o checklist de conferência em todas as emissões.',
    actions: [
      { origin: 'lacuna', code: 'C01', action: 'Treinamento prático com o Coordenador de Faturamento sobre emissão de notas com reembolso de impostos e conferência de CFOP/CST (4 sessões de 1h).', responsible: 'José', due_date: '2027-02-26', status: 'em_andamento' },
      { origin: 'lacuna', code: 'C02', action: 'Usar o checklist de conferência da instrução de trabalho de Faturamento (versão vigente) em 100% das emissões por 60 dias, com conferência semanal por amostragem.', responsible: 'Karine', due_date: '2027-01-29', status: 'nao_iniciada' },
      { origin: 'livre', category: 'curso', action: 'Curso de legislação tributária para faturamento (ICMS/ISS), 16 horas.', responsible: 'Karine', due_date: '2027-04-30', status: 'nao_iniciada', proposed: 'colaborador', validated: true },
    ],
    signatures: [
      { role: 'colaborador', signed_at: '2026-10-30T17:12:00Z', comment: 'Concordo com o plano. Vou usar o checklist de conferência em todas as emissões.' },
      { role: 'gestor', signed_at: '2026-10-30T18:03:00Z' },
    ],
  },
  {
    // Exemplo 2 — avaliações CONCLUÍDAS, plano de ação incompleto (aguardando assinaturas)
    cargo: 'F16', // Felipe — Analista de Operações (avaliadora: Kellen)
    auto: {
      started_at: '2026-10-27T12:30:00Z',
      submitted_at: '2026-10-28T14:00:00Z',
      items: {
        C01: [3, 'Coordeno a liberação de cargas no porto e no aeroporto, acompanho o desembaraço e agendo a retirada sem depender de outra pessoa.'],
        C02: [3, 'Confiro os documentos de embarque (BL/AWB, invoice e packing list) antes do registro e mantenho o processo completo no sistema.'],
        C03: [3, 'Atualizo o sistema de follow-up diariamente e mantenho a planilha de controle de containers em dia.'],
        C04: [3, 'Cumpro os prazos de free time e aviso o cliente quando há risco de armazenagem extra.'],
        C05: [3, 'Uso EPI (colete, botina e capacete) nas visitas ao terminal e oriento os auxiliares.'],
        C06: [3, 'Conheço as exigências do MAPA e da ANVISA para as cargas que acompanho e confiro as licenças antes do embarque.'],
        C07: [3, 'Registro todas as ocorrências no follow-up e cumpro o combinado com a gerência.'],
        C08: [3, 'Mantenho o cliente informado sobre cada etapa do processo e alinho as informações com o Faturamento.'],
        C09: [3, 'Sigo o código de conduta e nunca aceitei vantagem de fornecedor.'],
      },
    },
    gestor: {
      started_at: '2026-10-30T18:40:00Z',
      submitted_at: '2026-10-30T20:15:00Z',
      items: {
        C01: [3, 'Conduziu sozinho 38 processos de liberação em set–out/2026, inclusive dois com canal vermelho, sem necessidade de intervenção.'],
        C02: [2, 'A conferência documental é boa, mas houve 2 retificações de DUIMP em out/2026 por divergência de peso entre packing list e BL que não foi identificada na conferência.'],
        C03: [3, 'Follow-up atualizado diariamente; a planilha de containers é confiável e é usada pela gerência como referência.'],
        C04: [3, 'Antecipou ao cliente o risco de armazenagem extra em 5 processos de out/2026, evitando custos.'],
        C05: [3, 'Usa EPI em 100% das visitas ao terminal (verificado nas inspeções de SST) e orientou um auxiliar que estava sem botina em 15/10/2026.'],
        C06: [2, 'Conhece as exigências do MAPA, mas um processo com embalagem de madeira (NIMF 15) foi registrado sem conferir o certificado de tratamento; precisa de orientação nas exigências menos frequentes.'],
        C07: [3, 'Cumpre o combinado com constância e registra as ocorrências no sistema.'],
        C08: [2, 'Comunicação adequada na rotina; na situação de atraso do armador em out/2026, a informação chegou ao Faturamento depois da emissão da nota.'],
        C09: [3, 'Conduta íntegra; reportou tentativa de pagamento indevido por terceiro no terminal (ago/2026).'],
      },
    },
    released_at: '2026-10-31T12:30:00Z',
    manager_notes: null,
    actions: [
      { origin: 'lacuna', code: 'C02', action: 'Implantar a conferência cruzada BL x invoice x packing list antes do registro da DUIMP, com revisão por amostragem pela Gerente de Operações por 90 dias.', responsible: 'Felipe', due_date: '2027-02-26', status: 'nao_iniciada' },
      { origin: 'lacuna', code: 'C06', action: 'Treinamento sobre exigências do MAPA para embalagens de madeira (NIMF 15) e anuências da ANVISA; elaborar um resumo de consulta rápida para a equipe.', responsible: 'Kellen', due_date: '2027-01-29', status: 'nao_iniciada' },
      { origin: 'lacuna', code: 'C08' }, // ainda sem ação definida (pendência)
      { origin: 'livre', category: 'mentoria', action: 'Mentoria mensal com a Gerente de Operações sobre negociação com armadores e comunicação em situações de atraso.', responsible: 'Felipe', due_date: '2027-03-31', status: 'nao_iniciada', proposed: 'colaborador', validated: false },
    ],
    signatures: [],
  },
  {
    // Exemplo 3 — autoavaliação ENVIADA, aguardando a avaliação da gestora (em andamento)
    cargo: 'F13', // Lucas — Assistente de Operações (avaliadora: Kellen)
    auto: {
      started_at: '2026-10-29T15:10:00Z',
      submitted_at: '2026-10-29T16:45:00Z',
      items: {
        C01: [2, 'Faço o agendamento de retiradas e o acompanhamento das cargas, mas ainda confirmo com o Felipe os processos mais complexos.'],
        C02: [2, 'Organizo os documentos de entrega (canhotos e CT-e) e uso o checklist da área para conferir.'],
        C03: [2, 'Uso o sistema de follow-up para registrar as etapas do processo.'],
        C04: [3, 'Cumpro os horários de agendamento no terminal e aviso a equipe quando o motorista atrasa.'],
        C05: [3, 'Uso EPI completo no armazém e já alertei um colega que estava sem colete na área de carga.'],
        C06: [2, 'Sigo as orientações sobre a documentação obrigatória para o transporte das cargas.'],
        C07: [3, 'Cumpro as tarefas do dia sem precisar ser cobrado e registro tudo no follow-up.'],
        C08: [2, 'Passo as informações de entrega para Operações e Faturamento quando solicitado.'],
        C09: [3, 'Sigo o código de conduta da empresa.'],
      },
    },
    gestor: null,
    actions: [],
    signatures: [],
  },
];

const EXAMPLE_CYCLE_STARTED_AT = '2026-10-26T11:00:00Z';

module.exports = { EXAMPLES, EXAMPLE_CYCLE_STARTED_AT };
