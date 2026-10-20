-- Migration 006 — último acesso de cada conta (2026-09-21).
--
-- Uma coluna só: a data/hora da última vez que a conta se autenticou.
-- Serve pro painel de administração responder "esta conta ainda é usada?"
-- — que é a pergunta que decide quem apagar quando o teto de contas
-- (migration 005) lota.
--
-- NULL é um estado de verdade aqui, e não falta de dado: significa "não
-- se autenticou nenhuma vez DESDE QUE isto passou a ser gravado". Todas
-- as contas que já existiam nascem assim, e é por isso que a coluna não
-- tem DEFAULT now() nem NOT NULL — carimbar o instante da migration
-- inventaria um acesso que não aconteceu, e num painel que mostra a data
-- isso seria pior do que um traço: todas as contas apareceriam acessadas
-- no mesmo minuto, para sempre, sem nada indicando que foi a migration.
ALTER TABLE users
  ADD COLUMN last_login_at timestamptz;

-- Sem índice de propósito. A coluna é LIDA na listagem do painel, que
-- traz a tabela inteira ordenada por situação e nome, e é ESCRITA a cada
-- autenticação. Um índice aqui não ajudaria aquela leitura (não há WHERE
-- nem ORDER BY sobre ela) e cobraria escrita em toda entrada no app.
