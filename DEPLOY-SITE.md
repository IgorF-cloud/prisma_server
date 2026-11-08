# Subir o site (landing page) e o HTTPS

O site é o projeto **`prisma_webpage`** (em `MY PROJECTS/react`). Ele
**não é buildado na VM**: a build sai em `dist/` na máquina de
desenvolvimento e é copiada pra `prisma_server/www/`, exatamente como o
instalador é copiado pra `downloads/`. A VM não precisa de Node.

O nginx serve esses arquivos e **é a única porta de entrada da API**
(2026-09-10): o `prisma_server` não publica mais a 5000 no host.

| rota | vai pra |
|---|---|
| `/`, `/assets/…` | os arquivos do site |
| `/app/`, `/app/assets/…` | os arquivos do **Prisma Web** (2026-09-30) |
| `/downloads/…` | prisma_server — o instalador |
| `/ws/rooms` | prisma_server — WebSocket de salas em tempo real |
| `/livekit/…` | livekit-server — sinalização em `wss://` |
| `/login` `/register` `/users` `/rooms` `/token` `/ingress` `/version` `/avatars` `/games` `/ping` | prisma_server |
| `/webhook` | **ninguém** — só a rede interna do Docker |

O que **não** passa pelo nginx, de propósito: a mídia (UDP 60000-60100)
e o WHIP (`:5080` + UDP 5885). Proxiar mídia WebRTC não é possível de
forma sã: o LiveKit anuncia o próprio endereço no payload ICE, e
remapear porta de mídia já causou um bug real de ICE travado em
"checking" (ver o cabeçalho do `docker-compose.yml`).

A **sinalização** do LiveKit passa pelos dois caminhos: o app Windows
disca `ws://prisma-site.com.br:5880` direto, e o Android e o Prisma Web
usam `wss://prisma-site.com.br/livekit`. Pro navegador não havia
escolha — uma página em `https://` não consegue abrir um `ws://`, o
navegador bloqueia como conteúdo misto antes de tentar.

⚠️ **`app.set("trust proxy", 1)` e a ausência do `ports: 5000` são um
par.** Ver a seção no fim deste arquivo.

---

## 1. Gerar e copiar o site

Na máquina de desenvolvimento:

```bash
cd "D:/MY PROJECTS/react/prisma_webpage"
npm install        # só na primeira vez
npm run build      # roda o typecheck e gera dist/
```

Copiar pra cá (apagando o conteúdo antigo, pra não deixar arquivo órfão
de uma build anterior):

```bash
rm -rf "D:/MY PROJECTS/_nodeServer/prisma_server/www/site"/*
cp -r "D:/MY PROJECTS/react/prisma_webpage/dist"/* "D:/MY PROJECTS/_nodeServer/prisma_server/www/site/"
```

`www/` é bind mount — assim que os arquivos chegam na VM, já valem. Não
precisa reiniciar nem rebuildar container nenhum.

⚠️ **A pasta mudou em 2026-09-16.** O site deixou de ser a raiz de
`www/` e passou a ser `www/site/`, porque agora são DOIS sites no mesmo
nginx:

```
www/
  site/    -> prisma-site.com.br
  app/     -> prisma-site.com.br/app     (o Prisma Web, ver 1.1 abaixo)
  admin/   -> admin.prisma-site.com.br   (ver ADMIN-PANEL.md)
```

Numa VM que ainda esteja com os arquivos soltos em `www/`, os dois
movimentos (mover pra `site/` e subir a config nova) têm que acontecer
no MESMO deploy: o nginx novo procura `www/site/` e o antigo procura a
raiz.

## 1.1. Gerar e copiar o Prisma Web (2026-09-30)

O app de **assistir** pelo navegador, projeto **`prisma_site_app`**.
Mesma mecânica do site: build na máquina de desenvolvimento, cópia pra
`www/app/`, nada de Node na VM.

