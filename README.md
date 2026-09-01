# Meu Fluxo de Caixa

App para alunos controlarem a própria receita e gastos mês a mês, com login individual e uma planilha visual que mostra o quanto cada um está economizando. Sem build: é `index.html` + Supabase.

## Como funciona

1. O aluno abre o link, cria uma conta com e-mail e senha (bem simples, só isso).
2. Na primeira vez, três etapas rápidas: quanto ele recebe por mês, quais são os gastos dele e quanto cada um custa por mês (lanches, roupas, tênis, etc.), e por quantos meses ele quer planejar (a partir do mês atual).
3. Depois disso, ele cai direto na "planilha", já preenchida para todo o período escolhido: um gasto por linha e um mês por coluna, com receita, total de gastos, saldo do mês e saldo acumulado calculados sozinhos. Uma segunda aba, "Realizada", usa a mesma grade para comparar o que foi gasto de verdade com o que foi projetado — célula por célula, verde quando gastou menos, vermelha quando gastou mais.
4. Um painel no topo mostra o quanto ele já economizou no total e quanto economizou no mês — pensado para ser motivador. O mesmo painel aparece na aba "Realizada", mas com os números de verdade.

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
- **income_entries** / **expense_entries**: os valores realmente lançados em cada mês na planilha de projeção. Quando não existe lançamento para um mês, a planilha mostra a receita/estimativa padrão como sugestão (em cinza) — assim que o aluno confirma um valor, ele vira um lançamento de verdade daquele mês.
- **realized_expense_entries** / **realized_income_entries**: quanto o aluno realmente gastou em cada gasto e quanto realmente recebeu de receita, mês a mês — digitado à mão na aba "Realizada" (mesmo formato de `expense_entries`/`income_entries`, só que comparado contra o projetado em vez de substituí-lo). Sem lançamento, a célula mostra o valor projetado daquele mês como sugestão.

Se o seu projeto Supabase já existia antes dessa etapa 3, rode uma vez no SQL Editor:

```sql
alter table public.profiles
  add column if not exists plan_end_month date;
```

Se o seu projeto Supabase já existia antes da aba "Realizada", rode uma vez no SQL Editor para criar a tabela (mesmo padrão de `expense_entries`: uma linha por gasto/mês, com RLS pra cada aluno só ler/gravar as próprias linhas):

```sql
create table if not exists public.realized_expense_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  month date not null,
  amount numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, category_id, month)
);

alter table public.realized_expense_entries enable row level security;

create policy "realized_expense_entries_select_own" on public.realized_expense_entries
  for select using (auth.uid() = user_id);
create policy "realized_expense_entries_insert_own" on public.realized_expense_entries
  for insert with check (auth.uid() = user_id);
create policy "realized_expense_entries_update_own" on public.realized_expense_entries
  for update using (auth.uid() = user_id);
create policy "realized_expense_entries_delete_own" on public.realized_expense_entries
  for delete using (auth.uid() = user_id);
```

A receita realizada mora em uma tabela separada (mesmo padrão de `income_entries`, um valor por mês em vez de por gasto):

```sql
create table if not exists public.realized_income_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  month date not null,
  amount numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, month)
);

alter table public.realized_income_entries enable row level security;

create policy "realized_income_entries_select_own" on public.realized_income_entries
  for select using (auth.uid() = user_id);
create policy "realized_income_entries_insert_own" on public.realized_income_entries
  for insert with check (auth.uid() = user_id);
create policy "realized_income_entries_update_own" on public.realized_income_entries
  for update using (auth.uid() = user_id);
create policy "realized_income_entries_delete_own" on public.realized_income_entries
  for delete using (auth.uid() = user_id);
```

Se você já tinha rodado o SQL de uma versão anterior desta funcionalidade (tabela `realized_entries`, um valor só por mês), pode apagá-la — ela não é mais usada:

```sql
drop table if exists public.realized_entries;
```

## Aviso

Cada célula é salva assim que o aluno sai do campo (não precisa de botão "salvar"). Se a internet cair no meio de uma edição, aparece um aviso discreto acima da planilha.
