'use strict';
// Dados iniciais: pessoas, cargos, hierarquia, competências e matriz (Versão 1 — 14/10/2026).

const EMAIL_DOMAIN_TESTE = 'interexpress.test';

const USERS = [
  { key: 'dhiego', name: 'Dhiego', email: `dhiego@${EMAIL_DOMAIN_TESTE}`, is_ceo: 1 },
  { key: 'fernanda', name: 'Fernanda', email: `fernanda@${EMAIL_DOMAIN_TESTE}` },
  { key: 'bianca', name: 'Bianca', email: `bianca@${EMAIL_DOMAIN_TESTE}`, is_admin: 1 },
  { key: 'kellen', name: 'Kellen', email: `kellen@${EMAIL_DOMAIN_TESTE}` },
  { key: 'jefferson', name: 'Jefferson', email: `jefferson@${EMAIL_DOMAIN_TESTE}`, is_sgi: 1 },
  { key: 'jose', name: 'José', email: `jose@${EMAIL_DOMAIN_TESTE}` },
  { key: 'cintia', name: 'Cíntia', email: `cintia@${EMAIL_DOMAIN_TESTE}` },
  { key: 'luiscarlos', name: 'Luis Carlos', email: `luis.carlos@${EMAIL_DOMAIN_TESTE}` },
  { key: 'cristina', name: 'Cristina', email: `cristina@${EMAIL_DOMAIN_TESTE}` },
  { key: 'ligia', name: 'Lígia', email: `ligia@${EMAIL_DOMAIN_TESTE}`, is_rh: 1 },
  { key: 'edson', name: 'Edson', email: `edson@${EMAIL_DOMAIN_TESTE}` },
  { key: 'lucas', name: 'Lucas', email: `lucas@${EMAIL_DOMAIN_TESTE}` },
  { key: 'anderson', name: 'Anderson', email: `anderson@${EMAIL_DOMAIN_TESTE}` },
  { key: 'karine', name: 'Karine', email: `karine@${EMAIL_DOMAIN_TESTE}` },
  { key: 'felipe', name: 'Felipe', email: `felipe@${EMAIL_DOMAIN_TESTE}` },
];

const AREAS = {
  DIR: 'Diretoria Executiva',
  COP: 'Comercial e Operações',
  FIN: 'Financeiro e Administrativo',
  RH: 'Recursos Humanos',
  QSMS: 'QSMS',
};

// code, título completo, título curto, área, liderança, ocupante, gestor imediato (código do cargo)
const CARGOS = [
  ['F01', 'CEO', 'CEO', AREAS.DIR, 1, 'dhiego', null],
  ['F02', 'Diretor(a) Comercial e Operações', 'Dir. Comercial e Operações', AREAS.COP, 1, 'dhiego', 'F01'],
  ['F03', 'Diretor(a) Financeiro(a) e Administrativo(a)', 'Dir. Financeiro e Administrativo', AREAS.FIN, 1, 'fernanda', 'F01'],
  ['F04', 'Diretora de RH', 'Diretora de RH', AREAS.RH, 1, 'bianca', 'F01'],
  ['F05', 'Gerente de Operações', 'Gerente de Operações', AREAS.COP, 1, 'kellen', 'F02'],
  ['F06', 'Gerente de QSMS (responsável pelo SGI)', 'Gerente de QSMS', AREAS.QSMS, 1, 'jefferson', 'F01'],
  ['F07', 'Coordenador(a) de Faturamento', 'Coord. de Faturamento', AREAS.FIN, 1, 'jose', 'F03'],
  ['F08', 'Analista de Compras', 'Analista de Compras', AREAS.COP, 0, 'cintia', 'F02'],
  ['F09', 'Analista de Sistemas / TI', 'Analista de Sistemas / TI', AREAS.FIN, 0, 'luiscarlos', 'F03'],
  ['F10', 'Analista Administrativo(a)', 'Analista Administrativo(a)', AREAS.FIN, 0, 'cristina', 'F03'],
  ['F11', 'Analista de RH', 'Analista de RH', AREAS.RH, 0, 'ligia', 'F03'],
  ['F12', 'Assistente de Documentação', 'Assistente de Documentação', AREAS.COP, 0, 'edson', 'F05'],
  ['F13', 'Assistente de Operações', 'Assistente de Operações', AREAS.COP, 0, 'lucas', 'F05'],
  ['F14', 'Auxiliar de Operações', 'Auxiliar de Operações', AREAS.COP, 0, 'anderson', 'F05'],
  ['F15', 'Assistente de Faturamento', 'Assistente de Faturamento', AREAS.FIN, 0, 'karine', 'F07'],
  ['F16', 'Analista de Operações', 'Analista de Operações', AREAS.COP, 0, 'felipe', 'F05'],
];

const N1_PADRAO = 'Não domina a competência. Depende de outra pessoa para executar.';