```bash
cd "D:/MY PROJECTS/react/prisma_site_app"
npm install        # só na primeira vez
npm run build      # roda o typecheck e gera dist/

rm -rf "D:/MY PROJECTS/_nodeServer/prisma_server/www/app"/*
cp -r "D:/MY PROJECTS/react/prisma_site_app/dist"/* "D:/MY PROJECTS/_nodeServer/prisma_server/www/app/"
```

⚠️ **Na PRIMEIRA vez, duas coisas precisam ir junto** — e nenhuma das
duas é opcional:

1. **`nginx/snippets/prisma-app.conf`** com o bloco `location /app/`.
   Sem ele, `/app/` cai no `location /` do site e devolve a landing page
   com status 200 — ou seja, falha em silêncio.

2. **`server.js`** com o `tokenDoHandshake` no `/ws/rooms`. O
   `WebSocket` do navegador não aceita header nenhum, então o Prisma Web
   manda o JWT por **subprotocolo**. Sem essa mudança no servidor, o
   handshake até completa (a lib `ws` escolhe o primeiro subprotocolo
   oferecido por conta própria), mas o servidor procura o token só no
   header `Authorization`, não acha, e fecha com **4401**.

   O sintoma é exatamente este, e não parece um problema de WebSocket:
   **a pessoa entra e é deslogada em seguida, com "Sua sessão expirou"**
   — o app trata o 4401 do socket como token morto e volta pro login.

Diferente do site, esta parte **não** é só copiar arquivo — são duas
ações separadas, e uma delas é fácil de esquecer:

**a) O `prisma_server` precisa ser recriado** (o `server.js` mudou). O
botão da aba **Docker** do painel de administração roda
`docker compose up -d --build`, que faz isso.

**b) O nginx precisa de um RELOAD à mão.** ⚠️ O build da letra (a)
**não** cobre isto, ao contrário do que este arquivo dizia até
2026-09-30. `docker compose up -d` só recria um container quando a
definição dele no compose ou a imagem mudam — e nenhuma das duas muda
quando você mexe num arquivo de `nginx/snippets/`, que é bind mount. O
arquivo novo chega no disco, e o nginx segue rodando com a config que
leu quando subiu.

```bash
# na VM, dentro de /opt/prisma
docker compose exec nginx nginx -t        # testa ANTES
docker compose exec nginx nginx -s reload # só então aplica
```

`nginx -t` primeiro, e `reload` em vez de `restart`, de propósito: uma
config quebrada num `restart` deixa o nginx **fora do ar**, e com ele o
site inteiro e a API. O `reload` com a config ruim é recusado e o
processo antigo continua servindo.

O sintoma de ter esquecido este passo é traiçoeiro: `/app/` responde
**200 com a landing page** em vez de 404 — o pedido cai no
`try_files $uri $uri/ /index.html` do site e volta o HTML errado com
status de sucesso. Um jeito rápido de conferir de fora:

```bash
curl -s https://prisma-site.com.br/app/ | grep -o "<title>[^<]*"
# esperado:  <title>Prisma · Assistir
# se vier:   <title>Prisma — compartilhe sua tela...  -> falta o reload
```

## 2. Apontar o DNS

No painel do registrador, dois registros `A` apontando pro IP da VM:

```
@     A    SEU_IP_PUBLICO
www     A    SEU_IP_PUBLICO
admin   A    SEU_IP_PUBLICO
```

Conferir antes de seguir (a propagação pode levar minutos ou horas):

```bash
nslookup prisma-site.com.br
```

## 3. Conferir o `.env`

Já está preenchido:

```
DOMAIN=prisma-site.com.br
LETSENCRYPT_EMAIL=voce@seu-dominio.com
```

O e-mail é só pra onde o Let's Encrypt avisa se uma renovação falhar —
troque se preferir outro.

A `RESEND_API_KEY` (recuperação de senha) **não vem no repositório** e
existe só no `.env` da VM — ver a seção **E-mail / recuperação de
senha** mais abaixo.

## 4. Abrir as portas 80 e 443

