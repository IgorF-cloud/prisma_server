-- Migration 005 — limite de contas no lugar da aprovação (2026-09-18).
--
-- A aprovação manual (migration 004) resolvia o problema certo — controlar
-- quem usa o app — pelo caminho errado: cada pessoa que se cadastrava
-- ficava esperando um humano agir, e enquanto isso via uma tela dizendo
-- que não podia entrar. Controle de acesso virou fila de espera.
--
-- A troca é controlar o TOTAL em vez de cada indivíduo: existe um teto de
-- contas, e quem chega dentro dele entra na hora. Quando lota, a próxima
-- pessoa recebe uma mensagem clara em vez de ficar pendurada — e nem
-- chega a virar linha no banco.

-- --------------------------------------------------------------------
-- 1) O TETO
-- --------------------------------------------------------------------
--
-- Tabela de LINHA ÚNICA, mesmo truque do `app_version`: o CHECK garante
-- que só o id 1 existe, então "qual é o limite?" nunca fica ambíguo e o
-- UPDATE não precisa saber disso.
--
-- Tabela, e não variável de ambiente nem arquivo: o requisito é mudar o
-- valor pelo painel de administração. Env var exigiria reiniciar o
-- container; arquivo exigiria dar escrita em disco pro servidor.
--
-- Colunas tipadas, e não uma tabela genérica de chave/valor: com um
-- ajuste só, chave/valor faria toda leitura virar busca por chave mais
-- conversão de tipo. Um segundo ajuste, um dia, é uma coluna nova aqui.
CREATE TABLE app_settings (
  id          smallint     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  max_users   integer      NOT NULL DEFAULT 50 CHECK (max_users >= 0),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  -- Quem mexeu por último. `ON DELETE SET NULL` pelo mesmo motivo das
  -- outras: apagar a conta de um admin não pode levar junto o registro
  -- do que ele configurou.
  updated_by  integer      REFERENCES users(id) ON DELETE SET NULL
);

-- A linha nasce junto com a tabela. Sem ela, o primeiro cadastro depois
-- da migration leria "não há limite configurado" e o servidor teria que
-- decidir sozinho o que fazer — exatamente o tipo de caso especial que
-- não precisa existir.
INSERT INTO app_settings (max_users) VALUES (50);

-- --------------------------------------------------------------------
-- 2) AS SITUAÇÕES QUE DEIXAM DE EXISTIR
-- --------------------------------------------------------------------
--
-- De quatro para duas:
--
--   active  <-> blocked     (reversível, decisão do admin)
--
-- ⚠️ A ORDEM DOS TRÊS PASSOS ABAIXO IMPORTA. Converter os dados ANTES de
-- estreitar o CHECK — o contrário falha com violação de constraint em
-- qualquer banco que tenha uma linha nos estados antigos.
--
-- No banco de produção, em 2026-09-18, TODAS as contas já estavam
-- 'active' (conferido antes de escrever isto). Os dois UPDATEs abaixo
-- são no-op lá; existem porque uma migration não pode depender do estado
-- de UM banco — a de desenvolvimento, ou um dump antigo restaurado, pode
-- ter outros.

-- 'pending' -> 'active': eram pessoas esperando aprovação, e acabou a
-- espera. É o espírito da mudança.
UPDATE users SET status = 'active' WHERE status = 'pending';

-- 'rejected' -> 'blocked', e NÃO 'active'. Essa distinção é a única
-- coisa perigosa desta migration: alguém marcado como recusado foi
-- recusado DE PROPÓSITO por um admin, e convertê-lo para ativo o
-- deixaria entrar em silêncio. 'blocked' preserva a decisão — e continua
-- reversível com um clique, se tiver sido engano.
UPDATE users SET status = 'blocked' WHERE status = 'rejected';

-- O default. De 'pending' (migration 004) para 'active': a conta nasce
-- valendo, porque a única pergunta que sobrou é se há vaga — e essa é
-- respondida ANTES do INSERT, pelo servidor. Não havendo vaga, não há
-- linha.
ALTER TABLE users
  ALTER COLUMN status SET DEFAULT 'active';

-- O CHECK estreitado. Não é purismo: com ele largo, um bug que gravasse
-- 'pending' trancaria a pessoa fora sem erro nenhum em lugar nenhum — o
-- login só testa `status <> 'active'`, e uma conta em estado inventado
-- simplesmente não entraria mais, sem explicação. Estreito, o banco
-- recusa na hora da escrita.
--
-- ⚠️ O custo: voltar atrás passa a exigir outra migration. Assumido.
ALTER TABLE users
  DROP CONSTRAINT users_status_check;

ALTER TABLE users
  ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'blocked'));

-- Índice morto: era parcial `WHERE status = 'pending'`, e não existe
-- mais linha que caiba nele. Um índice que nunca casa nada só custa
-- escrita a cada INSERT/UPDATE.
DROP INDEX IF EXISTS users_pending_idx;
