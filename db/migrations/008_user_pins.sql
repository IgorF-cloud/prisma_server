-- Migration 008 — fixar usuários na lista (2026-09-25, pedido do usuário).
--
-- Cada pessoa pode marcar outras como FIXADAS, e elas passam a aparecer
-- no topo da lista de usuários do app — no topo dos online se estiverem
-- online, no topo dos offline se não estiverem.
--
-- TABELA PRÓPRIA, e não uma coluna em `users`:
--
--   - é uma relação de MUITOS PRA MUITOS (cada um fixa vários, e cada um
--     pode ser fixado por vários). Um array ou um jsonb em `users`
--     guardaria ids soltos, sem chave estrangeira — apagar uma conta
--     deixaria o id dela pendurado na lista de todo mundo que a fixou,
--     para sempre, e caberia ao servidor lembrar de limpar;
--   - aqui o `ON DELETE CASCADE` faz essa limpeza virar regra do banco:
--     conta apagada some sozinha das listas alheias, sem código nenhum;
--   - e a linha é o lugar natural pro `created_at`, que existe pra
--     desempatar caso um dia a ordem dos fixados passe a ser "o mais
--     recente primeiro" (hoje é alfabética, decisão do usuário — mas o
--     dado que permitiria trocar custa 8 bytes e não teria como ser
--     recuperado depois).
--
-- É uma preferência PESSOAL, não um vínculo mútuo: eu fixar você não te
-- diz nada nem aparece pra você. Por isso os dois lados não são
-- simétricos e a chave é o PAR ORDENADO.
CREATE TABLE user_pins (
  -- Quem fixou (o dono da preferência).
  owner_id   integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Quem foi fixado.
  pinned_id  integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- A chave primária composta faz dois trabalhos de uma vez: impede
  -- fixar a mesma pessoa duas vezes (o INSERT vira ON CONFLICT DO
  -- NOTHING, e "fixar de novo" é inofensivo) e serve de índice pra
  -- ÚNICA leitura que existe — "quem EU fixei?", que filtra por
  -- owner_id, a primeira coluna da chave. Nenhum índice extra é
  -- necessário.
  PRIMARY KEY (owner_id, pinned_id),

  -- Fixar a si mesmo não tem sentido: o próprio usuário nem aparece na
  -- lista (o app o remove, ver `others` na UsersSidebar). No banco pra
  -- não depender do app lembrar — um bug do lado de lá criaria uma
  -- linha invisível que ninguém conseguiria desfazer pela interface.
  CONSTRAINT user_pins_not_self CHECK (owner_id <> pinned_id)
);
