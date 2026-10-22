-- Migration 009 — amizades (2026-10-21, item 26 / etapa 5 do roadmap do app).
--
-- Amizade é um vínculo MÚTUO, e só vale depois do aceite: um pede, o
-- outro aceita. Enquanto não aceita, é um pedido — que o outro lado vê
-- e pode recusar, e que quem pediu pode cancelar.
--
-- UMA LINHA POR PAR, nos dois estados. O pedido e a amizade são a mesma
-- linha em dois momentos (`pending` -> `accepted`), e não duas tabelas:
--
--   - aceitar é um UPDATE, e não "apaga o pedido e cria a amizade" —
--     duas escritas que poderiam ficar pela metade;
--   - recusar, cancelar e desfazer são todos o mesmo DELETE: nos três
--     casos o resultado é "não existe mais nada entre essas duas
--     pessoas", e é isso que libera um pedido novo depois.
--
-- `requester_id` é quem pediu. Depois do aceite a direção não importa
-- mais pra regra nenhuma (amizade é simétrica), mas continua guardada:
-- custa nada e é o único registro de quem tomou a iniciativa.
--
-- Mesmo molde do `user_pins` (migração 008): chaves estrangeiras com
-- `ON DELETE CASCADE`, então apagar uma conta pelo painel limpa as
-- amizades dela sozinho — o painel admin não precisa mudar.
CREATE TABLE friendships (
  requester_id integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  addressee_id integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status       text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'accepted')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz,

  PRIMARY KEY (requester_id, addressee_id),

  -- Mesmo motivo do CHECK do user_pins: no banco pra não depender do
  -- app (nem da rota) lembrar.
  CONSTRAINT friendships_not_self CHECK (requester_id <> addressee_id)
);

-- UM vínculo por PAR, não por par ORDENADO. A chave primária sozinha
-- deixaria existir (A pediu B) e (B pediu A) ao mesmo tempo — dois
-- pedidos cruzados, cada um aceitável separadamente. O índice sobre o
-- par normalizado (menor, maior) faz o segundo INSERT falhar; a rota
-- trata esse caso como "o outro já tinha pedido" e aceita (ver
-- db/friends.js).
CREATE UNIQUE INDEX friendships_pair
  ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

-- O CASCADE do `addressee_id` precisa achar as linhas por essa coluna;
-- sem índice, apagar uma conta varreria a tabela inteira. (O
-- `requester_id` já é a primeira coluna da chave primária.)
CREATE INDEX friendships_addressee ON friendships (addressee_id);
