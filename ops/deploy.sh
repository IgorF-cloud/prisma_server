#!/usr/bin/env bash
#
# Roda o build do compose a pedido do painel de administração
# (2026-09-21). Ver ops/README.md pra instalação e pro desenho inteiro.
#
# ⚠️ ESTE SCRIPT RODA NO HOST, NUNCA DENTRO DE UM CONTAINER, e esse é o
# ponto de existir um script separado em vez de o Node executar o
# comando direto.
#
# `docker compose up -d --build` RECRIA o container do prisma_server —
# ou seja, mata o processo que teria disparado o comando. Rodando de
# dentro, o build morreria no meio e a resposta HTTP nunca chegaria.
# Aqui, quem roda é o systemd do host: o container pode ser destruído e
# recriado à vontade embaixo, que o build segue até o fim e o log
# continua sendo escrito.
#
# O caminho de ida é um ARQUIVO, não uma porta e não o socket do Docker:
# a API só escreve um pedido em ops/requests/ (a única coisa que ela
# pode fazer), e um `.path` do systemd acorda este script. Montar
# /var/run/docker.sock dentro do prisma_server daria a quem
# comprometesse a API pública o equivalente a root no host — e nem
# resolveria o problema de cima.
#
# NADA que venha do pedido vira comando. O arquivo só diz "alguém pediu,
# e foi fulano"; o que roda está escrito aqui.

set -uo pipefail

ROOT="${PRISMA_ROOT:-/opt/prisma}"
OPS="$ROOT/ops"
REQUESTS="$OPS/requests"
LOGS="$OPS/logs"
STATUS="$OPS/status"

# Quantos deploys ficam guardados (log + status). O painel mostra os
# últimos; mais do que isso é arqueologia, e log de build não é pequeno.
KEEP=20

# `git pull` antes do build: DESLIGADO por padrão, porque o código chega
# nesta VM por rsync (ver DEPLOY-SITE.md) e não por clone. Numa VM que
# tenha um clone de verdade, ligue com PRISMA_DEPLOY_GIT_PULL=1 no
# arquivo de serviço.
GIT_PULL="${PRISMA_DEPLOY_GIT_PULL:-0}"

mkdir -p "$REQUESTS" "$LOGS" "$STATUS"

# Um build por vez. Sem isto, dois cliques no painel (ou um clique e uma
# fila que sobrou) poriam dois `docker compose up --build` disputando as
# mesmas imagens e o mesmo daemon.
#
# `-n`: quem não pegou a trava SAI, não espera. O pedido dele continua em
# requests/, e o `.path` do systemd dispara este script de novo assim que
# o atual terminar.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$OPS/.lock"
  if ! flock -n 9; then
    echo "[deploy] já existe um build rodando — saindo" >&2
    exit 0
  fi
else
  # Não existe em toda parte (o Git Bash do Windows, por exemplo, não
  # tem). Seguir sem trava é pior do que ter trava, mas é MUITO melhor do
  # que o que acontecia antes desta checagem: `flock` inexistente devolve
  # 127, o `if !` lia isso como "já tem um build rodando", e o deploy
  # simplesmente não acontecia — sem erro, sem log, sem explicação.
  echo "[deploy] aviso: flock não existe neste host, seguindo sem trava" >&2
fi

# Compose v2 (plugin) é o de hoje; o binário antigo fica como plano B pra
# não quebrar numa VM que ainda não migrou.
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif docker-compose version >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "[deploy] não achei o docker compose neste host" >&2
  exit 1
fi

now() { date --iso-8601=seconds; }

# O status é um JSON pequeno, escrito à mão: `jq` não é garantido numa VM
# e a estrutura aqui tem seis campos fixos.
#
# Escreve em .tmp e renomeia: o painel lê este arquivo a cada 2s, e o
# `mv` no mesmo diretório é atômico — nunca se lê meio JSON.
write_status() {
  local id="$1" state="$2"
  {
    printf '{"id":"%s","state":"%s","requestedAt":"%s","requestedBy":"%s"' \
      "$id" "$state" "$requested_at" "$requested_by"
    [ -n "$started_at" ] && printf ',"startedAt":"%s"' "$started_at"
    [ -n "$finished_at" ] && printf ',"finishedAt":"%s"' "$finished_at"
    [ -n "$exit_code" ] && printf ',"exitCode":%s' "$exit_code"
    printf '}\n'
  } >"$STATUS/$id.json.tmp"
  mv -f "$STATUS/$id.json.tmp" "$STATUS/$id.json"
}

# Lê um campo de texto do pedido sem parser de JSON. O arquivo é escrito
# pela API, em uma linha, com valores já limpos (ver admin.js) — e o que
# não casar vira vazio, nunca comando.
field() {
  sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" "$2" | head -n 1
}

shopt -s nullglob

# Drena a fila inteira. Normalmente é um pedido só, mas se dois entraram
# enquanto um build rodava, os dois saem daqui — sem sobrar pedido preso
# esperando o próximo clique.
for req in "$REQUESTS"/*.json; do
  id="$(basename "$req" .json)"

  # Só o formato que a API gera. Qualquer outra coisa nesta pasta é
  # engano (ou alguém mexendo na mão) e vai fora sem rodar nada.
  if ! [[ "$id" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$ ]]; then
    echo "[deploy] pedido com nome estranho, ignorado: $id" >&2
    rm -f "$req"
    continue
  fi

  requested_at="$(field requestedAt "$req")"
  requested_by="$(field requestedBy "$req")"
  started_at=""
  finished_at=""
  exit_code=""
  log="$LOGS/$id.log"

  # Sai da fila ANTES de rodar: um build que derrube a VM no meio não
  # pode voltar sozinho no próximo boot, repetindo o que ninguém pediu de
  # novo.
  rm -f "$req"

  started_at="$(now)"
  write_status "$id" running

  {
    echo "== deploy $id"
    echo "== pedido por $requested_by em $requested_at"
    echo "== iniciado em $started_at"
    echo
  } >>"$log"

  # Subshell: o `cd` não escapa, e o código de saída é o do compose.
  (
    cd "$ROOT" || exit 90
    if [ "$GIT_PULL" = "1" ] && [ -d .git ]; then
      echo "== git pull --ff-only"
      git pull --ff-only || exit 91
      echo
    fi
    echo "== $DC up -d --build"
    $DC up -d --build
  ) >>"$log" 2>&1
  exit_code=$?

  finished_at="$(now)"
  echo "" >>"$log"
  echo "== fim em $finished_at (código $exit_code)" >>"$log"

  if [ "$exit_code" -eq 0 ]; then
    write_status "$id" done
  else
    write_status "$id" failed
  fi
done

# Limpeza dos antigos, do mais novo pro mais velho.
ls -1t "$LOGS"/*.log 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f
ls -1t "$STATUS"/*.json 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f
