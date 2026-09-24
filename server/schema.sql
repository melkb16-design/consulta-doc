CREATE TABLE IF NOT EXISTS cupons (
  codigo   text PRIMARY KEY,
  tipo     text NOT NULL,            -- 'percentual' ou 'fixo'
  valor    numeric NOT NULL,
  ativo    boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS pre_cadastros (
  id           serial PRIMARY KEY,
  token        uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  dados        jsonb NOT NULL,       -- empresa, cnpj, email, etc.
  plano        text NOT NULL,        -- 'mensal' | 'anual'
  cupom        text,
  status       text NOT NULL DEFAULT 'aguardando_pagamento',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clientes (
  id                 serial PRIMARY KEY,
  razao_social       text,
  cnpj               text,
  email              text,
  socio_administrador text,
  email_responsavel  text,
  plano              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usuarios (
  id             serial PRIMARY KEY,
  cliente_id     integer REFERENCES clientes(id),
  identificador  text UNIQUE NOT NULL,   -- e-mail OU CNPJ
  senha_hash     text NOT NULL,          -- bcrypt — NUNCA texto puro
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS acessos_tokens (
  token         text PRIMARY KEY,        -- hash do token enviado por e-mail
  cliente_id    integer REFERENCES clientes(id),
  usado         boolean NOT NULL DEFAULT false,
  expira_em     timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assinaturas (
  id             serial PRIMARY KEY,
  cliente_id     integer REFERENCES clientes(id),
  gateway_id     text,                   -- id do preapproval no Mercado Pago
  plano          text NOT NULL,
  valor          numeric NOT NULL,
  status         text NOT NULL DEFAULT 'ativo',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pagamentos (
  id           serial PRIMARY KEY,
  cliente_id   integer REFERENCES clientes(id),
  gateway_id   text,                     -- id da transação no gateway
  tipo         text NOT NULL,            -- 'assinatura' | 'certificado_a1'
  valor        numeric NOT NULL,
  status       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS certificados (
  id            serial PRIMARY KEY,
  cliente_id    integer REFERENCES clientes(id),
  nome_arquivo  text,
  validade      date,
  status        text NOT NULL DEFAULT 'pendente',
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cupons (codigo, tipo, valor) VALUES
  ('DOC10', 'percentual', 10),
  ('DOC50', 'fixo', 50)
ON CONFLICT (codigo) DO NOTHING;