No grupo de segurança / firewall da VM. A **80 não pode ser fechada nem
depois** que o HTTPS estiver funcionando: é por ela que o Let's Encrypt
valida o domínio, tanto na emissão quanto em toda renovação.

## 5. Subir tudo

```bash
cd prisma_server
docker compose up -d --build
```

Neste ponto o site e a API já respondem em `http://prisma-site.com.br`,
ainda sem HTTPS. Vale conferir agora, antes de mexer em certificado — se
algo estiver errado, é aqui que aparece:

```bash
curl -s http://localhost/version/public   # JSON, não HTML
curl -s -o /dev/null -w "%{http_code}" http://localhost/   # 200
```

Se `/version/public` devolver **HTML** em vez de JSON, o pedido caiu no
`location /` do site — é o sintoma de rota faltando em
`nginx/snippets/prisma-app.conf`.

## 6. Emitir o certificado (uma vez só)

```bash
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d prisma-site.com.br -d www.prisma-site.com.br -d admin.prisma-site.com.br \
  --email voce@seu-dominio.com \
  --agree-tos --no-eff-email
```

> **Teste antes, se estiver inseguro.** O Let's Encrypt limita a **5
> emissões por semana** pro mesmo conjunto de domínios, e estourar isso
> custa dias de espera. Acrescentar `--dry-run` ao comando faz o ensaio
> completo sem gastar cota; se ele passar, rode de novo sem a flag.

## 7. Ligar o HTTPS

```bash
cd nginx/templates
mv prisma.conf.template            prisma.conf.template.off
mv prisma-https.conf.template.off  prisma.conf.template
cd ../..
docker compose restart nginx
```

A ordem importa, e o motivo de serem dois arquivos é um ovo-e-galinha:
um `ssl_certificate` apontando pra arquivo inexistente faz o nginx **se
recusar a subir**; sem nginx no ar, o desafio do Let's Encrypt não é
respondido; sem o desafio, o certificado nunca é emitido. Por isso a
etapa 1 (só HTTP) existe e é a padrão.

A partir daí a renovação é automática — o serviço `certbot` checa a cada
12h, e o `nginx` recarrega a config a cada 24h pra pegar o certificado novo
em disco.

---

## Publicar uma versão nova do site

Só o passo 1. Não precisa mexer em certificado, DNS nem container.

## Verificar se está tudo de pé

```bash
docker compose ps
docker compose logs nginx --tail 50
docker compose logs certbot --tail 20

curl -I https://prisma-site.com.br                 # 200
curl -s https://prisma-site.com.br/version/public  # JSON com version/sha256
curl -sI https://prisma-site.com.br/downloads/Prisma-Setup.exe | head -3
```

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| nginx reiniciando em loop | `prisma-https` ativado sem o certificado existir (passo 7 antes do 6) |
| nginx sobe mas não serve nada, e o `${DOMAIN}` aparece cru na config | O `command:` do serviço começa com `/bin/sh` em vez de reinvocar o entrypoint. A imagem só processa os templates quando o primeiro argumento é `nginx` — ver o comentário grande acima do `command:` no `docker-compose.yml` |
| Certbot: "Timeout during connect" | Porta 80 fechada no firewall, ou DNS ainda não propagado |
| Site abre mas o botão baixa nada | `Prisma-Setup.exe` não foi copiado pra `downloads/` (ver RELEASE.md do app, passo 10) |
| Botão sem número de versão | `GET /version/public` falhou — o botão cai no link fixo de propósito, e o site continua funcionando; ver os logs do `prisma_server` |
| Download travado por vários segundos | `proxy_buffering off` foi removido do snippet — sem ele o nginx bufferiza os ~90 MB inteiros antes do primeiro byte |
| Certificado venceu mesmo com o certbot rodando | O `location /.well-known/acme-challenge/` foi movido pra depois do `return 301` no bloco da porta 80 |
| Uma rota da API devolve HTML | Falta o `location` dela em `nginx/snippets/prisma-app.conf` — cai no `location /` do site e volta o index.html com 200 |
| `curl localhost/login` dá 404 dentro da VM | O mount de `nginx/no-default.conf` sumiu: o `default.conf` da imagem casa `Host: localhost` exatamente e vence o `default_server` |
| Todo mundo tomando rate limit junto | Falta `app.set("trust proxy", 1)`, ou o `X-Forwarded-For` não está chegando (algum `location` de proxy sem o `include` de `proxy-headers.conf`) |
| Lista de salas para de atualizar depois de ~1min parado | `proxy_read_timeout` do `/ws/rooms` voltou ao padrão de 60s |
| E-mail de recuperação parou de chegar, sem erro nenhum | A `RESEND_API_KEY` da VM ficou velha ou vazia — quase sempre o rsync tendo levado um `.env` local desatualizado por cima. Conferir com `docker compose logs prisma_server | grep "[mail]"` |

