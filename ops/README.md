# Build do compose pelo painel (aba **Docker**)

Um botão no painel de administração roda `docker compose up -d --build`
na VM. Este arquivo explica o desenho, a instalação e o que fazer quando
não funcionar.

Tudo aqui pressupõe que o servidor está em **`/opt/prisma`** (é onde ele
está hoje). Se mudar de lugar, mude junto: as duas units do systemd e o
`PRISMA_ROOT` do `deploy.sh`.

---

## O desenho, em uma frase

A API **escreve um arquivo**, o **systemd do host** vê o arquivo e roda o
build, e a API **lê o log** de volta.

```
painel (navegador)
   │  POST /admin/docker/deploy
   ▼
prisma_server (container)          ops/requests/<id>.json   <- escreve
   │
   ▼
prisma-deploy.path (systemd, HOST) <- vê o arquivo aparecer
   │
   ▼
ops/deploy.sh (HOST)               docker compose up -d --build
   │                                      │
   │                                      ├─> ops/logs/<id>.log
   │                                      └─> ops/status/<id>.json
   ▼
painel  <- GET /admin/docker/deploy/<id> a cada 2s
```

### Por que não rodar o comando direto do Node

Dois motivos, e o primeiro sozinho já decide:

1. **O build mata quem o disparou.** `docker compose up -d --build`
   recria o container do `prisma_server` — o processo que teria rodado o
   comando morre no meio dele. A resposta HTTP nunca chegaria e o build
   ficaria pela metade. Rodando no host, sob o systemd, o container pode
   ser destruído e recriado embaixo que o build segue.

2. **Montar `/var/run/docker.sock` no container é dar root no host.**
   Quem comprometesse a API pública ganharia o daemon do Docker inteiro,
   o que na prática é a VM inteira. Aqui o container só consegue criar um
   arquivo numa pasta — e o que roda está escrito no `deploy.sh`, não no
   pedido.

**Nada do pedido vira comando.** O JSON só diz *quem* pediu e *quando*;
o `deploy.sh` não interpola nada dele num shell.

---

## Instalar na VM (uma vez)

Com os arquivos já na VM (esta pasta sobe junto no rsync do deploy):

```bash
cd /opt/prisma

# 1. O script precisa ser executável — o rsync de uma máquina Windows
#    costuma perder o bit de execução.
chmod +x ops/deploy.sh

# 2. As units do systemd (rodam no HOST, não no Docker).
sudo cp ops/prisma-deploy.service ops/prisma-deploy.path /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now prisma-deploy.path

# 3. O container precisa enxergar ops/ pra escrever o pedido e ler o
#    log. O bind mount já está no docker-compose.yml; este up é o que o
#    aplica (e é a ÚLTIMA vez que se faz isso na mão).
docker compose up -d
```

Conferir se o observador está de pé:

```bash
systemctl status prisma-deploy.path     # deve dizer "active (waiting)"
```

### Teste sem passar pelo painel

```bash
id="$(date +%Y%m%d-%H%M%S)-aaaaaa"
printf '{"id":"%s","requestedAt":"%s","requestedBy":"teste"}\n' \
  "$id" "$(date --iso-8601=seconds)" > /opt/prisma/ops/requests/$id.json

sleep 5
cat /opt/prisma/ops/status/$id.json
tail -f /opt/prisma/ops/logs/$id.log
```

---

## O que cada pasta guarda

| pasta | quem escreve | o quê |
|---|---|---|
| `requests/` | a API | o pedido. Vive segundos — o script apaga antes de rodar |
| `logs/` | o `deploy.sh` | a saída do build, um arquivo por deploy |
| `status/` | o `deploy.sh` | `queued` → `running` → `done`/`failed` |

Os 20 últimos ficam; o resto o próprio script apaga no fim de cada
execução.

---

## O que esperar ao clicar

- O `prisma_server` **reinicia** no meio (é o que está sendo buildado).
  Por 20-60 segundos a API não responde e o painel mostra
  *"servidor reiniciando"* em vez de erro — ele continua tentando. A
  sessão sobrevive: o token é stateless, não fica na memória do
  servidor.
- Os WebSockets do app (`/ws/rooms`) caem e reconectam sozinhos.
- **LiveKit, Ingress, Redis e nginx não são rebuildados** — são imagens
  prontas. O Compose só recria o que mudou, então quem estiver ao vivo
  não cai (a não ser que o próprio `docker-compose.yml` tenha mudado).
- O botão builda **o que já está na VM**. O rsync do código continua
  sendo o passo anterior — este botão não busca código novo, a não ser
  que a VM tenha um clone git e o `PRISMA_DEPLOY_GIT_PULL=1` esteja
  ligado no arquivo de serviço.

---

## Quando não funcionar

| sintoma | onde olhar |
|---|---|
| o pedido fica `queued` pra sempre | `systemctl status prisma-deploy.path` — a unit está habilitada? |
| status pula pra `failed` na hora | `journalctl -u prisma-deploy.service -n 50` — costuma ser o `chmod +x` esquecido |
| o painel diz que não conseguiu pedir | o bind mount `./ops` está no compose e o container foi recriado depois disso? |
| dois cliques, um build só | é de propósito: `flock` no `deploy.sh`. O segundo pedido entra na fila e roda depois |