const COMPETENCIES = [
  {
    code: 'C01', name: 'Conhecimento técnico da função',
    definition: 'Domina as rotinas técnicas próprias do cargo.',
    n2: 'Executa as rotinas sob supervisão; ainda precisa de conferência.',
    n3: 'Executa as rotinas do cargo com autonomia.',
  },
  {
    code: 'C02', name: 'Documentação e registro',
    definition: 'Emite, confere e arquiva corretamente os documentos da sua rotina, usando a versão vigente e o formulário correto.',
    n2: 'Confere com apoio de checklist ou de terceiro; sabe localizar a versão vigente.',
    n3: 'Responde pela documentação da sua rotina sem retrabalho recorrente e mantém os registros no padrão da empresa.',
  },
  {
    code: 'C03', name: 'Sistemas e controles',
    definition: 'Opera os sistemas da empresa e mantém os controles atualizados.',
    n2: 'Usa as funções básicas do sistema do dia a dia.',
    n3: 'Opera com autonomia e mantém os controles confiáveis e em dia.',
  },
  {
    code: 'C04', name: 'Prazo e atendimento',
    definition: 'Cumpre prazos acordados e mantém cliente e áreas informados.',
    n2: 'Cumpre prazos com acompanhamento; comunica quando cobrado.',
    n3: 'Cumpre prazos e antecipa a comunicação de risco de atraso.',
  },
  {
    code: 'C05', name: 'Segurança do trabalho aplicada à função',
    definition: 'Conhece e cumpre as regras de segurança do seu posto; usa EPI corretamente.',
    n2: 'Conhece as regras e cumpre quando orientado.',
    n3: 'Cumpre por hábito e alerta o colega em situação insegura.',
  },
  {
    code: 'C06', name: 'Conformidade legal e regulatória',
    definition: 'Cumpre as exigências legais e de órgãos reguladores aplicáveis à sua atividade.',
    n2: 'Cumpre exigências rotineiras com orientação.',
    n3: 'Identifica a exigência aplicável e a cumpre sem depender de lembrete.',
  },
  {
    code: 'C07', name: 'Confiabilidade e disciplina',
    definition: 'Cumpre o combinado, no prazo, sem necessidade de cobrança.',
    n2: 'Cumpre quando acompanhado de perto.',
    n3: 'Cumpre com constância e registra o que faz.',
  },
  {
    code: 'C08', name: 'Comunicação e articulação',
    definition: 'Passa a informação certa, a quem precisa dela, no tempo certo, com cliente, autoridade e entre as áreas.',
    n2: 'Comunica-se de forma adequada em situação rotineira e colabora quando é solicitado.',
    n3: 'Comunica-se com clareza, inclusive em situação adversa, e antecipa a informação de que a outra área precisa.',
  },
  {
    code: 'C09', name: 'Ética e conduta',
    definition: 'Age conforme o código de conduta e reporta desvio.',
    n2: 'Conhece as regras de conduta e as segue.',
    n3: 'Age com integridade sob pressão e reporta desvio.',
  },
  {
    code: 'C10', name: 'Gestão de equipe e resultado',
    definition: 'Organiza o trabalho do time, dá retorno e acompanha indicadores. Só se aplica às lideranças (F01 a F07).',
    n2: 'Distribui tarefas e reporta números quando solicitado.',
    n3: 'Planeja o trabalho da equipe, dá feedback estruturado e age sobre desvio de indicador.',
    leadership_only: 1,
  },
].map((c) => ({ n1: N1_PADRAO, leadership_only: 0, ...c }));

// Nível exigido por cargo (C01..C10). null = não se aplica ao cargo.
const _ = null;
const MATRIX = {
  F01: [3, 2, 2, 3, 2, 3, 3, 3, 3, 3],
  F02: [3, 3, 3, 3, 2, 3, 3, 3, 3, 3],
  F03: [3, 3, 3, 3, 2, 3, 3, 3, 3, 3],
  F04: [3, 3, 3, 3, 2, 3, 3, 3, 3, 3],
  F05: [3, 3, 3, 3, 2, 3, 3, 3, 3, 3],
  F06: [3, 3, 3, 3, 2, 3, 3, 3, 3, 3],
  F07: [3, 3, 3, 3, 2, 3, 3, 3, 3, 3],
  F08: [3, 3, 3, 3, 2, 2, 3, 3, 3, _],
  F09: [3, 3, 3, 2, 2, 2, 3, 3, 3, _],
  F10: [3, 3, 3, 3, 2, 3, 3, 3, 3, _],
  F11: [3, 3, 3, 3, 2, 3, 3, 3, 3, _],
  F12: [3, 3, 2, 2, 2, 3, 3, 3, 3, _],
  F13: [2, 3, 2, 3, 3, 2, 3, 2, 3, _],
  F14: [2, 2, 2, 2, 3, 2, 3, 2, 3, _],
  F15: [3, 3, 2, 2, 2, 2, 3, 2, 3, _],
  F16: [3, 3, 2, 2, 3, 3, 3, 3, 3, _],
};

const MATRIX_V1 = { number: 1, date: '2026-10-14', notes: 'Versão inicial da matriz de competências por cargo.' };

const CYCLE_2026 = {
  name: 'Ciclo 2026',
  year: 2026,
  start_date: '2026-10-26',
  self_deadline: '2026-11-13',
  manager_deadline: '2026-11-27',
  feedback_deadline: '2026-12-11',
  end_date: '2026-12-18',
};

module.exports = { EMAIL_DOMAIN_TESTE, USERS, AREAS, CARGOS, COMPETENCIES, MATRIX, MATRIX_V1, CYCLE_2026 };