---

## ⚠️ `trust proxy` e a porta 5000 andam juntos

Desde 2026-09-10 o `server.js` tem `app.set("trust proxy", 1)` e o
`prisma_server` **não publica mais a porta 5000**. As duas coisas são
uma só decisão e não podem ser separadas:

```
trust proxy ligado  +  porta 5000 publicada  =  buraco
```

Com a 5000 aberta dá pra ignorar o nginx, bater direto em
`http://IP:5000/login` e inventar o próprio `X-Forwarded-For`,
ganhando um balde de rate limit novo a cada requisição — o rate
limiting vira decoração. Sem o `trust proxy`, o Express vê o IP do
container do nginx como o IP de **todo mundo** e o primeiro excesso de
qualquer pessoa tranca o login de todos, sem nada anormal no log.

**Se um dia devolver a porta, tire o `trust proxy` no mesmo commit.**
O aviso está repetido no topo de `auth/rateLimit.js` e no
`docker-compose.yml`.

## ⚠️ Instalações antigas do app

Builds anteriores a 2026-09-10 apontam pra `http://SEU_IP_PUBLICO:5000`,
que deixa de responder. O endereço agora é **compilado no app**
(`src/main/config.ts`) — não existe mais `config.json` gravado pelo
instalador.

O instalador novo **apaga** o `config.json` que exista de uma
instalação anterior (seção `[InstallDelete]` do `prisma.iss`), então a
primeira atualização automática conserta a máquina sozinha. Quem
estiver numa build velha demais pra se atualizar precisa reinstalar.

---

## E-mail / recuperação de senha (configurado em 2026-10-01)

O servidor manda **um** e-mail hoje: o código de 6 dígitos da recuperação
de senha (`mail.js`). O provedor é o **Resend**, plano gratuito — pro
volume disto, grátis pra sempre.

### Os quatro registros no DNS

Ficam no **Cloudflare**, que é quem hospeda a zona do
`prisma-site.com.br`. Os três primeiros são obrigatórios; o DMARC é
opcional e foi adicionado junto.

| Tipo | Nome | Conteúdo | Pra quê |
|---|---|---|---|
| TXT | `resend._domainkey` | `p=MIGfMA0GCSqG…` (chave longa) | DKIM — assina as mensagens |
| CNAME | `rsend` | `rsend-sae1.forge.rmta.net` | SPF |
| CNAME | `send` | `send.forge.rmta.net` | SPF |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | DMARC |

⚠️ **Os dois CNAMEs têm que ficar em "DNS only"** (nuvem CINZA no
Cloudflare). CNAME nasce com o proxy LIGADO por padrão, e com a nuvem
laranja o Cloudflare responde o IP dele no lugar do destino real — o
Resend não valida e o envio não funciona.

⚠️ **`rsend` não é erro de digitação.** É sem o "e" mesmo, tanto no nome
quanto no começo do destino. Parece typo de "resend" e é fácil alguém
"corrigir" na hora de colar.

O `sae1` do primeiro CNAME é a REGIÃO (São Paulo), escolhida ao adicionar
o domínio no Resend. Um domínio criado em outra região tem outro nome
aqui — copie sempre os valores que o painel do Resend mostra, não os
desta tabela.

