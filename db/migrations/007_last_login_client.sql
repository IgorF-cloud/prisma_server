-- Migration 007 — de QUAL cliente foi o último acesso (2026-09-21).
--
-- Complementa a 006 (`last_login_at`): além de QUANDO a conta entrou,
-- COM O QUÊ ela entrou. Serve pro painel responder duas perguntas que
-- hoje só se responde perguntando pra pessoa: "esse bug é da versão
-- velha?" e "quanta gente já atualizou?".
--
-- Duas colunas e não uma, apesar de os dois valores chegarem no MESMO
-- header (`X-Prisma-Client: windows/1.0.8`): guardar a string crua
-- faria toda leitura futura ("quantos ainda estão na 1.0.7?") virar
-- parsing de texto em SQL. A quebra acontece uma vez, na entrada.

-- A versão que o cliente anunciou. `text` e não algo numérico: "1.0.8"
-- não é número, e comparar versão é ordenar por três inteiros — coisa
-- que o painel não faz (ele EXIBE) e que, no dia em que fizer, é melhor
-- resolvida em código do que num tipo de coluna.
ALTER TABLE users
  ADD COLUMN last_login_version text;

-- Qual app. Existe porque há DOIS clientes contra este servidor — o
-- Windows (Electron) e o Android (Flutter) — e os números de versão
-- deles são sequências INDEPENDENTES. Sem esta coluna, "1.2.0" no painel
-- não diria de qual app, e a informação valeria pela metade.
ALTER TABLE users
  ADD COLUMN last_login_platform text;
