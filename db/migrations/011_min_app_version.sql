-- Migration 011 — versão mínima do app (2026-10-22).
--
-- Com isto o admin pode tornar uma atualização OBRIGATÓRIA: quem abrir o
-- app numa versão abaixo de `min_version` recebe o diálogo de
-- atualização sem a opção "Agora não". Quem já está com o app aberto
-- quando a versão sai continua podendo recusar — só o login obriga (ver
-- useAppUpdate.ts no Electron).
--
-- Só vale a partir da 1.6, a primeira versão que lê o campo. As
-- anteriores ignoram a chave nova no GET /version e seguem oferecendo a
-- atualização como opcional.
--
-- Nulo = nenhuma versão é obrigatória (o estado de nascença).

ALTER TABLE app_version
  ADD COLUMN min_version varchar(20);
