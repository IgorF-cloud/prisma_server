-- Migration 004 — painel de administração (2026-09-16).
--
-- Duas coisas, que existem pelo mesmo motivo: o app vai abrir pro
-- público externo, e a partir daí "quem entra" e "qual versão está no
-- ar" deixam de ser decisões tomadas por quem tem acesso ao banco.

-- --------------------------------------------------------------------
-- 1) QUEM PODE ADMINISTRAR
-- --------------------------------------------------------------------
--
-- Uma coluna booleana, e não uma tabela de papéis/permissões: hoje
-- existem exatamente dois níveis (usuário e dono) e nenhuma permissão
-- que faça sentido conceder separadamente. Uma tabela de papéis seria
-- estrutura pra um problema que não existe.
--
-- O flag é conferido NO BANCO a cada rota de admin, e não vai dentro do
-- JWT. Se fosse claim do token, tirar o admin de alguém só valeria
-- quando o token dele vencesse — até 30 dias depois.
--
-- O PRIMEIRO admin é marcado na mão, uma vez:
--
--   UPDATE users SET is_admin = true WHERE username = 'SEU_USUARIO';
--
-- De propósito: uma tela de "promover admin" é superfície nova pra uma
-- ação que acontece uma vez na vida do produto.
ALTER TABLE users
  ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- --------------------------------------------------------------------
-- 2) SITUAÇÃO DA CONTA
-- --------------------------------------------------------------------
--
-- UMA coluna de estado, e não `is_approved` + `is_blocked`. Dois
-- booleanos dão quatro combinações e duas delas não querem dizer nada
-- ("aprovado e bloqueado"? "não aprovado e não bloqueado"?). Com uma
-- coluna, estado impossível não existe:
--
--   pending  -> active | rejected      (decisão do admin no cadastro)
--   active  <-> blocked                (reversível, a qualquer momento)
--
-- ⚠️ AS DUAS LINHAS ABAIXO SÃO UM PAR, E A ORDEM É O TRUQUE.
--
-- A primeira carimba TODO MUNDO QUE JÁ EXISTE como 'active' — são as
-- contas que o dono criou e conhece. A segunda troca o default pra quem
-- se cadastrar daqui em diante.
--
-- O caminho ingênuo (default 'pending' direto) trancaria o dono fora do
-- próprio app: todas as contas, inclusive a dele, ficariam pendentes, e
-- não haveria como aprovar nenhuma — o painel exige login, e o login
-- exige conta ativa.
ALTER TABLE users
  ADD COLUMN status varchar(16) NOT NULL DEFAULT 'active';

ALTER TABLE users
  ALTER COLUMN status SET DEFAULT 'pending';

-- O CHECK é o que impede um estado inventado por um `UPDATE` na mão
-- (ou por um bug) de entrar e só aparecer meses depois, como uma conta
-- que não loga e não dá erro nenhum.
ALTER TABLE users
  ADD CONSTRAINT users_status_check
  CHECK (status IN ('pending', 'active', 'rejected', 'blocked'));

-- Índice parcial: a tela de admin abre filtrando os pendentes, que são
-- poucos no meio de todos. Parcial e não completo porque as outras
-- situações não são consultadas isoladamente.
CREATE INDEX users_pending_idx ON users (id) WHERE status = 'pending';

-- Rastro da decisão. Não é auditoria completa (não guarda histórico, só
-- o último estado) — é o suficiente pra responder "quando e por quem"
-- olhando a própria linha do usuário.
--
-- `ON DELETE SET NULL`: apagar a conta de um admin não pode apagar em
-- cascata os usuários que ele aprovou.
ALTER TABLE users
  ADD COLUMN status_updated_at timestamptz,
  ADD COLUMN status_updated_by integer REFERENCES users(id) ON DELETE SET NULL;

-- --------------------------------------------------------------------
-- 3) QUEM PUBLICOU A VERSÃO
-- --------------------------------------------------------------------
--
-- A publicação deixa de ser um `curl` de dentro da máquina do dono e
-- passa a ser um botão num site. Com mais de um admin um dia, "quem
-- subiu esse exe" vira uma pergunta real.
ALTER TABLE app_version
  ADD COLUMN updated_by integer REFERENCES users(id) ON DELETE SET NULL;
