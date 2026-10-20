-- Migration 003 — recuperação de senha por e-mail e revogação de token
-- (2026-09-10). Item 16.4 do ROADMAP.
--
-- As duas coisas vêm juntas de propósito, e essa é a parte que quase
-- passou batido: sem a revogação, trocar a senha NÃO expulsa ninguém.
-- Os JWTs são stateless e valem 30 dias, então no cenário que motiva um
-- reset — "alguém entrou na minha conta" — o invasor continuaria dentro
-- por até um mês DEPOIS da troca. A feature seria decorativa.

-- Versão do token. Vai como claim `tv` dentro do JWT e é conferida a
-- cada request autenticado (ver auth/jwt.js). Incrementar esta coluna
-- mata, na hora, TODO token já emitido pra esta conta.
--
-- Começa em 1 e não em 0 só pra que "usuário sem versão" (que não deve
-- existir) não se confunda com a versão válida.
ALTER TABLE users
  ADD COLUMN token_version integer NOT NULL DEFAULT 1;

-- Códigos de recuperação de senha.
--
-- Uma LINHA POR PEDIDO, e não uma coluna em `users`, por dois motivos:
-- dá pra contar quantos pedidos saíram numa janela de tempo (limite de
-- abuso), e o histórico morre sozinho quando a linha é apagada, sem
-- deixar campo velho pendurado no usuário.
CREATE TABLE password_resets (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- HASH do código, nunca o código. Mesma lógica da senha: quem ler o
  -- banco não pode sair usando o que encontrar. É scrypt, igual ao
  -- password_hash (ver auth de senha no server.js).
  code_hash  varchar(255) NOT NULL,

  -- Janela curta. Um código de 6 dígitos que vive horas é um código
  -- de 6 dígitos exposto por horas.
  expires_at timestamptz NOT NULL,

  -- Tentativas erradas neste código. O teto (ver auth/passwordReset.js)
  -- é o que impede varrer o espaço de 1 milhão de combinações dentro
  -- da validade — o limite de requisições por IP sozinho não resolve,
  -- porque o atacante pode ser o dono legítimo do IP.
  attempts   smallint NOT NULL DEFAULT 0,

  -- Marcado ao usar. A linha não é apagada na hora de propósito: ela
  -- ainda conta pro limite de "quantos pedidos nos últimos X minutos",
  -- então apagar abriria uma brecha pra pedir infinitos códigos.
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Todas as consultas são "os pedidos deste usuário, do mais novo pro
-- mais velho": achar o código vigente e contar os recentes.
CREATE INDEX password_resets_user_created_idx
  ON password_resets (user_id, created_at DESC);
