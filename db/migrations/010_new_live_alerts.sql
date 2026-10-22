-- Migration 010 — alerta de novas lives em três níveis (2026-10-22,
-- item 26 / etapa 8 do app).
--
-- O `alert_for_new_lives` (liga/desliga) vira uma escolha:
--
--   all     — lives públicas + as privadas dos amigos (as privadas dos
--             outros nem chegam pra essa pessoa);
--   friends — só lives de amigos, públicas ou privadas;
--   none    — nenhuma.
--
-- Vale pro som, pro destaque laranja na barra de tarefas e pro card no
-- canto do app. Nada do alerta em si é guardado: só esta preferência.
--
-- A coluna antiga FICA, e o PUT /users/:id mantém as duas em sincronia
-- (ver `syncNewLiveAlerts` no server.js): o app 1.5 continua lendo e
-- gravando o booleano até a 1.6 virar obrigatória.
--
-- Quem tinha desligado o alerta começa em `none`; o resto em `all`, que é
-- o que o "ligado" de antes fazia.

ALTER TABLE users
  ADD COLUMN new_live_alerts text NOT NULL DEFAULT 'all'
    CHECK (new_live_alerts IN ('all', 'friends', 'none'));

UPDATE users SET new_live_alerts = 'none' WHERE alert_for_new_lives = false;
