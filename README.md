# InterExpress · Verificação de Competências

Sistema web de verificação de competências (avaliação de desempenho) da InterExpress, em português do Brasil, que funciona no computador e no celular.

Também é a evidência do **item 7 do Registro SGI (E3.3.1)**: mostra que a empresa **define** a competência exigida de cada função (matriz por cargo), **verifica** essa competência (checklist com evidências e assinaturas) e **desenvolve** o que falta (plano de ação para cada lacuna).

## Como rodar

Requisitos: Node.js 22.13 ou mais recente (a versão LTS do site nodejs.org serve). O banco é o SQLite que já vem no próprio Node, então o `npm install` não precisa compilar nada (não exige Python nem Visual Studio).

```bash
npm install
npm start            # http://localhost:3000
```

No primeiro start o sistema cria o banco (`data/interexpress.db`) já carregado com:

- 15 pessoas, 16 cargos (F01–F16), a hierarquia e o organograma;
- a matriz de competências **Versão 1 de 14/10/2026** (10 competências, critérios dos níveis e nível exigido por cargo);
- o **Ciclo 2026** e os **16 checklists** (o Dhiego tem 2: F01 e F02);
- **3 avaliações de exemplo**: Karine (assinada), Felipe (concluída, plano de ação incompleto) e Lucas (autoavaliação enviada, aguardando a gestora).

### Primeiro acesso

| E-mail | Senha inicial |
|---|---|
| `bianca@interexpress.test` | `Teste@2026` (ou o valor de `ADMIN_SENHA_INICIAL`) |

No primeiro acesso, o sistema pede uma senha nova. As outras pessoas não têm senha no modo de teste: a administradora testa as telas delas com **Entrar como**.

Para apagar tudo e recomeçar do zero (cadastros e exemplos originais): `npm run reset`.

## Modo de teste

O sistema começa em **modo de teste** (faixa laranja no topo):

- **Nenhum e-mail é enviado.** Convites, avisos e lembretes ficam retidos em *Administração › E-mails*, onde dá para ver como cada mensagem vai ficar.
- **Entrar como**: a administradora vê o sistema exatamente como qualquer pessoa (seletor no topo ou *Administração › Modo de teste*). As ações feitas assim ficam registradas no log em nome dela. A senha não é pedida nas assinaturas de teste.
- **Apagar avaliações de teste**: apaga avaliações, planos, assinaturas, anexos e e-mails retidos; mantém cadastros, matriz e hierarquia. O ciclo volta ao planejamento e a matriz é destravada.
- **Recarregar exemplos**: apaga e carrega de novo os 3 exemplos.
- **Colocar no ar**: pede a confirmação `COLOCAR NO AR`, mostra o que ainda falta (e-mails reais, SMTP, validadores, datas), apaga as avaliações de teste, invalida senhas de teste e desativa o "Entrar como". A partir daí, ao **iniciar o ciclo**, cada pessoa recebe o aviso de abertura com o link para criar a senha (convite). O modo de teste não pode ser reativado pela tela.

## Perfis de acesso

| Perfil | Quem | O que vê e faz |
|---|---|---|
| Administradora | Bianca | Tudo: ciclo e prazos, matriz (com versões), cadastros e hierarquia, relatórios, liberação de resultados, reabertura, log LGPD, modo de teste |
| Execução do ciclo (RH) | Lígia | Acompanhamento de pendências, lembretes, consulta e PDF dos checklists depois da liberação do resultado. Não altera a matriz |
| CEO | Dhiego | Relatório geral (todos os painéis e o resultado individual), além dos perfis de avaliador e colaborador |
| Avaliadores | Dhiego, Fernanda, Kellen, José | Avaliam a equipe direta, fazem a própria autoavaliação e acompanham a equipe |
| Colaborador | Todos | Autoavaliação, plano de ação e assinatura |
| Consulta do SGI | Jefferson | Indicadores de cobertura e status dos fechamentos, sem notas individuais |

Os perfis de avaliador e de colaborador vêm da hierarquia (quem ocupa o cargo acima avalia). Os perfis especiais são marcados em *Administração › Pessoas*.

Regras de LGPD: cada gestor vê só a equipe direta; toda visualização e alteração de checklist, download de PDF ou anexo e exportação de relatório fica no **log de acesso** (*Administração › Log*), com filtro e exportação para Excel.

## Fluxo de cada checklist

