-- Migration 002 — sobreposição de viewers na tela (2026-09-10).
--
-- Preferência por conta, no mesmo espírito do alert_for_new_lives: quando
-- ligada, o app abre uma janela flutuante (transparente, sempre no topo,
-- que ignora cliques) no canto superior esquerdo do monitor principal
-- ENQUANTO houver uma transmissão no ar, listando quem está assistindo.
--
-- Nasce DESLIGADA, ao contrário do alerta sonoro: aquele só toca de vez em
-- quando, esta desenha por cima da tela do usuário o tempo todo. Ninguém
-- deve ser surpreendido por uma janela nova sem ter pedido.
--
-- Feita como migration separada, e não editando o 001, de propósito: é o
-- caminho que funciona tanto num banco que ainda não subiu quanto num que
-- já está rodando com usuários dentro.

ALTER TABLE users
  ADD COLUMN show_viewers_overlay boolean NOT NULL DEFAULT false;
