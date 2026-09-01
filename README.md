# Meu Fluxo de Caixa

App para alunos controlarem a própria receita e gastos mês a mês, com login individual e uma planilha visual que mostra o quanto cada um está economizando. Sem build: é `index.html` + Supabase.

## Como funciona

1. O aluno abre o link, cria uma conta com e-mail e senha (bem simples, só isso).
2. Na primeira vez, três etapas rápidas: quanto ele recebe por mês, quais são os gastos dele e quanto cada um custa por mês (lanches, roupas, tênis, etc.), e por quantos meses ele quer planejar (a partir do mês atual).
3. Depois disso, ele cai direto na "planilha", já preenchida para todo o período escolhido: um mês por linha, a receita e cada gasto em colunas, com total de gastos, saldo do mês e saldo acumulado calculados sozinhos.
4. Um painel no topo mostra o quanto ele já economizou no total, quanto economizou no mês e há quantos meses seguidos está no azul — pensado para ser motivador.

Cada aluno só vê os próprios dados (login separado, protegido por RLS no banco).

## Estrutura de arquivos

```
index.html                     shell com as 3 telas: login, primeira configuração e planilha
frontend/
  css/styles.css                todo o estilo visual
  js/config.js                  URL e chave do Supabase
  js/supabaseClient.js          inicializa o cliente Supabase
  js/format.js                  formatação de moeda e parsing de input
  js/dialog.js                  janelas de confirmação próprias do app (remover gasto/mês)
  js/chart.js                   gráfico do saldo acumulado
  js/auth.js                    tela de entrar / criar conta / esqueci a senha
  js/onboarding.js              as duas etapas da primeira configuração
  js/sheet.js                   a planilha, os cálculos e a gravação no Supabase
  js/app.js                     roteamento por sessão, tema, liga tudo
backend/
  js/finance.js                 funções puras de cálculo (sem DOM): meses, totais, saldo acumulado
```

## Modelo de dados

- **profiles**: 1 linha por aluno — receita mensal padrão, mês de início (`start_month`), mês final do planejamento escolhido na etapa 3 (`plan_end_month`) e se já concluiu a configuração inicial. Requer a coluna `plan_end_month date` (veja abaixo).
- **categories**: os gastos que o aluno cadastrou, com nome e o valor mensal padrão (`monthly_estimate`) informado na etapa 2 — é esse valor que preenche a planilha inteira até o aluno editar um mês específico.
- **income_entries** / **expense_entries**: os valores realmente lançados em cada mês. Quando não existe lançamento para um mês, a planilha mostra a receita/estimativa padrão como sugestão (em cinza) — assim que o aluno confirma um valor, ele vira um lançamento de verdade daquele mês.

Se o seu projeto Supabase já existia antes dessa etapa 3, rode uma vez no SQL Editor:

```sql
alter table public.profiles
  add column if not exists plan_end_month date;
```

## Aviso

Cada célula é salva assim que o aluno sai do campo (não precisa de botão "salvar"). Se a internet cair no meio de uma edição, aparece um aviso discreto acima da planilha.