1. **Autoavaliação** — antes de começar, o colaborador vê a tabela das competências do cargo com o nível exigido (e as que não se aplicam). No formulário ele só escolhe a nota; ao lado de cada nota aparecem a definição e os critérios.
2. **Avaliação do gestor** — o gestor vê o nível exigido e a lacuna calculada na hora. Ele só vê a autoavaliação depois de enviar a dele (vale também para o CEO nos relatórios).
3. Toda nota exige **evidência** (texto, com anexo opcional). Rascunho salvo automaticamente, barra de progresso, tela de revisão. Depois de enviada, só a administradora reabre (com motivo).
4. **Resultado** — a administradora libera (um a um ou "liberar todos os prontos"; pode ser automático, configurado no ciclo). O colaborador recebe um aviso.
5. **Plano de ação / PDI** — cada lacuna abre automaticamente uma linha (competência, lacuna, ação, responsável, prazo, status). Colaborador e gestor podem incluir ações livres (curso, mentoria, projeto, leitura...): o colaborador sugere, o gestor complementa e valida. Há campo de observações do gestor e o andamento das ações continua sendo atualizado depois do fechamento.
6. **Assinaturas** — colaborador e gestor confirmam com a senha (nome, data e hora). O fechamento exige 100% das lacunas com ação, responsável e prazo. Depois da primeira assinatura o plano trava; quem assinou pode retirar a assinatura enquanto o checklist não fechar.

**Dhiego (F01 e F02)**: autoverificação. Ele preenche e assina; para fechar, precisa da **validação de um terceiro** escolhido pela administradora (no próprio checklist) **ou** da **ata da Diretoria** anexada ao registro.

Status: Não iniciada · Em andamento · Concluída (avaliações enviadas) · Assinada (fechada).

## Relatórios

Para administradora e CEO, com filtros por ciclo, área, gestor e cargo: cobertura (previstas, realizadas, % e assinados), pendências, resultado individual (exigido × auto × gestor, diferença e lacuna), registro de lacunas e plano de ação (% com ação definida e % concluídas), visões por competência, cargo, gestor/equipe e área, e comparação com o ciclo anterior (a partir do Ciclo 2027). Exportação em **PDF** e **Excel**.

O **checklist individual em PDF** (níveis exigidos e verificados, lacunas, evidências, plano e assinaturas) serve para auditoria do SGI e para a conversa de feedback. A página **Indicadores SGI** também exporta um PDF de evidência do item 7, sem notas individuais.

## Lembretes por e-mail

- Abertura do ciclo (com convite para criar a senha), resultado liberado, validador designado e "esqueci minha senha".
- Lembretes automáticos de **prazo próximo** (N dias antes, configurável no ciclo) e de **pendência vencida** (semanal), verificados a cada hora. Não duplicam.
- Lembretes manuais em *Acompanhamento* (RH e administradora).

Tudo só é enviado depois de "Colocar no ar" e com o SMTP configurado.

## Configuração (variáveis de ambiente)

Copie `.env.example` para `.env` ou configure no servidor:

| Variável | Para quê |
|---|---|
| `APP_URL` | Endereço público (links dos e-mails). Com `https://`, os cookies ficam seguros |
| `PORT` | Porta HTTP (padrão 3000) |
| `DATA_DIR` | Pasta do banco SQLite e dos anexos (faça backup dela) |
| `ADMIN_SENHA_INICIAL` | Senha inicial da administradora |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Servidor de e-mail |

Em produção, use Node.js 22.13 ou mais recente e rode atrás de um proxy com HTTPS (Nginx, Caddy, ou a plataforma de hospedagem) e mantenha um único processo do Node (o banco é SQLite).

## Identidade visual

O logo em `public/img/logo.svg` é **provisório**. Envie o logo oficial em *Administração › Configurações* (PNG, JPG, SVG ou WEBP); ele passa a aparecer no topo e nos PDFs. As cores (azul royal e laranja) ficam no início de `public/css/app.css` (`--blue`, `--orange`) para ajuste fino com o tom exato do logo.

## Estrutura

```
src/
  server.js            app Express
  config.js            configurações e .env
  db/                  esquema, carga inicial (seed-data.js) e exemplos (examples-data.js)
  lib/                 regras de negócio (domain), acesso, relatórios, PDF, Excel, e-mail, log, lembretes
  routes/              telas: login, painel, checklists, acompanhamento, relatórios, administração
  views/               páginas (EJS)
public/                CSS, JS e imagens
test/                  teste de ponta a ponta (npm test)
```

## Testes

```bash
npm test
```

Cobre o fluxo completo (autoavaliação → avaliação do gestor → liberação → plano → assinaturas), a autoverificação do CEO com validador, as permissões de cada perfil (gestor só vê a equipe, SGI sem notas, RH sem relatórios analíticos), o CSRF, o "esqueci minha senha", a matriz versionada e travada durante o ciclo, a importação de e-mails por planilha, o modo de teste e o "Colocar no ar".