O valor do DKIM aparece **truncado** na tela do Resend (um `[...]` no
meio). Use o botão de copiar; digitar o que se vê não funciona.

Conferir a propagação (o Cloudflare costuma levar segundos):

```bash
nslookup -type=TXT   resend._domainkey.prisma-site.com.br 1.1.1.1
nslookup -type=CNAME rsend.prisma-site.com.br 1.1.1.1
nslookup -type=CNAME send.prisma-site.com.br 1.1.1.1
nslookup -type=TXT   _dmarc.prisma-site.com.br 1.1.1.1
```

### O `.env` da VM

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
MAIL_FROM=Prisma <nao-responda@prisma-site.com.br>
```

A chave é do tipo **Sending access** (não Full access): ela vive num
arquivo dentro da VM, e tudo que o `mail.js` faz é um `POST /emails`.
Com Full access, quem a pegasse apagaria o domínio e criaria outras
chaves.

**Sem aspas e sem espaço depois do `=`.** O `env_file` do Docker não é
shell: `RESEND_API_KEY="re_abc"` guarda as aspas dentro do valor, e o
Resend devolve 401.

O `MAIL_FROM` não precisa de caixa postal — é um endereço só de saída.
Mas precisa ser **do domínio verificado**, senão o Resend recusa.

🔑 **A chave está nos DOIS `.env`: o da VM e o deste repositório** — e
isso é proposital. O rsync do deploy copia o `.env` daqui por cima do de
lá; mantê-los iguais é o que impede um deploy de zerar a chave do
servidor. O arquivo está no `.gitignore`, então o segredo não chega ao
git.

> ⚠️ **Ao trocar a chave, troque nos dois lugares.** É a única forma de
> isso quebrar agora, e quebra em silêncio: se o `.env` daqui ficar com
> uma chave velha, o próximo rsync a leva pra VM, o envio para de
> funcionar sem erro nenhum e o código de recuperação volta a ser
> ESCRITO NO LOG — o cenário em que qualquer pessoa com acesso ao log
> troca a senha de qualquer conta.
>
> A alternativa, se um dia incomodar, é tirar o segredo do `.env`
> comum e pôr num `.env.secrets` que não viaja no rsync (o `env_file:`
> do Compose aceita uma lista, e o último ganha). Não foi feito porque
> hoje é um segredo só.

### Aplicar uma mudança no `.env`

```bash
docker compose up -d prisma_server
docker compose logs --tail=80 prisma_server | grep "\[mail\]"
```

⚠️ **`docker compose restart` NÃO serve.** O `env_file` é lido quando o
container é **criado**; um restart reaproveita o container existente e
ele volta com o valor antigo. Se o `up -d` responder `up-to-date` em vez
de `Recreated`, force com `--force-recreate`.

O botão **Docker** do painel de administração também resolve: ele roda
`docker compose up -d --build` (ver `ops/deploy.sh`), que recria o
container pela mudança de configuração. Mas o painel mostra só o log do
BUILD — a linha `[mail]` é do boot do servidor, e pra ela ainda é preciso
o SSH.

### Como saber qual driver está ativo

O boot diz, e é a única forma confiável:

| Linha no log | Significa |
|---|---|
| `[mail] Resend ativo, remetente: …` | ✅ mandando de verdade |
| `[mail] RESEND_API_KEY ausente — os e-mails serão ESCRITOS NO LOG` | modo de teste. **Nunca** deve ser isto em produção |

O modo de log não é preguiça: é o que deixou testar o fluxo inteiro antes
de existir domínio verificado. Mas em produção quem lê o log troca a
senha de qualquer conta.

### Diagnóstico quando o e-mail não chega

A rota `POST /password-reset/request` **sempre responde 204**, exista o
e-mail ou não — é de propósito, pra não virar um oráculo de "esta pessoa
tem conta aqui". Consequência prática: **o app diz "código enviado" mesmo
quando o envio falhou.** O log e o painel do Resend são os únicos lugares
onde a falha aparece.

```bash
docker compose logs -f prisma_server     # procurar "Falha ao enviar"
```

| Sintoma | Causa provável |
|---|---|
| `Resend respondeu 401` | chave errada — quase sempre aspas ou espaço no `.env` |
| `Resend respondeu 403` | a chave não cobre este domínio, ou o `MAIL_FROM` não é do domínio verificado |
| Nada no log e e-mail não chega | olhar o **dashboard do Resend → Emails**: ele mostra se foi aceito, entregue ou recusado pelo destinatário |
| Caiu em spam | normal nos primeiros envios de um domínio sem histórico. Marcar "não é spam" ajuda os próximos |

### Endurecer o DMARC depois

O `p=none` de hoje é **só monitoramento**: ele declara a política e não
bloqueia nada. Subir pra `p=quarantine` e depois `p=reject` é editar
aquele mesmo TXT.

Antes de subir, confirme que **nada mais manda e-mail como
`@prisma-site.com.br`** (formulário de contato em outro serviço,
newsletter, Email Routing do Cloudflare). Um remetente esquecido passa a
ter as mensagens descartadas em silêncio — é a pegadinha clássica do
DMARC, e o motivo de se começar no `none`.

---

## O APK do Android (2026-09-16)

O app Android é **só viewer** — quem transmite é sempre o Windows. O
site tem uma seção própria pra ele (`#android`) deixando isso explícito
em duas colunas ("o que o app faz" / "o que ele não faz"), porque quem
baixar esperando transmitir da TV vai concluir que o app está quebrado.

