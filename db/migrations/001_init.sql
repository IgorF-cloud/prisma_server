-- Migration 001 — estrutura inicial do banco do Prisma (2026-09-10).
--
-- Substitui o data/userList.json e o version.json, que eram os dois
-- "bancos" em arquivo do servidor até aqui.
--
-- Decisão do usuário: começar com a tabela VAZIA. Os 8 usuários que
-- existiam no userList.json não são migrados — todo mundo se recadastra.
-- Por isso não há nenhum INSERT de usuário aqui.

CREATE TABLE users (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- UNIQUE direto na coluna, e não sobre lower(username): por decisão do
  -- usuário o nome é CASE-SENSITIVE, ou seja "igor" e "Igor" são duas
  -- contas diferentes e as duas podem existir ao mesmo tempo.
  username            varchar(32)  NOT NULL UNIQUE,

  -- Sem UNIQUE aqui: ele vem no índice sobre lower(email) mais abaixo.
  email               varchar(255) NOT NULL,

  -- scrypt com salt, no formato "<salt>:<hash>" (ver hashPassword no
  -- server.js) — 161 chars hoje. O varchar(255) dá folga pra trocar de
  -- algoritmo depois sem mexer no schema.
  password_hash       varchar(255) NOT NULL,

  -- O MESMO objeto que o app já troca com o servidor:
  -- {"type":"preset","key":"violet"} ou {"type":"custom","id":1,"version":6}.
  -- A FOTO em si continua sendo arquivo, em data/avatars/<id>.webp — aqui
  -- fica só a referência. É por isso que o `id` acima é numérico e não
  -- UUID: é ele que nomeia o arquivo.
  avatar              jsonb,

  -- Preferências da conta. Coluna direta em vez de tabela separada
  -- (decidido com o usuário): com uma configuração só, uma tabela à parte
  -- seria só um JOIN a mais. Config nova = ADD COLUMN com DEFAULT, que no
  -- Postgres é instantâneo. Revisitar se as configs virarem muitas e
  -- dinâmicas, ou se um dia forem por DISPOSITIVO em vez de por conta.
  alert_for_new_lives boolean      NOT NULL DEFAULT true,

  -- Presenca (2026-09-10). So a PREFERENCIA mora aqui, porque e escolha
  -- do usuario e sobrevive a fechar o app. O estado real (online/offline)
  -- NAO e gravado: ele vem de ter ou nao um WebSocket aberto.
  --
  -- Gravar "online" numa coluna seria um bug esperando acontecer: se o
  -- container reinicia ou o servidor cai, ninguem escreve o "offline" de
  -- volta e todo mundo fica online pra sempre.
  --
  -- So dois valores hoje. O CHECK e o que impede um valor inventado de
  -- entrar; pra adicionar um estado novo depois, e um ALTER na constraint.
  presence_preference varchar(16)  NOT NULL DEFAULT 'available'
    CHECK (presence_preference IN ('available', 'busy')),

  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now()
);

-- E-mail é case-insensitive de propósito, ao contrário do username:
-- ninguém digita o próprio e-mail sempre com a mesma caixa, e deixar
-- "Igor@x.com" e "igor@x.com" virarem duas contas seria um problema na
-- recuperação de senha (item 11.4). Índice funcional em vez de guardar o
-- e-mail já em minúsculas pra preservar o que o usuário digitou.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- Versão publicada do app (auto-atualização, ver src/main/update.ts no
-- Electron). Substitui o version.json.
CREATE TABLE app_version (
  -- Trava de linha única: sem isso, "qual é a versão atual?" fica
  -- ambíguo assim que alguém inserir uma segunda linha por engano. O
  -- CHECK garante que só o id 1 existe, e o DEFAULT deixa dar UPDATE sem
  -- precisar saber disso.
  id                 smallint     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version            varchar(20)  NOT NULL,
  installer_filename varchar(120) NOT NULL,
  -- Vazio até a primeira release assinada (é o que o version.json tinha).
  sha256             varchar(64)  NOT NULL DEFAULT '',
  updated_at         timestamptz  NOT NULL DEFAULT now()
);

-- Mesmos valores que estavam no version.json.
INSERT INTO app_version (version, installer_filename, sha256)
VALUES ('1.0.0', 'Prisma-Setup.exe', '');
