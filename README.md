# Meu Fluxo de Caixa

App para alunos controlarem a própria receita e gastos mês a mês, com login individual e uma planilha visual que mostra o quanto cada um está economizando. Sem build: é `index.html` + Supabase.

## Como funciona

1. O aluno abre o link, cria uma conta com e-mail e senha (bem simples, só isso).
2. Na primeira vez, duas etapas rápidas: quanto ele recebe por mês, e quais são os gastos dele (lanches, roupas, tênis, etc.).
3. Depois disso, ele cai direto na "planilha": receita e cada gasto em colunas por mês, com total de gastos, saldo do mês e saldo acumulado calculados sozinhos.
4. Um painel no topo mostra o quanto ele já economizou no total, quanto economizou no mês e há quantos meses seguidos está no azul — pensado para ser motivador.

Cada aluno só vê os próprios dados (login separado, protegido por RLS no banco).

## 1. Criar o projeto no Supabase

1. Crie uma conta em [supabase.com](https://supabase.com) e clique em **New Project**.
2. Escolha um nome, uma senha de banco (guarde-a) e a região mais próxima dos alunos.
3. Espere o projeto terminar de provisionar (1–2 minutos).

## 2. Rodar o script SQL

Vá em **SQL Editor** (menu lateral) → **New query**, cole o script abaixo inteiro e clique em **Run**.

```sql
-- extensão usada para gerar ids
create extension if not exists pgcrypto;

-- perfil de cada aluno: nome, receita mensal e se já passou pela primeira configuração
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  monthly_income numeric(12,2) not null default 0,
  onboarding_completed boolean not null default false,
  start_month date not null default date_trunc('month', now())::date,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- cria o perfil automaticamente quando alguém se cadastra (nome vem do campo do formulário)
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- categorias de gasto de cada aluno (lanches, roupas, tênis...)
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  monthly_estimate numeric(12,2) not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.categories enable row level security;
create policy "categories_all_own" on public.categories for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- receita lançada em cada mês (quando o aluno edita o valor padrão)
create table public.income_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  month date not null,
  amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, month)
);
alter table public.income_entries enable row level security;
create policy "income_all_own" on public.income_entries for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- gasto lançado em cada categoria, em cada mês
create table public.expense_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  month date not null,
  amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, category_id, month)
);
alter table public.expense_entries enable row level security;
create policy "expenses_all_own" on public.expense_entries for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Isso cria as 4 tabelas, liga o RLS (cada aluno só enxerga as próprias linhas) e o gatilho que cria o perfil automaticamente no cadastro.

## 3. Configurar o login por e-mail e senha

Vá em **Authentication → Providers → Email** e confira:

- **Enable Email provider**: ligado (é o padrão).
- **Confirm email**: recomendo **desligar** para os alunos entrarem direto após criar a conta, sem precisar abrir e-mail. Se preferir manter a confirmação por segurança, deixe ligado — o app já avisa "confira seu e-mail" nesse caso, só demora um passo a mais.

Em **Authentication → URL Configuration**, coloque em **Site URL** o endereço onde o app vai ficar publicado (ex.: `https://seu-usuario.github.io/nome-do-repo/`). É esse endereço que o link de "esqueci minha senha" usa para voltar ao app.

## 4. Pegar a URL e a chave do projeto

Em **Project Settings → API**, copie:

- **Project URL**
- **anon public key**

Abra [frontend/js/config.js](frontend/js/config.js) e cole os dois valores:

```js
window.SUPABASE_CONFIG = {
  url: "https://SEU-PROJETO.supabase.co",
  anonKey: "SUA_CHAVE_ANON_AQUI"
};
```

A chave `anon` é pública por natureza (ela já vai para o navegador de qualquer app Supabase) — quem protege os dados é o RLS do passo 2, não o segredo da chave.

## 5. Publicar e distribuir o link

1. Suba a pasta inteira (`index.html`, `frontend/`, `backend/`, `README.md`) para um repositório no GitHub.
2. Repositório → **Settings** → **Pages** → em *Source*, escolha **Deploy from a branch** → branch `main` → pasta `/ (root)` → **Save**.
3. Em cerca de 1 minuto o site fica em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`. Esse é o link para mandar aos alunos.

## Estrutura de arquivos

```
index.html                     shell com as 3 telas: login, primeira configuração e planilha
frontend/
  css/styles.css                todo o estilo visual
  js/config.js                  URL e chave do Supabase (edite aqui)
  js/supabaseClient.js          inicializa o cliente Supabase
  js/format.js                  formatação de moeda e parsing de input
  js/chart.js                   gráfico SVG do saldo acumulado
  js/auth.js                    tela de entrar / criar conta / esqueci a senha
  js/onboarding.js              as duas etapas da primeira configuração
  js/sheet.js                   a planilha, os cálculos e a gravação no Supabase
  js/app.js                     roteamento por sessão, tema, liga tudo
backend/
  js/finance.js                 funções puras de cálculo (sem DOM): meses, totais, saldo acumulado
```

## Modelo de dados

- **profiles**: 1 linha por aluno — receita mensal padrão e se já concluiu a configuração inicial.
- **categories**: os gastos que o aluno cadastrou (nome + valor estimado usado como sugestão em meses novos).
- **income_entries** / **expense_entries**: os valores realmente lançados em cada mês. Quando não existe lançamento para um mês, a planilha mostra a receita/estimativa padrão como sugestão (em cinza) — assim que o aluno confirma um valor, ele vira um lançamento de verdade daquele mês.

## Aviso

Cada célula é salva assim que o aluno sai do campo (não precisa de botão "salvar"). Se a internet cair no meio de uma edição, aparece um aviso discreto acima da planilha.