### Publicar uma versão

Na máquina de desenvolvimento, dentro do projeto Flutter:

```powershell
flutter build apk --release
.\publish-apk.ps1
```

O script lê a versão **de dentro do APK** (via `aapt2`), calcula o
SHA-256, copia o arquivo pra `downloads/Prisma.apk` e escreve
`downloads/android.json`. Versão digitada à mão foi descartada de
propósito: o erro (site anunciando 1.0.0 com um arquivo 1.0.1) não
dispara nada em lugar nenhum.

Depois, os dois arquivos vão pra VM na mão — `downloads/` fica **fora**
do rsync do deploy, porque tem quase 200 MB de binário:

```bash
scp downloads/Prisma.apk     usuario@IP:~/prisma_server/downloads/
scp downloads/android.json   usuario@IP:~/prisma_server/downloads/
```

Sem reiniciar nada: `downloads/` é bind mount e o endpoint lê o JSON a
cada chamada.

### Como isso é servido

| rota | o quê |
|---|---|
| `/downloads/Prisma.apk` | o arquivo — já funcionava, o `location /downloads/` cobre a pasta inteira |
| `/version/android/public` | versão, tamanho, SHA-256 — público, sem autenticação |

**Nada mudou no nginx**: `location /version` casa por prefixo, então
`/version/android/public` já entrava.

### Por que isso NÃO está no banco

A versão do Windows vive na tabela `app_version` porque o app instalado
a consulta pra se auto-atualizar — é contrato com software que já está
na máquina das pessoas. O Android **não tem auto-atualização**, então
esta informação tem um leitor só: a landing page, pra escrever "versão X
· Y MB" embaixo do botão. Tabela, migration e aba no painel seriam
maquinário pra um dado que ninguém além do site lê.

O dia em que o app Android ganhar auto-atualização, isto vira tabela. O
raciocínio inteiro está no cabeçalho do `androidRelease.js`.

### Conferir depois de subir

```bash
curl -s  https://prisma-site.com.br/version/android/public
curl -sI https://prisma-site.com.br/downloads/Prisma.apk | head -3
```

O primeiro devolve 404 enquanto o `android.json` não chegar — e isso é
esperado, não defeito: o site trata como "sem rótulo" e o botão cai num
link fixo pra `/downloads/Prisma.apk`. O download nunca depende dessa
chamada dar certo.
